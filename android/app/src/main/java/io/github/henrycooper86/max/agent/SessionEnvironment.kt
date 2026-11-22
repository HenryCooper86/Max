package io.github.henrycooper86.max.agent

import android.media.AudioManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class FocusGrant { GRANTED, DELAYED, FAILED }

/** The voice session's audio-focus request. [request] may be repeated; the change listener runs on the main thread. */
interface AudioFocusPort {
    fun request(onChange: (Int) -> Unit): FocusGrant
    fun abandon()
}

/** Headsets and other audio devices appearing or disappearing; callbacks on the main thread. */
interface AudioDeviceWatch {
    fun start(onChanged: () -> Unit)
    fun stop()
}

/**
 * The phone's default network. [start] reports the current one through
 * onAvailable, or onLost(null) when there is none; later handovers arrive as
 * onAvailable with a different id. Callbacks on the main thread.
 */
/**
 * Whether a phone call (ringing, active or being screened) has the audio,
 * independent of audio focus: once Max has yielded focus, a call sends it no
 * focus event. Changes arrive on the main thread.
 */
interface CallStateWatch {
    fun start(onCallChanged: (inCall: Boolean) -> Unit)
    fun stop()
    /** The current reading, for a capture error that may be the call arriving. */
    fun inCall(): Boolean
}

interface MediaPlaybackWatch {
    fun start(onOtherMediaStopped: () -> Unit)
    fun stop()
}

interface NetworkWatch {
    fun start(onAvailable: (Long) -> Unit, onLost: (Long?) -> Unit)
    fun stop()
}

/**
 * Relay reconnect budget. Only drops while a network is up count against it:
 * a tunnel or a dead zone must not use up the attempts and end hands-free,
 * and the network coming back (or changing) earns a fresh budget.
 */
class ReconnectPolicy(private val maxAttempts: Int = AgentSession.MAX_RECONNECT_ATTEMPTS) {
    sealed interface Decision {
        data class Retry(val attempt: Int, val delayMs: Long) : Decision
        data object WaitForNetwork : Decision
        data object GiveUp : Decision
    }

    // Read from OkHttp threads (socket drops) and the main thread (network callbacks).
    @get:Synchronized
    var attempts = 0
        private set
    private var online = true
    private var network: Long? = null

    @Synchronized
    fun reset() { attempts = 0; online = true; network = null }

    @Synchronized
    fun onConnected() { attempts = 0 }

    /** [keepTrying]: an active crash alarm must keep its link to the relay, slowly, forever. */
    @Synchronized
    fun onDrop(keepTrying: Boolean): Decision {
        if (!online) return Decision.WaitForNetwork
        attempts += 1
        if (attempts > maxAttempts && !keepTrying) {
            attempts = 0
            return Decision.GiveUp
        }
        val delayMs = if (attempts > maxAttempts) 30_000L else minOf(8_000L, 1_000L * (1L shl (attempts - 1)))
        return Decision.Retry(attempts, delayMs)
    }

    /** True when the session should reconnect now: back online, or moved to another network. */
    @Synchronized
    fun onNetworkAvailable(id: Long): Boolean {
        val previous = network
        val wasOffline = !online
        network = id
        online = true
        if (!wasOffline && (previous == null || previous == id)) return false
        attempts = 0
        return true
    }

    /** True when this loss takes the phone offline (not merely an old network after a handover). */
    @Synchronized
    fun onNetworkLost(id: Long?): Boolean {
        val current = network
        if (id != null && current != null && id != current) return false
        online = false
        return true
    }
}

/** What the session should do about an audio-focus event. */
enum class FocusAction { NONE, PAUSE, RESUME, RECLAIM, YIELD }

/** Why the session asks for focus: each kind reacts differently to the answer. */
enum class FocusRequestKind { START, RECLAIM, BORROW, RETAKE }

/**
 * Audio focus for a hands-free voice session that may last a whole ride.
 *
 * Focus never ends the session: capture does not need it, and ending hands-free
 * would also disarm crash detection.
 *
 * A transient loss (a phone call, another assistant) pauses capture and
 * playback until focus returns. A may-duck request (a navigation prompt) is
 * left alone and Max keeps listening; the platform does not lower Max's own
 * voice-communication speech for it, so the prompt plays over Max.
 *
 * A permanent loss usually means the rider started music, often by asking Max
 * or pressing the helmet's play button, so focus is reclaimed and the music
 * plays ducked under Max. Speech apps (podcasts, audiobooks) are not
 * auto-ducked: they pause instead, the rider presses play, and they take focus
 * back. After [maxReclaims] reclaims in [reclaimWindowMs], or a refused reclaim,
 * the session yields: it keeps listening without focus, tells the rider once,
 * and asks again only at natural points: to speak (borrowed for that reply and
 * handed back, so the other app resumes) and when the other app's playback stops.
 */
class VoiceFocusPolicy(
    private val clock: () -> Long,
    private val maxReclaims: Int = 3,
    private val reclaimWindowMs: Long = 60_000
) {
    var paused = false
        private set
    /** Running without focus because another app keeps it. */
    var yielded = false
        private set
    private var borrowed = false
    private var speakingAttempted = false
    private val reclaims = ArrayDeque<Long>()

    fun reset() {
        paused = false; yielded = false; borrowed = false; speakingAttempted = false
        reclaims.clear()
    }

    fun onRequest(grant: FocusGrant, kind: FocusRequestKind): FocusAction = when (grant) {
        FocusGrant.GRANTED -> {
            yielded = false
            borrowed = kind == FocusRequestKind.BORROW
            if (paused) { paused = false; FocusAction.RESUME } else FocusAction.NONE
        }
        // Delayed: a phone call holds focus; this request waits for it in the stack.
        FocusGrant.DELAYED -> {
            yielded = false
            borrowed = kind == FocusRequestKind.BORROW
            if (!paused) { paused = true; FocusAction.PAUSE } else FocusAction.NONE
        }
        FocusGrant.FAILED -> {
            yielded = true
            borrowed = false
            // Without focus there is no gain to wait for: a focus pause cannot outlive it.
            paused = false
            // At start a refusal keeps the pre-focus behaviour, quietly; a refused
            // reclaim is another app winning, which the rider is told about.
            if (kind == FocusRequestKind.RECLAIM) FocusAction.YIELD else FocusAction.NONE
        }
    }

    fun onChange(change: Int): FocusAction = when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> {
            yielded = false
            if (paused) { paused = false; FocusAction.RESUME } else FocusAction.NONE
        }
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ->
            if (!paused && !yielded) { paused = true; FocusAction.PAUSE } else FocusAction.NONE
        AudioManager.AUDIOFOCUS_LOSS -> when {
            // The other app took back what Max borrowed for a reply: no reclaim, no loop.
            borrowed -> { borrowed = false; yielded = true; paused = false; FocusAction.NONE }
            yielded -> FocusAction.NONE
            else -> {
                val now = clock()
                while (reclaims.isNotEmpty() && now - reclaims.first() >= reclaimWindowMs) reclaims.removeFirst()
                if (reclaims.size < maxReclaims) { reclaims.addLast(now); FocusAction.RECLAIM }
                else { yielded = true; paused = false; FocusAction.YIELD }
            }
        }
        else -> FocusAction.NONE
    }

    /** Max is about to speak: true when focus should be borrowed for the reply (once per reply). */
    fun wantsBorrow(): Boolean {
        if (!yielded || speakingAttempted) return false
        speakingAttempted = true
        return true
    }

    /** Max finished speaking: true when borrowed focus should be handed back now. */
    fun onQuiet(): Boolean {
        speakingAttempted = false
        if (!borrowed || paused) return false
        borrowed = false
        yielded = true
        return true
    }
}

/** How long after a network change an in-flight reply may go silent before its socket is replaced. */
const val RELAY_WATCHDOG_MS = 5_000L

/** Between attempts to bring back a microphone that stopped working. */
const val CAPTURE_RETRY_MS = 15_000L

/**
 * A restarted microphone counts as working only after this long without a new
 * capture error: AudioRecord starts without complaint on a blocked mic and only
 * the reads fail, about half a second later.
 */
const val CAPTURE_CONFIRM_MS = 2_000L

/** While a call is the reason for pausing, how often the audio mode is re-read in case its end went unreported. */
const val CALL_RECHECK_MS = 1_500L

/**
 * Keeps a hands-free session alive across what happens around it: audio focus,
 * phone calls, headsets connecting and dropping, network loss and handover, and
 * the capture errors those cause. Platform events arrive through small ports so
 * the transitions are tested on the JVM; the session supplies [Controls], which
 * deliberately has no way to end hands-free: nothing here may switch off crash
 * detection or the foreground service. Only the rider ends the session.
 *
 * Every method runs on the main thread (the Android ports deliver their
 * callbacks there and [scope] dispatches there), except [onRelayTraffic].
 */
class SessionEnvironment(
    private val focus: AudioFocusPort,
    private val devices: AudioDeviceWatch,
    private val network: NetworkWatch,
    private val controls: Controls,
    private val scope: CoroutineScope,
    private val clock: () -> Long,
    private val deviceDebounceMs: Long = 400,
    private val captureGraceMs: Long = 1_000,
    private val captureRecoveryWindowMs: Long = 3_000,
    private val media: MediaPlaybackWatch? = null,
    private val calls: CallStateWatch? = null
) {
    interface Controls {
        /** Stop capture and assistant audio but keep the relay session. */
        fun pauseAudio()
        /** Restart capture after [pauseAudio] ([rerouteAudio] has just run); false if the microphone would not start. */
        fun resumeAudio(): Boolean
        /** Cut assistant output while focus is reclaimed; capture continues. */
        fun silenceOutput()
        /** Another app keeps the audio; Max goes on listening without focus. Called once per session. */
        fun audioYielded()
        /** A relay socket exists (open or connecting); a network change leaves it to fail on its own. */
        val relayConnected: Boolean
        /** Re-run routing for the current devices, restarting capture if it runs and the route moved. */
        fun rerouteAudio()
        /** Stop and start capture; false if the microphone would not start. */
        fun restartCapture(): Boolean
        /** The microphone is gone: stop capture only and tell the rider once (crash detection stays on). */
        fun voiceCaptureLost()
        /** The microphone works again. */
        fun voiceCaptureRestored()
        /** Drop any backoff and connect to the relay now (called only with no socket). */
        fun reconnectNow()
        /** The phone has no network: stop counting down to a reconnect and say so. */
        fun waitForNetwork()
        /** The socket went silent mid-reply after a network change: replace it. */
        fun replaceSocket()
    }

    private enum class PauseReason { FOCUS, CALL }

    val reconnect = ReconnectPolicy()
    private val focusPolicy = VoiceFocusPolicy(clock)
    private var active = false
    private var debounceJob: Job? = null
    private var captureJob: Job? = null
    private var retryJob: Job? = null
    private var watchdogJob: Job? = null
    private var confirmJob: Job? = null
    private var callRecheckJob: Job? = null
    private var yieldNoticePending = false
    /** The relay said it is speaking, so its audio should be streaming; set from the socket reader thread. */
    @Volatile private var relaySpeaking = false
    private var lastDeviceEventAt: Long? = null
    private var recoveredSinceDeviceEvent = false
    private var yieldTold = false
    private val pauseReasons = mutableSetOf<PauseReason>()
    @Volatile private var lastRelayTrafficAt = Long.MIN_VALUE

    /** Capture and playback are paused for a phone call or another app's focus; one state, either reason. */
    val audioPaused: Boolean get() = pauseReasons.isNotEmpty()

    /** Listening without focus because another app keeps it. */
    val audioYielded: Boolean get() = focusPolicy.yielded

    /** The microphone stopped working; voice is off, the session and crash detection are not. */
    var voiceCaptureDown = false
        private set

    /** Max is about to speak (a reply or a safety warning). */
    fun onAssistantSpeaking() {
        if (active && focusPolicy.wantsBorrow()) request(FocusRequestKind.BORROW)
    }

    /** Max finished speaking: hand borrowed focus back so the other app resumes. */
    fun onAssistantQuiet() {
        if (active && focusPolicy.onQuiet()) runCatching { focus.abandon() }
    }

    /** Anything arrived from the relay. Safe from the socket's reader thread. */
    fun onRelayTraffic() {
        lastRelayTrafficAt = clock()
    }

    /**
     * A relay status event. Only the relay's own "speaking" means traffic must be
     * flowing; a local hazard warning also shows "speaking" on the HUD but sends
     * nothing over the socket, so it must never count. Safe from the reader thread.
     */
    fun onRelayStatus(state: String) {
        relaySpeaking = state == "speaking"
    }

    /** A socket opened, closed or was replaced: whatever the old one was doing is over. */
    fun onSocketChanged() {
        relaySpeaking = false
    }

    fun start() {
        if (active) return
        active = true
        reconnect.reset()
        focusPolicy.reset()
        pauseReasons.clear()
        voiceCaptureDown = false
        lastDeviceEventAt = null
        yieldTold = false
        yieldNoticePending = false
        relaySpeaking = false
        network.start(::onNetworkAvailable, ::onNetworkLost)
        devices.start(::onDevicesChanged)
        media?.start(::onOtherMediaStopped)
        calls?.start { inCall -> if (active) setPaused(PauseReason.CALL, inCall) }
        request(FocusRequestKind.START)
    }

    fun stop() {
        if (!active) return
        active = false
        listOf(debounceJob, captureJob, retryJob, watchdogJob, confirmJob, callRecheckJob).forEach { it?.cancel() }
        debounceJob = null; captureJob = null; retryJob = null; watchdogJob = null; confirmJob = null; callRecheckJob = null
        runCatching { focus.abandon() }
        runCatching { devices.stop() }
        runCatching { network.stop() }
        runCatching { media?.stop() }
        runCatching { calls?.stop() }
        focusPolicy.reset()
        pauseReasons.clear()
        voiceCaptureDown = false
    }

    /**
     * The microphone stopped on its own. Route changes and phone calls make
     * AudioRecord fail just before their own callbacks arrive, so wait briefly:
     * a call (by focus, by its listener, or by the audio mode right now) pauses
     * and its end restarts capture; a headset change gets one fresh capture;
     * anything else stops voice only and keeps retrying.
     */
    fun onCaptureFailed() {
        if (!active) return
        if (voiceCaptureDown) {
            // A restart that did not hold: the same episode goes on, silently.
            confirmJob?.cancel()
            return
        }
        if (captureJob?.isActive == true) return
        captureJob = scope.launch {
            delay(captureGraceMs)
            if (!active || audioPaused) return@launch
            if (runCatching { calls?.inCall() == true }.getOrDefault(false)) {
                setPaused(PauseReason.CALL, true)
                return@launch
            }
            val lastEvent = lastDeviceEventAt
            if (lastEvent != null && clock() - lastEvent <= captureRecoveryWindowMs && !recoveredSinceDeviceEvent) {
                recoveredSinceDeviceEvent = true
                if (controls.restartCapture()) return@launch
            }
            captureLost()
        }
    }

    /** Starting the microphone threw (session start, or after a call). */
    fun onCaptureStartFailed() {
        if (active) captureLost()
    }

    private fun captureLost() {
        if (!voiceCaptureDown) {
            voiceCaptureDown = true
            controls.voiceCaptureLost()
        }
        if (retryJob?.isActive == true) return
        retryJob = scope.launch {
            while (active && voiceCaptureDown) {
                delay(CAPTURE_RETRY_MS)
                if (active && voiceCaptureDown && !audioPaused && confirmJob?.isActive != true) tryRestoreCapture()
            }
        }
    }

    private fun tryRestoreCapture() {
        if (controls.restartCapture()) confirmRestore()
    }

    /** The episode ends only once the restarted microphone has kept running for [CAPTURE_CONFIRM_MS]. */
    private fun confirmRestore() {
        if (!voiceCaptureDown) return
        confirmJob?.cancel()
        confirmJob = scope.launch {
            delay(CAPTURE_CONFIRM_MS)
            if (!active || !voiceCaptureDown) return@launch
            voiceCaptureDown = false
            retryJob?.cancel(); retryJob = null
            controls.voiceCaptureRestored()
        }
    }

    private fun setPaused(reason: PauseReason, paused: Boolean) {
        val wasPaused = audioPaused
        if (paused) pauseReasons += reason else pauseReasons -= reason
        if (reason == PauseReason.CALL && paused) watchCallEnd()
        if (wasPaused == audioPaused) return
        // A capture error from before the pause belongs to the old capture; the
        // pause stops it and the resume starts a fresh one.
        captureJob?.cancel(); captureJob = null
        if (audioPaused) {
            confirmJob?.cancel()
            controls.pauseAudio()
        } else {
            // The call or the other app may have left another route behind.
            controls.rerouteAudio()
            if (controls.resumeAudio()) confirmRestore() else captureLost()
            tellYieldIfDue()
        }
    }

    /**
     * A call noticed by a direct read of the audio mode may end before the call
     * watch ever reports it (a poll between ticks, or a listener that saw no
     * change), so the mode is re-read until the call is over.
     */
    private fun watchCallEnd() {
        if (callRecheckJob?.isActive == true) return
        callRecheckJob = scope.launch {
            while (active && PauseReason.CALL in pauseReasons) {
                delay(CALL_RECHECK_MS)
                if (active && PauseReason.CALL in pauseReasons && runCatching { calls?.inCall() != true }.getOrDefault(true)) {
                    setPaused(PauseReason.CALL, false)
                }
            }
        }
    }

    /** The "another app is playing" notice waits until audio is not paused, so the rider can hear it. */
    private fun tellYieldIfDue() {
        if (!yieldNoticePending || audioPaused) return
        yieldNoticePending = false
        controls.audioYielded()
    }

    private fun onFocusChange(change: Int) {
        if (active) handle(focusPolicy.onChange(change))
    }

    private fun request(kind: FocusRequestKind) =
        // The same listener stays registered; a delayed grant arrives as GAIN.
        handle(focusPolicy.onRequest(focus.request(::onFocusChange), kind))

    private fun handle(action: FocusAction) {
        when (action) {
            FocusAction.RECLAIM -> {
                controls.silenceOutput()
                request(FocusRequestKind.RECLAIM)
            }
            FocusAction.YIELD -> if (!yieldTold) {
                yieldTold = true
                yieldNoticePending = true
            }
            else -> Unit
        }
        setPaused(PauseReason.FOCUS, focusPolicy.paused)
        tellYieldIfDue()
    }

    /** The other app's playback stopped: a natural point to hold focus again. */
    private fun onOtherMediaStopped() {
        if (active && focusPolicy.yielded) request(FocusRequestKind.RETAKE)
    }

    private fun onDevicesChanged() {
        if (!active) return
        lastDeviceEventAt = clock()
        recoveredSinceDeviceEvent = false
        // Bluetooth SCO connects as several add/remove callbacks within a few
        // hundred milliseconds; routing once the burst settles avoids flapping.
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(deviceDebounceMs)
            // During a call the route belongs to the call; the resume after it re-routes.
            if (!active || audioPaused) return@launch
            controls.rerouteAudio()
            if (voiceCaptureDown) tryRestoreCapture()
        }
    }

    /**
     * A new default network refills the retry budget. With no socket Max
     * reconnects at once. An open socket is kept: restarting it would cut the
     * current turn, and a network flapping between weak Wi-Fi and mobile data
     * would reconnect on every flap. A dead one usually fails at once (the
     * platform destroys sockets of a lost network); otherwise, mid-reply, the
     * relay going silent for [RELAY_WATCHDOG_MS] replaces it, and when idle the
     * socket's 20 s ping notices within 20 to 40 s: the relay has no message a
     * client can send to get an answer, so an idle socket cannot be checked sooner.
     */
    private fun onNetworkAvailable(id: Long) {
        if (!active || !reconnect.onNetworkAvailable(id)) return
        if (!controls.relayConnected) {
            controls.reconnectNow()
        } else if (relaySpeaking && watchdogJob?.isActive != true) {
            val armedAt = clock()
            watchdogJob = scope.launch {
                delay(RELAY_WATCHDOG_MS)
                if (active && controls.relayConnected && lastRelayTrafficAt < armedAt) controls.replaceSocket()
            }
        }
    }

    private fun onNetworkLost(id: Long?) {
        if (active && reconnect.onNetworkLost(id)) controls.waitForNetwork()
    }
}
