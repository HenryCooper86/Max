package io.github.henrycooper86.max.agent

import android.media.AudioManager
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeFocus : AudioFocusPort {
    var grants = ArrayDeque(listOf(FocusGrant.GRANTED))
    var listener: ((Int) -> Unit)? = null
    var requests = 0
    var abandons = 0
    override fun request(onChange: (Int) -> Unit): FocusGrant {
        requests++; listener = onChange
        return grants.removeFirstOrNull() ?: FocusGrant.GRANTED
    }
    override fun abandon() { abandons++; listener = null }
    fun change(code: Int) = listener!!.invoke(code)
}

private class FakeDevices : AudioDeviceWatch {
    var listener: (() -> Unit)? = null
    override fun start(onChanged: () -> Unit) { listener = onChanged }
    override fun stop() { listener = null }
    fun changed() = listener!!.invoke()
}

private class FakeNetwork : NetworkWatch {
    var available: ((Long) -> Unit)? = null
    var lost: ((Long?) -> Unit)? = null
    override fun start(onAvailable: (Long) -> Unit, onLost: (Long?) -> Unit) { available = onAvailable; lost = onLost }
    override fun stop() { available = null; lost = null }
}

private class FakeMedia : MediaPlaybackWatch {
    var listener: (() -> Unit)? = null
    override fun start(onOtherMediaStopped: () -> Unit) { listener = onOtherMediaStopped }
    override fun stop() { listener = null }
    fun stopped() = listener!!.invoke()
}

private class FakeCalls : CallStateWatch {
    var listener: ((Boolean) -> Unit)? = null
    var inCallMode = false
    override fun start(onCallChanged: (Boolean) -> Unit) { listener = onCallChanged }
    override fun stop() { listener = null }
    override fun inCall() = inCallMode
    fun call(active: Boolean) { inCallMode = active; listener!!.invoke(active) }
}

/** Everything the environment can ask of the session. There is deliberately no way to end it. */
private class RecordingControls : SessionEnvironment.Controls {
    val calls = mutableListOf<String>()
    override var relayConnected = false
    var captureWorks = true
    override fun pauseAudio() { calls += "pause" }
    override fun resumeAudio(): Boolean { calls += "resume"; return captureWorks }
    override fun silenceOutput() { calls += "silence" }
    override fun audioYielded() { calls += "yielded" }
    override fun rerouteAudio() { calls += "reroute" }
    override fun restartCapture(): Boolean { calls += "restartCapture"; return captureWorks }
    override fun voiceCaptureLost() { calls += "voiceLost" }
    override fun voiceCaptureRestored() { calls += "voiceRestored" }
    override fun reconnectNow() { calls += "reconnect" }
    override fun waitForNetwork() { calls += "offline" }
    override fun replaceSocket() { calls += "replaceSocket" }
}

@OptIn(ExperimentalCoroutinesApi::class)
class SessionEnvironmentTest {
    private val focus = FakeFocus()
    private val devices = FakeDevices()
    private val network = FakeNetwork()
    private val media = FakeMedia()
    private val phone = FakeCalls()
    private val controls = RecordingControls()

    private fun TestScope.environment() =
        SessionEnvironment(focus, devices, network, controls, this, clock = { testScheduler.currentTime }, media = media, calls = phone)

    /** Uses up the reclaim allowance the way a podcast app does: it takes focus back every time. */
    private fun TestScope.yieldTo(env: SessionEnvironment) {
        repeat(4) { focus.change(AudioManager.AUDIOFOCUS_LOSS); advanceTimeBy(1_000) }
        assertTrue(env.audioYielded)
    }

    // ---- audio focus ---------------------------------------------------------

    @Test
    fun `a phone call pauses the session and hanging up resumes it`() = runTest {
        val env = environment()
        env.start()
        assertFalse(env.audioPaused)

        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        assertTrue(env.audioPaused)
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) // repeated loss is one pause
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertFalse(env.audioPaused)
        focus.change(AudioManager.AUDIOFOCUS_GAIN) // already held: nothing to resume

        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a short navigation prompt only ducks Max, it never pauses listening`() = runTest {
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertTrue(controls.calls.isEmpty())
        assertFalse(env.audioPaused)
        env.stop()
    }

    @Test
    fun `starting during a call waits for the call to end`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.DELAYED))
        val env = environment()
        env.start()
        assertTrue(env.audioPaused)
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertFalse(env.audioPaused)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a refused first request keeps the session running as before`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.FAILED))
        val env = environment()
        env.start()
        assertFalse(env.audioPaused)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `music started by the rider is ducked under Max instead of ending the session`() = runTest {
        val env = environment()
        env.start()

        focus.change(AudioManager.AUDIOFOCUS_LOSS)

        assertEquals(listOf("silence"), controls.calls)
        assertEquals(2, focus.requests)
        assertFalse(env.audioPaused)
        env.stop()
    }

    @Test
    fun `losing focus during a call reclaims it for after the call`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.GRANTED, FocusGrant.DELAYED))
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertTrue(env.audioPaused)
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals(listOf("silence", "pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a podcast that keeps taking audio back is left alone, and the session stays up`() = runTest {
        val env = environment()
        env.start()
        repeat(3) { focus.change(AudioManager.AUDIOFOCUS_LOSS); advanceTimeBy(1_000) }
        assertEquals(listOf("silence", "silence", "silence"), controls.calls)

        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        // No more reclaiming: capture continues without focus and the rider is told once.
        assertEquals(listOf("silence", "silence", "silence", "yielded"), controls.calls)
        assertTrue(env.audioYielded)
        assertFalse(env.audioPaused)
        repeat(20) { focus.change(AudioManager.AUDIOFOCUS_LOSS); advanceTimeBy(500) }
        assertEquals("reclaims are bounded", 4, focus.requests)
        assertEquals(4, controls.calls.size)
        env.stop()
    }

    @Test
    fun `while yielded Max borrows focus to speak and hands it back`() = runTest {
        val env = environment()
        env.start()
        yieldTo(env)
        val before = focus.requests

        env.onAssistantSpeaking()
        env.onAssistantSpeaking() // still speaking: no second request
        assertEquals(before + 1, focus.requests)
        env.onAssistantQuiet()
        assertEquals(1, focus.abandons)

        // The podcast resumes and takes focus mid-reply: no reclaim, back to yielded.
        env.onAssistantSpeaking()
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertEquals(before + 2, focus.requests)
        assertTrue(env.audioYielded)
        assertEquals(1, controls.calls.count { it == "yielded" })
        env.stop()
    }

    @Test
    fun `speaking while Max holds focus asks for nothing`() = runTest {
        val env = environment()
        env.start()
        env.onAssistantSpeaking()
        env.onAssistantQuiet()
        assertEquals(1, focus.requests)
        assertEquals(0, focus.abandons)
        env.stop()
    }

    @Test
    fun `when the other app stops playing Max takes focus back once`() = runTest {
        val env = environment()
        env.start()
        yieldTo(env)
        val before = focus.requests
        media.stopped()
        assertEquals(before + 1, focus.requests)
        assertFalse(env.audioYielded)
        media.stopped() // already held
        assertEquals(before + 1, focus.requests)

        // The rider presses play again inside the reclaim window: yield without a loop or a second notice.
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertTrue(env.audioYielded)
        assertEquals(before + 1, focus.requests)
        assertEquals(1, controls.calls.count { it == "yielded" })
        env.stop()
    }

    @Test
    fun `reclaims spread over time do not add up to giving up`() = runTest {
        val env = environment()
        env.start()
        repeat(6) { focus.change(AudioManager.AUDIOFOCUS_LOSS); advanceTimeBy(61_000) }
        assertFalse("yielded" in controls.calls)
        assertEquals(7, focus.requests)
        env.stop()
    }

    @Test
    fun `a refused reclaim yields instead of ending the session`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.GRANTED, FocusGrant.FAILED))
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertEquals(listOf("silence", "yielded"), controls.calls)
        assertTrue(env.audioYielded)
        env.stop()
    }

    // ---- audio devices -------------------------------------------------------

    @Test
    fun `a burst of device callbacks re-routes once after it settles`() = runTest {
        val env = environment()
        env.start()
        repeat(5) { devices.changed(); advanceTimeBy(100) }
        assertTrue(controls.calls.isEmpty())
        advanceTimeBy(400)
        runCurrent()
        assertEquals(listOf("reroute"), controls.calls)
        env.stop()
    }

    @Test
    fun `a headset change during a phone call waits for the call to end`() = runTest {
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        devices.changed()
        advanceUntilIdle()
        // Resuming after the call re-routes; touching the route mid-call could move the call.
        assertEquals(listOf("pause"), controls.calls)
        env.stop()
    }

    @Test
    fun `a capture error right after a headset change restarts the mic`() = runTest {
        val env = environment()
        env.start()
        devices.changed()
        advanceTimeBy(200)
        env.onCaptureFailed()
        advanceUntilIdle()
        assertEquals(listOf("reroute", "restartCapture"), controls.calls)

        // One fast recovery per device event; after that the slow retries take over.
        controls.captureWorks = false
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertEquals("voiceLost", controls.calls.last())
        env.stop()
    }

    // ---- phone calls without focus ----------------------------------------

    @Test
    fun `a call while Max has yielded focus pauses and its end resumes with a re-route`() = runTest {
        val env = environment()
        env.start()
        yieldTo(env)
        controls.calls.clear()
        phone.call(true)
        assertTrue(env.audioPaused)
        phone.call(false)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a call while holding focus pauses once and resumes once, whichever signal comes first`() = runTest {
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        phone.call(true)
        phone.call(false) // the mode returns before focus does
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)

        controls.calls.clear()
        phone.call(true)
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        focus.change(AudioManager.AUDIOFOCUS_GAIN) // focus returns before the mode does
        assertTrue(env.audioPaused)
        phone.call(false)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a borrowed focus lost while waiting out a call resumes listening`() = runTest {
        val env = environment()
        env.start()
        yieldTo(env)
        controls.calls.clear()
        focus.grants = ArrayDeque(listOf(FocusGrant.DELAYED))
        env.onAssistantSpeaking() // borrow during a call: delayed
        assertTrue(env.audioPaused)
        focus.change(AudioManager.AUDIOFOCUS_LOSS) // another app got focus first
        assertFalse(env.audioPaused)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a borrowed focus lost during a known call waits for the call to end`() = runTest {
        val env = environment()
        env.start()
        yieldTo(env)
        controls.calls.clear()
        phone.call(true)
        focus.grants = ArrayDeque(listOf(FocusGrant.DELAYED))
        env.onAssistantSpeaking()
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertTrue(env.audioPaused)
        phone.call(false)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a capture error with a device change just after it is recovered too`() = runTest {
        val env = environment()
        env.start()
        env.onCaptureFailed()
        advanceTimeBy(300)
        devices.changed()
        advanceUntilIdle()
        assertTrue("restartCapture" in controls.calls)
        assertFalse("voiceLost" in controls.calls)
        env.stop()
    }

    @Test
    fun `a capture error caused by a call waits for the call instead of ending`() = runTest {
        val env = environment()
        env.start()
        env.onCaptureFailed()
        advanceTimeBy(300)
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        advanceUntilIdle()
        assertEquals(listOf("pause"), controls.calls)
        env.stop()
    }

    @Test
    fun `a dead microphone stops voice only and retries every 15 s without limit`() = runTest {
        val env = environment()
        env.start()
        controls.captureWorks = false
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertEquals(listOf("voiceLost"), controls.calls)
        assertTrue(env.voiceCaptureDown)

        advanceTimeBy(10 * 60_000L)
        assertEquals("one retry every 15 s for ten minutes", 40, controls.calls.count { it == "restartCapture" })
        assertEquals(1, controls.calls.count { it == "voiceLost" })

        controls.captureWorks = true
        advanceTimeBy(15_000 + CAPTURE_CONFIRM_MS)
        assertEquals("voiceRestored", controls.calls.last())
        assertFalse(env.voiceCaptureDown)
        val settled = controls.calls.size
        advanceTimeBy(60_000)
        assertEquals("retries stop once capture works", settled, controls.calls.size)
        env.stop()
    }

    @Test
    fun `a headset event retries a lost microphone at once`() = runTest {
        val env = environment()
        env.start()
        controls.captureWorks = false
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        controls.captureWorks = true
        devices.changed()
        advanceTimeBy(401 + CAPTURE_CONFIRM_MS)
        assertEquals(listOf("voiceLost", "reroute", "restartCapture", "voiceRestored"), controls.calls)
        env.stop()
    }

    @Test
    fun `a headset that dies mid-ride leaves the session and its retries running`() = runTest {
        val env = environment()
        env.start()
        devices.changed()
        controls.captureWorks = false
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertEquals(listOf("reroute", "restartCapture", "voiceLost"), controls.calls)
        env.stop()
    }

    @Test
    fun `a capture error while the phone is in a call counts as a call, not a failure`() = runTest {
        val env = environment()
        env.start()
        phone.inCallMode = true // the mode changed before any listener could report it
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertEquals(listOf("pause"), controls.calls)
        assertTrue(env.audioPaused)
        phone.call(false)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `a microphone that cannot restart after a call goes to the retries`() = runTest {
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        controls.captureWorks = false
        focus.change(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals(listOf("pause", "reroute", "resume", "voiceLost"), controls.calls)
        assertTrue(env.voiceCaptureDown)
        env.stop()
    }

    @Test
    fun `a blocked mic that starts and fails again is one episode with one notice and no resumed flicker`() = runTest {
        val env = environment()
        env.start()
        env.onCaptureFailed()
        controls.captureWorks = false
        advanceTimeBy(1_001)
        controls.captureWorks = true // start() succeeds, but the blocked mic dies half a second later
        // The episode began at t = 1 s; retries run every 15 s from there.
        for (cycle in 1..5) {
            val retryAt = 1_000 + cycle * CAPTURE_RETRY_MS
            advanceTimeBy(retryAt + 500 - testScheduler.currentTime)
            assertEquals("restartCapture", controls.calls.last())
            env.onCaptureFailed()
            assertTrue(env.voiceCaptureDown)
        }
        assertEquals(1, controls.calls.count { it == "voiceLost" })
        assertEquals(0, controls.calls.count { it == "voiceRestored" })

        // A restart that survives the confirmation window is a real restore.
        advanceTimeBy(CAPTURE_RETRY_MS)
        advanceTimeBy(CAPTURE_CONFIRM_MS + 1)
        assertEquals("voiceRestored", controls.calls.last())
        assertFalse(env.voiceCaptureDown)

        // A later, separate failure is a new episode and is spoken again.
        controls.captureWorks = false
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertEquals(2, controls.calls.count { it == "voiceLost" })
        env.stop()
    }

    @Test
    fun `a capture error swallowed by a quick pause and resume does not mark a working mic as lost`() = runTest {
        val env = environment()
        env.start()
        env.onCaptureFailed()
        advanceTimeBy(300)
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        advanceTimeBy(300)
        focus.change(AudioManager.AUDIOFOCUS_GAIN) // resume restarts capture successfully
        advanceTimeBy(5_000)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        assertFalse(env.voiceCaptureDown)
        env.stop()
    }

    @Test
    fun `a call seen only by the direct read is still noticed when it ends`() = runTest {
        val env = environment()
        env.start()
        phone.inCallMode = true
        env.onCaptureFailed()
        advanceTimeBy(1_001)
        assertTrue(env.audioPaused)
        phone.inCallMode = false // the call ended before any listener or poll saw it
        advanceTimeBy(CALL_RECHECK_MS + 1)
        assertFalse(env.audioPaused)
        assertEquals(listOf("pause", "reroute", "resume"), controls.calls)
        env.stop()
    }

    @Test
    fun `yielding while paused for focus tells the rider once the audio is back`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.GRANTED, FocusGrant.FAILED))
        val env = environment()
        env.start()
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        focus.change(AudioManager.AUDIOFOCUS_LOSS) // reclaim refused: yield
        assertEquals(listOf("pause", "silence", "reroute", "resume", "yielded"), controls.calls)
        env.stop()
    }

    @Test
    fun `yielding during a call tells the rider when the call ends`() = runTest {
        focus.grants = ArrayDeque(listOf(FocusGrant.GRANTED, FocusGrant.FAILED))
        val env = environment()
        env.start()
        phone.call(true)
        focus.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        focus.change(AudioManager.AUDIOFOCUS_LOSS)
        assertFalse("yielded" in controls.calls)
        phone.call(false)
        assertEquals(listOf("pause", "silence", "reroute", "resume", "yielded"), controls.calls)
        env.stop()
    }

    @Test
    fun `a capture that will not even start goes to the retries`() = runTest {
        val env = environment()
        env.start()
        env.onCaptureStartFailed()
        assertEquals(listOf("voiceLost"), controls.calls)
        advanceTimeBy(15_001 + CAPTURE_CONFIRM_MS)
        assertEquals(listOf("voiceLost", "restartCapture", "voiceRestored"), controls.calls)
        env.stop()
    }

    @Test
    fun `no capture failure sequence can end the session or disarm crash detection`() = runTest {
        // The Controls interface has no way to end hands-free; this drives every
        // capture-failure path at once and checks only voice-level calls come out.
        val env = environment()
        env.start()
        val voiceOnly = setOf("pause", "resume", "reroute", "restartCapture", "voiceLost", "voiceRestored")
        repeat(30) { round ->
            controls.captureWorks = round % 3 == 0
            if (round % 4 == 0) devices.changed()
            if (round % 5 == 0) phone.call(true)
            env.onCaptureFailed()
            if (round % 7 == 0) env.onCaptureStartFailed()
            advanceTimeBy(700)
            if (round % 5 == 0) phone.call(false)
            advanceTimeBy(9_000)
        }
        assertTrue(controls.calls.toSet().toString(), voiceOnly.containsAll(controls.calls.toSet()))
        env.stop()
    }

    // ---- network -------------------------------------------------------------

    @Test
    fun `the first network report is the baseline, not a reason to reconnect`() = runTest {
        val env = environment()
        env.start()
        network.available!!(100)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `mid-reply handover with relay traffic keeps the socket`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        env.onRelayStatus("speaking")
        network.available!!(100)
        network.available!!(200)
        advanceTimeBy(2_000)
        env.onRelayTraffic()
        advanceTimeBy(10_000)
        assertFalse("replaceSocket" in controls.calls)
        env.stop()
    }

    @Test
    fun `mid-reply handover with a silent socket replaces it after five seconds, once`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        env.onRelayStatus("speaking")
        network.available!!(100)
        network.available!!(200)
        network.available!!(100) // a flap while the watchdog runs does not add a second one
        advanceTimeBy(4_999)
        assertTrue(controls.calls.isEmpty())
        advanceTimeBy(2)
        assertEquals(listOf("replaceSocket"), controls.calls)
        advanceTimeBy(30_000)
        assertEquals(1, controls.calls.size)
        assertEquals(5_000L, RELAY_WATCHDOG_MS)
        env.stop()
    }

    @Test
    fun `a local hazard warning is not relay traffic - handover and silence keep the socket`() = runTest {
        // The hazard banner makes the HUD say "speaking", but nothing comes from the
        // relay; only the relay's own speaking status means its audio should be flowing.
        controls.relayConnected = true
        val env = environment()
        env.start()
        network.available!!(100)
        network.available!!(200)
        advanceTimeBy(10_000)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `the relay finishing its reply, or a new socket, ends the expectation of traffic`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        env.onRelayStatus("speaking")
        env.onRelayStatus("listening")
        network.available!!(100); network.available!!(200)
        advanceTimeBy(10_000)
        env.onRelayStatus("speaking")
        env.onSocketChanged()
        network.available!!(100)
        advanceTimeBy(10_000)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `an idle socket is left to the 20 s ping after a handover`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        network.available!!(100)
        network.available!!(200)
        advanceTimeBy(60_000)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `flapping mid-reply with healthy traffic never replaces the socket`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        env.onRelayStatus("speaking")
        repeat(20) {
            network.available!!(if (it % 2 == 0) 100 else 200)
            advanceTimeBy(1_000); env.onRelayTraffic()
            advanceTimeBy(1_000); env.onRelayTraffic()
        }
        advanceTimeBy(10_000)
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `a handover with a live socket keeps it and refills the budget`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        network.available!!(100)
        env.reconnect.onDrop(keepTrying = false)
        network.available!!(200)
        assertTrue(controls.calls.isEmpty())
        assertEquals(0, env.reconnect.attempts)
        env.stop()
    }

    @Test
    fun `flapping between wifi and mobile with a live socket never reconnects`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        repeat(10) { network.available!!(if (it % 2 == 0) 100 else 200) }
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `flapping with no socket reconnects once, then the new socket is left alone`() = runTest {
        val env = environment()
        env.start()
        network.available!!(100)
        network.available!!(200)
        assertEquals(listOf("reconnect"), controls.calls)
        controls.relayConnected = true // the reconnect opened a socket
        repeat(6) { network.available!!(if (it % 2 == 0) 100 else 200) }
        assertEquals(listOf("reconnect"), controls.calls)
        env.stop()
    }

    @Test
    fun `back online with the old socket still open does not restart it`() = runTest {
        controls.relayConnected = true
        val env = environment()
        env.start()
        network.available!!(100)
        network.lost!!(100)
        network.available!!(300)
        assertEquals(listOf("offline"), controls.calls)
        env.stop()
    }

    @Test
    fun `a wifi to mobile handover with no socket reconnects at once with a fresh retry budget`() = runTest {
        val env = environment()
        env.start()
        network.available!!(100)
        env.reconnect.onDrop(keepTrying = false)
        env.reconnect.onDrop(keepTrying = false)

        network.available!!(200)

        assertEquals(listOf("reconnect"), controls.calls)
        assertEquals(0, env.reconnect.attempts)
        env.stop()
    }

    @Test
    fun `while offline drops do not burn the retry budget and the return reconnects`() = runTest {
        val env = environment()
        env.start()
        network.available!!(100)
        network.lost!!(100)
        assertEquals(listOf("offline"), controls.calls)

        repeat(20) { assertEquals(ReconnectPolicy.Decision.WaitForNetwork, env.reconnect.onDrop(keepTrying = false)) }
        assertEquals(0, env.reconnect.attempts)

        network.available!!(300)
        assertEquals(listOf("offline", "reconnect"), controls.calls)
        assertEquals(ReconnectPolicy.Decision.Retry(1, 1_000), env.reconnect.onDrop(keepTrying = false))
        env.stop()
    }

    @Test
    fun `losing a network that is no longer the default changes nothing`() = runTest {
        val env = environment()
        env.start()
        network.available!!(100)
        network.available!!(200)
        network.lost!!(100)
        assertEquals(listOf("reconnect"), controls.calls)
        env.stop()
    }

    @Test
    fun `starting with no network waits for one`() = runTest {
        val env = environment()
        env.start()
        network.lost!!(null)
        assertEquals(ReconnectPolicy.Decision.WaitForNetwork, env.reconnect.onDrop(keepTrying = false))
        network.available!!(100)
        assertEquals(listOf("offline", "reconnect"), controls.calls)
        env.stop()
    }

    // ---- lifecycle -----------------------------------------------------------

    @Test
    fun `stop releases focus and every callback, and late events are ignored`() = runTest {
        val env = environment()
        env.start()
        val focusListener = focus.listener!!
        val deviceListener = devices.listener!!
        val networkListener = network.available!!
        devices.changed()

        env.stop()

        assertEquals(1, focus.abandons)
        assertEquals(null, devices.listener)
        assertEquals(null, network.available)
        assertEquals(null, media.listener)
        assertEquals(null, phone.listener)
        // Callbacks already queued on the main thread when stop() ran.
        focusListener(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        deviceListener()
        networkListener(100); networkListener(200)
        env.onCaptureFailed()
        advanceUntilIdle()
        assertTrue(controls.calls.isEmpty())
        env.stop()
    }

    @Test
    fun `stop is safe to repeat and a new start registers again`() = runTest {
        val env = environment()
        env.stop()
        env.start()
        env.stop()
        env.stop()
        env.start()
        assertEquals(2, focus.requests)
        assertEquals(1, focus.abandons)
        assertTrue(devices.listener != null)
        env.stop()
    }
}

class ReconnectPolicyTest {
    @Test
    fun `backoff doubles to a cap and gives up after the budget`() {
        val policy = ReconnectPolicy(maxAttempts = 6)
        val delays = (1..6).map { (policy.onDrop(keepTrying = false) as ReconnectPolicy.Decision.Retry).delayMs }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L), delays)
        assertEquals(ReconnectPolicy.Decision.GiveUp, policy.onDrop(keepTrying = false))
        assertEquals(0, policy.attempts)
    }

    @Test
    fun `an active crash alarm keeps retrying slowly`() {
        val policy = ReconnectPolicy(maxAttempts = 2)
        policy.onDrop(keepTrying = true); policy.onDrop(keepTrying = true)
        assertEquals(ReconnectPolicy.Decision.Retry(3, 30_000), policy.onDrop(keepTrying = true))
    }

    @Test
    fun `a successful connection refills the budget`() {
        val policy = ReconnectPolicy()
        policy.onDrop(keepTrying = false); policy.onDrop(keepTrying = false)
        policy.onConnected()
        assertEquals(ReconnectPolicy.Decision.Retry(1, 1_000), policy.onDrop(keepTrying = false))
    }
}
