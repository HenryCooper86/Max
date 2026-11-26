package io.github.henrycooper86.max.agent

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.henrycooper86.max.installAndroidKeyStoreStandIn
import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The conversation lifecycle as a real [AgentSession] sees it through its own OkHttp transport
 * (docs/protocol.md, Resuming, session.ended, agent.changed, Versions and Wearable extensions).
 * Robolectric stands in for Android and an injected capture runs nothing, so no microphone,
 * speaker or relay account is involved: the relay is a loopback one that speaks the protocol.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class AgentSessionRelayLifecycleTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var relay: LoopbackRelay
    private lateinit var session: AgentSession

    @Before
    fun startRelay() {
        relay = LoopbackRelay()
        // AgentSession builds the HUD cast client, which keeps its token in the Android Keystore.
        installAndroidKeyStoreStandIn()
        session = newSession()
    }

    @After
    fun stopEverything() {
        session.stop()
        await("hands-free to end") { !session.state.value.handsFree }
        scope.cancel()
        relay.close()
        Localization.forTest(AppLanguage.ZH)
    }

    /** Robolectric's main looper runs what is posted to it only when idled: the session's
     *  main-thread work needs that while the test waits for the relay. */
    private fun await(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("timed out waiting for $what", condition())
    }

    /** A capture that runs nothing: the relay transport is what these tests exercise. */
    private class NoCapture : PcmCapture {
        override fun start() = Unit
        override fun stop() = Unit
    }

    /** Hands-free against the relay, started and left waiting for its session.start to be answered. */
    private fun newSession(): AgentSession = AgentSession(
        ApplicationProvider.getApplicationContext<Context>(),
        scope,
        captureFactory = { _, _, _ -> NoCapture() }
    ).also { it.start(relay.agentUrl, allowSelfSignedTls = false) }

    /** Waits for the `n`th session.start and answers it. */
    private fun answerSessionStart(number: Int, event: String) {
        await("session.start #$number") { relay.sessionStarts().size >= number }
        relay.current!!.send(event)
        await("session #$number to be ready") { session.state.value.connection == ConnectionState.READY }
    }

    private fun restartHandsFree() {
        session.stop()
        await("hands-free to end") { !session.state.value.handsFree }
        session.start(relay.agentUrl, allowSelfSignedTls = false)
    }

    @Test
    fun `a reconnect resumes the conversation and a new session does not`() {
        answerSessionStart(1, LoopbackRelay.sessionStarted(resume = "rsm_first"))
        assertFalse("a new conversation leaves the id out", relay.sessionStarts()[0].has("resume"))

        // The link drops: the reconnect carries the conversation on instead of greeting again.
        relay.current!!.drop()
        answerSessionStart(2, LoopbackRelay.sessionStarted(resume = "rsm_second"))
        assertEquals("rsm_first", relay.sessionStarts()[1].getString("resume"))

        // The relay answers with a new id; a later reconnect sends that one.
        relay.current!!.drop()
        answerSessionStart(3, LoopbackRelay.sessionStarted(resume = "rsm_third"))
        assertEquals("rsm_second", relay.sessionStarts()[2].getString("resume"))
        assertEquals("each drop costs one reconnect", 3, relay.connectionCount)

        // The rider ended hands-free: the next session is a new conversation.
        restartHandsFree()
        await("the new session's session.start") { relay.sessionStarts().size >= 4 }
        assertFalse("hands-free ended for good, so nothing is resumed", relay.sessionStarts()[3].has("resume"))
    }

    @Test
    fun `final closes end the conversation for good`() {
        // 4001 idle, 4003 voice minutes used up, 1008 credentials refused (docs/protocol.md, Close codes).
        val closes = listOf(
            Triple(4001, Str.STATUS_IDLE_ENDED, false),
            Triple(4003, Str.STATUS_MINUTES_USED_UP, false),
            Triple(1008, Str.STATUS_SIGN_IN_AGAIN, true)
        )
        closes.forEachIndexed { index, (code, status, signIn) ->
            answerSessionStart(index + 1, LoopbackRelay.sessionStarted(resume = "rsm_$code"))
            relay.current!!.close(code)
            await("hands-free to end after $code") { !session.state.value.handsFree }
            assertEquals(tr(status), session.state.value.statusText)
            assertEquals(signIn, session.state.value.authRequired)
            // Past the first reconnect backoff (1 s): a final close is not retried.
            Thread.sleep(1_500)
            assertEquals("a final close must not be retried", index + 1, relay.connectionCount)

            restartHandsFree()
            await("the next session's session.start") { relay.sessionStarts().size >= index + 2 }
            assertFalse("close $code ended the conversation", relay.sessionStarts()[index + 1].has("resume"))
        }
    }

    @Test
    fun `the relay ending the conversation ends hands-free with its reason`() {
        answerSessionStart(1, LoopbackRelay.sessionStarted())
        // Right after the event the relay closes with 4001 and the reason.
        relay.current!!.send("""{"type":"session.ended","reason":"max_duration"}""")
        relay.current!!.close(4001, "max_duration")
        await("hands-free to end") { !session.state.value.handsFree }
        assertEquals("对话已到最长时长，请重新开启免提", session.state.value.statusText)
        assertEquals("a conversation the relay ended is not a failure", ConnectionState.OFFLINE, session.state.value.connection)

        // The close behind the event is not a second end: the reason stays and nothing reconnects.
        Thread.sleep(1_500)
        assertEquals("对话已到最长时长，请重新开启免提", session.state.value.statusText)
        assertEquals(1, relay.connectionCount)
    }

    @Test
    fun `a handover to another agent is shown on the status line`() {
        answerSessionStart(1, LoopbackRelay.sessionStarted())
        relay.current!!.send("""{"type":"agent.changed","agent":"billing"}""")
        await("the handover to be shown") { session.state.value.statusText == "已切换到助手：billing" }
    }

    @Test
    fun `a newer relay is warned about once per hands-free session`() {
        answerSessionStart(1, LoopbackRelay.sessionStarted(protocol = 2))
        val warning = "中继协议版本较新（2），本应用支持 1，请更新应用"
        assertEquals("the warning is on the status line", warning, session.state.value.statusText)

        // A reconnect to the same newer relay does not say it again.
        relay.current!!.drop()
        answerSessionStart(2, LoopbackRelay.sessionStarted(protocol = 2))
        assertEquals(tr(Str.STATUS_MOCK_ON), session.state.value.statusText)

        // Nor does a relay that is not ahead, or one too old to say.
        relay.current!!.drop()
        answerSessionStart(3, LoopbackRelay.sessionStarted(protocol = 1))
        assertEquals(tr(Str.STATUS_MOCK_ON), session.state.value.statusText)
        relay.current!!.drop()
        answerSessionStart(4, LoopbackRelay.sessionStarted(protocol = null))
        assertEquals(tr(Str.STATUS_MOCK_ON), session.state.value.statusText)
    }

    @Test
    fun `the newer-relay warning lands with the ready state, not after it`() {
        // Unconfined, so every state is seen as it is set: a reader that stops at READY must not
        // have to look again for the warning.
        val readyStates = CopyOnWriteArrayList<AgentSession.State>()
        val collector = CoroutineScope(Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
            session.state.collect { if (it.connection == ConnectionState.READY) readyStates.add(it) }
        }
        try {
            answerSessionStart(1, LoopbackRelay.sessionStarted(protocol = 2))
            assertEquals("the first ready state already says it", "中继协议版本较新（2），本应用支持 1，请更新应用", readyStates.first().statusText)
        } finally {
            collector.cancel()
        }
    }

    @Test
    fun `a resume id left over from an ended session is never sent by the next one`() {
        answerSessionStart(1, LoopbackRelay.sessionStarted(resume = "rsm_first"))
        session.stop()
        await("hands-free to end") { !session.state.value.handsFree }
        // A session.started can be in flight while stop() runs on another thread: the relay's
        // answer lands after the id was cleared and before the socket is retired. Seed that leftover.
        AgentSession::class.java.getDeclaredField("resumeId").apply { isAccessible = true }.set(session, "rsm_stale")

        session.start(relay.agentUrl, allowSelfSignedTls = false)
        await("the next session's session.start") { relay.sessionStarts().size >= 2 }
        assertFalse("a new conversation never resumes one that ended", relay.sessionStarts()[1].has("resume"))
    }
}
