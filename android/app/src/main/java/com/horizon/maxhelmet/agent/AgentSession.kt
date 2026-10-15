package com.horizon.maxhelmet.agent

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.speech.tts.TextToSpeech
import android.util.Log
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.actions.DeviceActions
import com.horizon.maxhelmet.capture.CameraController
import com.horizon.maxhelmet.capture.CaptureStore
import com.horizon.maxhelmet.music.MusicController
import com.horizon.maxhelmet.navigation.LocationManagerSource
import com.horizon.maxhelmet.navigation.NavGuidanceState
import com.horizon.maxhelmet.navigation.NavSpeaker
import com.horizon.maxhelmet.navigation.NavigationController
import com.horizon.maxhelmet.navigation.RelayNavigationSearch
import com.horizon.maxhelmet.service.VoiceAgentService
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Owns one hands-free voice session end to end: relay WebSocket, mic streaming,
 * voice playback, Bluetooth routing, TTS fallback, and the HUD state. This is
 * the Android counterpart of the useHelmetAgent hook in src/main.tsx.
 */
class AgentSession(
    private val context: Context,
    private val scope: CoroutineScope,
    /** Debug-only PCM capture factory for native synthetic integration tests. */
    captureFactory: (((ByteArray) -> Unit, (Float) -> Unit, () -> Unit) -> PcmCapture)? = null
) : NavSpeaker {

    data class State(
        val handsFree: Boolean = false,
        val connection: ConnectionState = ConnectionState.OFFLINE,
        val statusText: String = "离线",
        val provider: String = "",
        val isLive: Boolean = false,
        /** Provider capabilities advertised by session.started (mirror of
         *  ProviderCapabilities in shared/agent.ts). Defaults match the web's
         *  DEFAULT_CAPABILITIES (all off) until the relay reports the real set. */
        val capabilities: ProviderCapabilities = ProviderCapabilities(),
        val turnState: TurnState = TurnState.IDLE,
        /**
         * Mic muted mid-session: the relay stays open and Max can keep speaking,
         * but rider audio frames are withheld (ChatGPT-style mute).
         */
        val micMuted: Boolean = false,
        val voiceGender: VoiceGender = VoiceGender.FEMALE,
        val voicePersonality: VoicePersonality = VoicePersonality.CONCISE,
        val voiceLevel: Float = 0f,
        val latencyMs: Int = 0,
        val transcript: List<TranscriptItem> = emptyList(),
        val weather: Weather? = null,
        val rideContext: RideContext = RideContext(),
        val hasRideContext: Boolean = false,
        val sessionMemory: SessionMemory = SessionMemory(),
        val telemetry: Telemetry? = null,
        val bluetoothRouted: Boolean = false,
        /** The active ADAS hazard alert, shown as a banner until it auto-clears. */
        val hazardAlert: AgentEvent.HazardAlert? = null,
        /** NavigationController's published turn-by-turn state, rendered as the
         *  guidance card. Null whenever no navigation session is running —
         *  including at arrival, which publishes null rather than a terminal
         *  "arrived" guidance value (see NavGuidanceState's doc). */
        val navGuidance: NavGuidanceState? = null,
        /** Guided demo ride: the mock provider auto-tours the scenario catalog. */
        val guidedDemo: Boolean = false,
        /** The relay refused the connection with HTTP 401 — a login (or token)
         *  is required. The UI opens the account settings when this flips on. */
        val authRequired: Boolean = false,
        /** Transcript ids above this floor belong to the CURRENT relay session
         *  and may be flagged via turn.feedback (the relay matches inside its
         *  live session transcript, so a restored/previous-session turn could
         *  tag the wrong turn). MAX_VALUE = nothing flaggable (offline). */
        val feedbackFloorId: Int = Int.MAX_VALUE
    ) {
        /** 态势摘要 fusion: ride hazard + weather risk (fusedHazard in src/main.tsx). */
        val fusedHazard: HazardLevel
            get() = combineHazardLevels(rideContext.hazardLevel, weather?.riskLevel ?: HazardLevel.NORMAL)

        /** Whether the flag control should show for a transcript item at all
         *  (mirrors canFlagTurn in useHelmetAgent.ts). The connection check
         *  covers every disconnect path without each one resetting the floor. */
        fun canFlagTurn(item: TranscriptItem): Boolean {
            val live = connection == ConnectionState.RELAY ||
                connection == ConnectionState.PROVIDER ||
                connection == ConnectionState.READY
            return live && item.final && item.turnId != null && item.feedback == null && item.id > feedbackFloorId
        }
    }

    companion object {
        private const val TAG = "AgentSession"

        /** Mirrors MAX_RECONNECT_ATTEMPTS in src/main.tsx. */
        const val MAX_RECONNECT_ATTEMPTS = 6

        /** Mirrors IDLE_CLOSE_CODE in shared/agent.ts: the relay closed this idle
         * session to free its upstream slot; auto-reconnecting would defeat it. */
        const val IDLE_CLOSE_CODE = 4001

        /** Repeated agent lines inside this window are dropped (src/main.tsx). */

        /** Same prefs file the HUD settings use (MainViewModel.PREFS). */
        private const val PREFS = "max_helmet"
        private const val LEGACY_KEY_TRANSCRIPT_LOG = "transcript_log"
        private const val KEY_TRANSCRIPT_PREFIX = "transcript_log_v2_"

        /** Keep the stored conversation bounded (TRANSCRIPT_CAP in src/lib/persistence.ts). */
        private const val TRANSCRIPT_CAP = 200
        private const val MAX_MIC_QUEUE_BYTES = 256L * 1024L
    }

    private val syntheticCapture = BuildConfig.DEBUG && captureFactory != null
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var httpClient: OkHttpClient = buildHttpClient(allowSelfSigned = false)
    private var allowSelfSigned = false

    // @Volatile: read from the mic capture thread (onFrame), written on OkHttp
    // listener threads and coroutine dispatchers.
    @Volatile
    private var webSocket: WebSocket? = null

    /** The socket already routed through handleSocketClosed, so a server-initiated
     * close that fires both onClosing (when we complete the handshake) and a later
     * onClosed for the same socket is processed exactly once. */
    private var closedSocket: WebSocket? = null

    /** True only after session.started confirms the upstream provider is ready.
     * The relay transport opening alone is not provider readiness. */
    @Volatile
    private var socketOpen = false

    private var relayUrl: String = ""
    private var testerId: String = ""
    private var testingCampaignId: String = "release-readiness"
    private var testingTestCaseId: String = "baseline-live-session"
    private var testingRunId: String = ""
    private var testingAssignmentId: String = ""
    private var reconnectAttempts = 0
    private var reconnectJob: Job? = null
    /** The 150 ms deferred reconnect of a settings-change restart, so stop()
     * can cancel it — otherwise it would resurrect the session (and clobber
     * intentionalClose) after the rider ended hands-free inside that window. */
    private var restartJob: Job? = null
    /** Pure generation gate for async location/microphone startup. */
    private val lifecycle = SessionLifecycle()
    /** Bumped on each hazard alert so a stale auto-clear can't dismiss a newer one. */
    private var hazardAlertGeneration = 0

    @Volatile
    private var intentionalClose = false

    @Volatile
    private var transmitting = false

    /** Plain mirror of `state.micMuted`, read off the audio thread alongside
     * `transmitting` so the mic callback never touches the StateFlow. */
    @Volatile
    private var micMuted = false

    private var transcriptTurn = 0
    private var transcriptOwnerId: String? = null
    @Volatile private var location: Pair<Double, Double>? = null
    @Volatile private var lastLocationFixAt = Long.MIN_VALUE / 2
    private val sessionLocation = LocationManagerSource(context)
    private var lastLocationSentAt = Long.MIN_VALUE / 2
    /** Relay-issued speech deliveries already handed to device TTS. */
    private val spokenDeliveryIds = linkedSetOf<String>()

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** (count, last id) of the final turns last written, so partial updates skip the disk. */
    private var persistedTranscriptSignature: Pair<Int, Int>? = null

    private val player = PcmPlayer()

    /** Opt-in observations for synthetic diagnostics; no payload text or credentials. */
    var syntheticPipelineObserver: ((String, Int) -> Unit)? = null
        set(value) {
            check(BuildConfig.DEBUG && syntheticCapture)
            field = value
            player.syntheticPipelineObserver = value
        }

    private fun observePipeline(stage: String, value: Int = 0) {
        if (syntheticCapture) syntheticPipelineObserver?.invoke(stage, value)
    }

    private fun pipelineEventName(event: AgentEvent): String = when (event) {
        is AgentEvent.Status -> when (event.detail) {
            "豆包语音识别完成" -> "asr-complete"
            "已收到豆包语音音频" -> "first-pcm-status"
            "豆包回复已完成" -> "provider-complete"
            else -> "Status:${event.state}"
        }
        is AgentEvent.Transcript -> "Transcript:${event.speaker.wire}:${event.final}"
        else -> event.javaClass.simpleName
    }
    private val deviceScope = CoroutineScope(scope.coroutineContext + Dispatchers.Main.immediate)
    private var stopAfterIncident = false
    val crash by lazy {
        com.horizon.maxhelmet.crash.CrashRuntime(context, deviceScope,
            speed = { state.value.rideContext.speedKmh.toDouble().takeIf { state.value.hasRideContext } },
            locate = { resolveCrashLocation() },
            speak = { text -> stopAgentSpeech(); if (music.state.value.playing) music.stopPlayback(); ttsSpeak(text) },
            send = { text -> if (socketOpen) webSocket?.send(text); Unit },
            resolved = { if (stopAfterIncident || !state.value.handsFree) { stopAfterIncident = false; stop(force = true) } })
    }
    fun detachCrashAccount() { deviceScope.launch { crash.controller.detachAccount(); stop(force = true) } }
    val music = MusicController(context, deviceScope)
    val captures = CaptureStore(context)
    val camera = CameraController(context, captures, deviceScope)
    val deviceActions = DeviceActions(context, player, music, camera,
        speed = { state.value.rideContext.speedKmh.toDouble().takeIf { state.value.hasRideContext } })
    private val deviceCommandIds = linkedSetOf<String>()
    private val deviceJobs = mutableSetOf<Job>()
    private val audioRouter = AudioRouter(context)
    private val mic: PcmCapture = (captureFactory?.also {
        require(BuildConfig.DEBUG) { "Injected capture is restricted to debug builds" }
    } ?: { frame, level, error -> MicStreamer(frame, level, error) })(
        { frame ->
            val socket = webSocket
            if (
                transmitting && !micMuted && socketOpen &&
                socket != null && socket.queueSize() + frame.size < MAX_MIC_QUEUE_BYTES
            ) {
                observePipeline("capture.frame.send.begin", frame.size)
                if (syntheticPipelineObserver != null) observePipeline("capture.socket.queue.bytes", socket.queueSize().toInt())
                val accepted = socket.send(frame.toByteString())
                observePipeline("capture.frame.send.end", if (accepted) frame.size else 0)
            }
        },
        { level -> _state.update { it.copy(voiceLevel = if (transmitting && !micMuted) level else 0f) } },
        {
            // Capture died on its own (dead mic / unrecoverable read error).
            // Marshal off the capture thread and end hands-free — leaving the HUD
            // pulsing "listening" behind a mic that will never emit another frame
            // is worse than stopping and letting the rider restart (mirrors the
            // web/iOS mic-failure handling). stop() releases the AudioRecord and
            // effects, and its lifecycle guard makes a late signal a no-op.
            scope.launch {
                if (!_state.value.handsFree) return@launch
                stop()
                _state.update {
                    it.copy(connection = ConnectionState.DEGRADED, statusText = "麦克风已中断，请重新开启免提")
                }
            }
        }
    )

    // ---- navigation ---------------------------------------------------------

    val hudCast = com.horizon.maxhelmet.navigation.HudCastClient(context)

    /** Relay-backed route search: turns navigation.start/reroute into a
     *  nav.request over the same socket, matched back through handleEvent's
     *  NavRoute/NavError forwarding. */
    private val navSearch = RelayNavigationSearch(send = { webSocket?.send(it) })

    /** Long-lived, constructed once — never rebuilt per hands-free cycle.
     *  teardown() (called from stop()) is what resets it between sessions;
     *  see NavigationController's class doc for why re-construction here
     *  would be wrong. */
    private val navController = NavigationController(
        search = navSearch,
        locationSource = LocationManagerSource(context),
        speaker = this,
        sendResult = { webSocket?.send(it) },
        onGuidance = { guidance ->
            hudCast.update(guidance)
            _state.update { it.copy(navGuidance = guidance) }
        },
        hasLocationPermission = ::hasFineLocationPermission,
        sendRelayPrompt = { webSocket?.send(it) }
    )

    fun confirmNavigation(id: String, accepted: Boolean) { navController.confirmDestination(id, accepted) }

    // Device-TTS fallback, the counterpart of the browser speechSynthesis path:
    // speaks agent reply text when there is no synthesized audio (always the
    // case for the mock provider).
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    init {
        tts = TextToSpeech(context) { status -> ttsReady = status == TextToSpeech.SUCCESS }
        // The legacy cache was device-global and cannot be assigned safely to
        // whichever account logs in first after an upgrade.
        prefs.edit().remove(LEGACY_KEY_TRANSCRIPT_LOG).apply()
    }

    // ---- public API --------------------------------------------------------

    /**
     * Activates hands-free: route audio, resolve location, open the relay, and
     * start the mic. `allowSelfSignedTls` opts into trusting the test server's
     * self-signed certificate for wss:// URLs. A non-empty `authToken` is sent
     * as the relay's `token` query parameter (server/auth.ts).
     */
    fun start(
        url: String,
        allowSelfSignedTls: Boolean,
        authToken: String = "",
        testerId: String = "",
        testingCampaignId: String = "release-readiness",
        testingTestCaseId: String = "baseline-live-session",
        testingRunId: String = "",
        testingAssignmentId: String = ""
    ) {
        val generation = lifecycle.begin() ?: return
        relayUrl = appendAuthToken(url, authToken)
        this.testerId = testerId.trim()
        this.testingCampaignId = testingCampaignId.trim().take(80)
        this.testingTestCaseId = testingTestCaseId.trim().take(80)
        this.testingRunId = testingRunId.trim().take(80)
        this.testingAssignmentId = testingAssignmentId.trim().take(80)

        if (allowSelfSignedTls != allowSelfSigned) {
            allowSelfSigned = allowSelfSignedTls
            httpClient = buildHttpClient(allowSelfSigned)
        }

        stopAfterIncident = false
        if (!syntheticCapture) crash.arm()
        intentionalClose = false
        reconnectAttempts = 0
        transmitting = true
        micMuted = false
        spokenDeliveryIds.clear()
        deviceScope.launch { deviceCommandIds.clear() }

        // In-helmet Bluetooth headset routing; playback follows the same path.
        val bluetoothRouted = audioRouter.startVoiceRouting()
        player.useVoiceCall = true
        // Arm playback for this session. stop() release()s the player; arming here
        // is what lets a late frame from a previous session be dropped instead of
        // resurrecting a track nothing would release.
        player.prepare()

        _state.update {
            it.copy(
                handsFree = true,
                turnState = TurnState.LISTENING,
                micMuted = false,
                bluetoothRouted = bluetoothRouted,
                authRequired = false,
                hasRideContext = false
            )
        }
        scope.launch {
            val resolvedLocation = if (syntheticCapture) null else resolveLocation()
            if (!lifecycle.accepts(generation)) return@launch
            val locationStarted = withContext(Dispatchers.Main.immediate) {
                if (!lifecycle.accepts(generation)) return@withContext false
                location = resolvedLocation
                lastLocationFixAt = android.os.SystemClock.elapsedRealtime()
                refreshPhoneLocation(clearLocation = false)
                true
            }
            if (!locationStarted || !lifecycle.accepts(generation)) return@launch
            // AudioTrack creation may take hundreds of milliseconds. Complete it
            // off the reader/main threads before any provider PCM can arrive.
            val playbackReady = try {
                withContext(Dispatchers.IO) {
                    lifecycle.accepts(generation) && player.warmUp()
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                // The blocking platform constructor can finish after its owner was
                // cancelled. Release its acquired output even though deviceScope
                // shares that cancelled Job; a newer generation must stay intact.
                withContext(kotlinx.coroutines.NonCancellable + Dispatchers.Main.immediate) {
                    if (lifecycle.accepts(generation)) stop(force = true)
                }
                throw cancelled
            } catch (error: Exception) {
                Log.w(TAG, "Playback preparation failed", error)
                failHandsFreeStart(generation, "音频播放不可用，请检查音频设备")
                return@launch
            }
            if (!playbackReady || !lifecycle.accepts(generation)) return@launch
            connect()
            if (webSocket == null) {
                failHandsFreeStart(generation, "中继地址无效，请在设置中检查服务器地址")
                return@launch
            }
            try {
                mic.start()
                // stop() may have won the race while AudioRecord was starting.
                if (!lifecycle.accepts(generation)) mic.stop()
            } catch (error: Exception) {
                Log.w(TAG, "Mic start failed", error)
                failHandsFreeStart(generation, "麦克风不可用，请检查录音权限")
            }
        }
    }

    /** Retry after returning from Settings or granting precise location. */
    fun refreshPhoneLocation(clearLocation: Boolean = true) {
        val generation = lifecycle.current() ?: return
        if (!_state.value.handsFree || syntheticCapture) return
        sessionLocation.stop()
        if (clearLocation) location = null
        if (clearLocation) lastLocationFixAt = Long.MIN_VALUE / 2
        lastLocationSentAt = Long.MIN_VALUE / 2
        sessionLocation.start { fix ->
            if (lifecycle.accepts(generation)) {
                location = fix.lat to fix.lon
                val now = android.os.SystemClock.elapsedRealtime()
                lastLocationFixAt = now
                if (_state.value.connection == ConnectionState.READY && now - lastLocationSentAt >= 10_000) {
                    lastLocationSentAt = now
                    webSocket?.send(org.json.JSONObject().put("type", "location.update").put("lat", fix.lat).put("lon", fix.lon).toString())
                }
            }
        }
    }

    /** Tears down every resource acquired before an async start failed. */
    private fun failHandsFreeStart(generation: Int, message: String) {
        lifecycle.finishOn(deviceScope, generation, teardown = { stop() }, publish = {
            _state.update { it.copy(connection = ConnectionState.DEGRADED, statusText = message) }
        })
    }

    /** Deactivates hands-free: stop the mic, restore routing, close the relay. */
    fun stop(force: Boolean = false) {
        hudCast.stop()
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) { deviceScope.launch { stop(force) }; return }
        music.stopPlayback()
        sessionLocation.stop()
        location = null
        crash.sessionEnded()
        if (crash.controller.active && !force) {
            stopAfterIncident = true
            transmitting = false; micMuted = false; mic.stop(); stopAgentSpeech()
            webSocket?.send(AUDIO_STOP_EVENT)
            deviceJobs.forEach { it.cancel() }; deviceJobs.clear(); camera.stopForSession()
            navSearch.failPending(); navController.teardown()
            _state.update { it.copy(handsFree = false, micMuted = false, turnState = TurnState.IDLE, voiceLevel = 0f) }
            return
        }
        if (!lifecycle.stop()) {
            if (!crash.controller.active) { crash.sessionEnded(); VoiceAgentService.stop(context) }
            return
        }
        deviceScope.launch {
            deviceJobs.forEach { it.cancel() }; deviceJobs.clear()
            camera.stopForSession()
        }
        transmitting = false
        micMuted = false
        intentionalClose = true
        reconnectJob?.cancel()
        restartJob?.cancel()
        webSocket?.send(AUDIO_STOP_EVENT)
        webSocket?.close(1000, "rider stopped")
        socketOpen = false
        webSocket = null
        mic.stop()
        tts?.stop()
        // Release (not just flush) so the next session can pick a new audio route.
        player.release()
        audioRouter.stopVoiceRouting()
        // stop() is also called internally on idle/auth/startup failures, not
        // only through MainViewModel, so it owns foreground-service cleanup.
        if (!crash.controller.active) VoiceAgentService.stop(context)
        // A dead/closing socket delivers no route: resolve any in-flight
        // nav.request as an honest failure and retire the active route
        // (silently — there is no rider-facing turn left to answer or speak
        // it to). Every abnormal handleSocketClosed branch that ends the
        // session (idle close, rejected upgrade, exhausted reconnects) routes
        // through this same stop(), so they inherit the same teardown.
        navSearch.failPending()
        navController.teardown()
        _state.update {
            it.copy(
                handsFree = false,
                connection = ConnectionState.OFFLINE,
                statusText = "离线",
                turnState = TurnState.IDLE,
                voiceLevel = 0f,
                micMuted = false,
                bluetoothRouted = false,
                hazardAlert = null,
                navGuidance = null,
                feedbackFloorId = Int.MAX_VALUE
            )
        }
    }

    /**
     * Tester flags a transcript turn as bad (mirrors sendTurnFeedback in
     * useHelmetAgent.ts). The relay attaches the reason to the matching turn
     * of its CURRENT session, so only turns above feedbackFloorId qualify —
     * State.canFlagTurn gates the UI and this re-checks before sending.
     */
    fun sendTurnFeedback(item: TranscriptItem, reason: String) {
        if (!socketOpen || !_state.value.canFlagTurn(item)) return
        val turnId = item.turnId ?: return
        webSocket?.send(buildTurnFeedback(turnId, item.speaker, item.text, reason))
        _state.update { state ->
            state.copy(
                transcript = state.transcript.map { turn ->
                    if (turn.id == item.id) turn.copy(feedback = reason) else turn
                }
            )
        }
    }

    /**
     * Mutes/unmutes the rider's microphone without ending the session, so Max can
     * keep talking while the rider's audio is withheld (the bottom mute control).
     */
    fun toggleMute() {
        if (!_state.value.handsFree) return
        micMuted = !micMuted
        val muted = micMuted
        _state.update { it.copy(micMuted = muted, voiceLevel = if (muted) 0f else it.voiceLevel) }
    }

    /**
     * Switches the live speaker. Mirrors restartSession in src/main.tsx: the
     * Doubao speaker is fixed at session start, so reconnect for a fresh session.
     * The mic keeps running across the restart.
     */
    fun setVoiceGender(gender: VoiceGender) {
        if (_state.value.voiceGender == gender) return
        _state.update {
            it.copy(
                voiceGender = gender,
                statusText = if (gender == VoiceGender.MALE) "已切换到男声" else "已切换到女声"
            )
        }
        restartIfConnected()
    }

    /** Mirrors setVoicePersonality in src/main.tsx. */
    fun setVoicePersonality(personality: VoicePersonality) {
        if (_state.value.voicePersonality == personality) return
        _state.update {
            it.copy(voicePersonality = personality, statusText = "已切换语气：${personality.label}")
        }
        restartIfConnected()
    }

    /** Mirrors setRideMode in src/main.tsx, including the hazard fusion. */
    fun setRideMode(mode: RideMode) {
        if (_state.value.rideContext.mode == mode) return
        _state.update {
            val hazardLevel = combineHazardLevels(rideModeHazard(mode), it.rideContext.scenario.hazard)
            it.copy(rideContext = it.rideContext.copy(mode = mode, hazardLevel = hazardLevel))
        }
        restartIfConnected()
    }

    /** Mirrors setScenario in src/main.tsx — the scenario also picks a default mode. */
    fun setScenario(scenario: DemoScenario) {
        if (_state.value.rideContext.scenario == scenario) return
        _state.update {
            val mode = scenarioDefaultMode(scenario)
            val hazardLevel = combineHazardLevels(rideModeHazard(mode), scenario.hazard)
            it.copy(
                rideContext = it.rideContext.copy(scenario = scenario, mode = mode, hazardLevel = hazardLevel)
            )
        }
        restartIfConnected()
    }

    /** Builds the transcript export JSON (port of exportTranscriptLog in src/main.tsx). */
    fun buildTranscriptExport(): String = buildTranscriptExportJson(_state.value.transcript)

    /**
     * Toggles the guided demo ride (mock provider only — the live provider
     * ignores it). Mirrors setGuidedDemo in useHelmetAgent.ts: send now when the
     * socket is up; onOpen re-sends it for fresh sessions.
     */
    fun setGuidedDemo(enabled: Boolean) {
        _state.update {
            it.copy(
                guidedDemo = enabled,
                statusText = if (enabled && it.connection != ConnectionState.READY) {
                    "巡游演示已开启，开启免提后自动巡游场景"
                } else {
                    it.statusText
                }
            )
        }
        webSocket?.send(buildGuidedDemo(enabled))
    }

    /**
     * The UI handled the 401 (opened the account settings): consume the flag
     * so recomposition (rotation, process restore) can't re-open the sheet the
     * rider just dismissed. A fresh 401 sets it true again.
     */
    fun acknowledgeAuthRequired() {
        _state.update { it.copy(authRequired = false) }
    }

    /** Selects the immutable account that owns the on-device transcript cache.
     * Signing out hides the log; another account loads a different record. */
    fun selectTranscriptOwner(userId: String?) {
        val owner = userId?.trim()?.lowercase()?.takeIf {
            it.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
        }
        if (transcriptOwnerId == owner) return
        transcriptOwnerId = owner
        prefs.edit().remove(LEGACY_KEY_TRANSCRIPT_LOG).apply()
        val restored = owner
            ?.let { decodeStoredTranscript(prefs.getString("$KEY_TRANSCRIPT_PREFIX$it", null)) }
            .orEmpty()
        transcriptTurn = restored.maxOfOrNull { it.id } ?: 0
        persistedTranscriptSignature = restored.size to (restored.lastOrNull()?.id ?: 0)
        _state.update {
            it.copy(transcript = restored, feedbackFloorId = Int.MAX_VALUE, sessionMemory = SessionMemory())
        }
    }

    /** Clears both the live transcript and its persisted copy (清空对话记录). */
    fun clearTranscript() {
        _state.update { it.copy(transcript = emptyList()) }
        persistedTranscriptSignature = null
        transcriptOwnerId?.let { prefs.edit().remove("$KEY_TRANSCRIPT_PREFIX$it").apply() }
    }

    // ---- relay connection --------------------------------------------------

    private fun buildHttpClient(allowSelfSigned: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS)

        if (BuildConfig.DEBUG && allowSelfSigned) {
            // Debug-only: release binaries cannot install a trust-all manager
            // or hostname verifier, even if stale preferences request it.
            val trustAll = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(trustAll), SecureRandom())
            }
            builder.sslSocketFactory(sslContext.socketFactory, trustAll)
            builder.hostnameVerifier { _, _ -> true }
        }

        return builder.build()
    }

    private fun restartIfConnected() {
        if (_state.value.handsFree && webSocket != null) restartSession()
    }

    private fun nativeDeviceLabel(): String =
        "${if (BuildConfig.DEBUG && syntheticCapture) "Android emulator instrumentation synthetic audio" else "Android"} ${Build.MANUFACTURER} ${Build.MODEL}"
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(120)

    private fun nativeNetworkType(): String =
        if (BuildConfig.DEBUG && syntheticCapture) {
            when (testingTestCaseId) {
                "wind-noise-robustness" -> "synthetic field wind"
                "degraded-network-recovery" -> "synthetic degraded outage"
                else -> "android-native synthetic"
            }
        } else "android-native"

    private fun nativeAppVersion(): String =
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.1.0"
        }.getOrDefault("0.1.0").take(40)

    private fun restartSession() {
        val socket = webSocket
        webSocket = null
        intentionalClose = true
        socket?.close(1000, "session restart")
        restartJob?.cancel()
        restartJob = scope.launch {
            delay(150)
            // The rider may have ended hands-free inside the delay window;
            // reconnecting anyway would open a zombie session with no mic.
            if (!_state.value.handsFree) return@launch
            intentionalClose = false
            reconnectAttempts = 0
            connect()
        }
    }

    private fun connect() {
        if (intentionalClose) return
        socketOpen = false
        _state.update {
            it.copy(
                connection = ConnectionState.CONNECTING,
                statusText = if (reconnectAttempts > 0) "重新连接中…（第 $reconnectAttempts 次）" else "连接中"
            )
        }

        // The relay address is a free-text settings field: an invalid or
        // scheme-less URL throws here, and an uncaught exception in the
        // connect coroutine would crash the whole app (the iOS client guards
        // its URL parse the same way).
        val request = runCatching { Request.Builder().url(relayUrl).build() }.getOrElse { error ->
            Log.w(TAG, "Invalid relay URL", error)
            _state.update {
                it.copy(connection = ConnectionState.DEGRADED, statusText = "中继地址无效，请在设置中检查服务器地址")
            }
            return
        }
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== this@AgentSession.webSocket) return
                reconnectAttempts = 0
                // Only turns appended from here on belong to this relay session
                // and are eligible for turn.feedback.
                _state.update {
                    it.copy(
                        connection = ConnectionState.RELAY,
                        statusText = "就绪",
                        feedbackFloorId = transcriptTurn
                    )
                }
                val current = _state.value
                webSocket.send(
                    buildSessionStart(
                        voiceGender = current.voiceGender,
                        voicePersonality = current.voicePersonality,
                        rideMode = current.rideContext.mode,
                        scenario = current.rideContext.scenario,
                        lat = location?.first?.takeIf { android.os.SystemClock.elapsedRealtime() - lastLocationFixAt <= 15_000 },
                        lon = location?.second?.takeIf { android.os.SystemClock.elapsedRealtime() - lastLocationFixAt <= 15_000 },
                        testerId = this@AgentSession.testerId.ifEmpty { "android-native" },
                        testerRegion = TimeZone.getDefault().id,
                        testingCampaignId = testingCampaignId,
                        testingTestCaseId = testingTestCaseId,
                        testingRunId = testingRunId,
                        testingAssignmentId = testingAssignmentId,
                        appVersion = nativeAppVersion(),
                        gitCommit = BuildConfig.GIT_COMMIT,
                        deviceLabel = nativeDeviceLabel(),
                        browserLanguage = Locale.getDefault().toLanguageTag(),
                        networkType = nativeNetworkType(),
                        memory = current.sessionMemory
                    )
                )
                // The guided tour lives in the provider instance, so a fresh session
                // must be told about it again (mirrors the web client's open handler).
                if (current.guidedDemo) webSocket.send(buildGuidedDemo(enabled = true))
                // Resume the audio stream if the rider was transmitting before a drop.
                if (transmitting) webSocket.send(AUDIO_START_EVENT)
                // Mic frames wait for session.started, not merely the relay handshake.
                socketOpen = false
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== this@AgentSession.webSocket) return
                observePipeline("socket.text.received", text.length)
                val event = runCatching { parseAgentEvent(text) }.getOrElse {
                    _state.update { state -> state.copy(statusText = "收到异常代理消息") }
                    observePipeline("socket.text.invalid", text.length)
                    return
                }
                val tracedEvent = if (syntheticPipelineObserver != null) pipelineEventName(event) else ""
                if (syntheticPipelineObserver != null) observePipeline("socket.event.parsed:$tracedEvent", text.length)
                try {
                    handleEvent(event, webSocket)
                } finally {
                    if (syntheticPipelineObserver != null) observePipeline("socket.event.handled:$tracedEvent", text.length)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== this@AgentSession.webSocket) return
                // AudioTrack setup can throw (unsupported config / bad state); keep it
                // from escaping onto the reader thread and tearing down the listener.
                observePipeline("socket.binary.received", bytes.size)
                runCatching { if (!crash.controller.active) player.play(bytes.toByteArray()) }
                    .onFailure { Log.w(TAG, "PCM playback failed", it) }
                observePipeline("socket.binary.handled", bytes.size)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== this@AgentSession.webSocket) return
                // Unlike a browser, OkHttp does NOT auto-complete the closing
                // handshake or deliver onClosed for a server-initiated close unless
                // we close our side. Without this, the relay's graceful closes —
                // idle 4001, auth-revoke/expire 1008, shutdown 1001 — would only
                // surface ~pingInterval later as an onFailure (code 0) and wrongly
                // auto-reconnect into the session the relay just shed. Handle the
                // close with the server's code now, then complete the handshake.
                handleSocketClosed(webSocket, code)
                runCatching { webSocket.close(1000, null) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleSocketClosed(webSocket, code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Relay socket failure", t)
                // A non-null response means the relay answered but refused the
                // upgrade (e.g. 401 login required) — surface that instead of
                // retrying into the same rejection.
                handleSocketClosed(webSocket, httpStatus = response?.code)
            }
        })
    }

    private fun handleSocketClosed(socket: WebSocket, closeCode: Int = 0, httpStatus: Int? = null) {
        // Ignore a socket already superseded by a newer one (e.g. a restart).
        if (webSocket != null && socket !== webSocket) return
        // Process each socket's terminal callback once: onClosing (which completes
        // the server's close handshake) and the onClosed it then triggers both land
        // here for the same socket, and after the first run webSocket is null so the
        // guard above no longer distinguishes them.
        if (socket === closedSocket) return
        closedSocket = socket
        socketOpen = false
        webSocket = null
        if (intentionalClose) {
            if (_state.value.handsFree) return // restartSession() will reconnect
            _state.update { it.copy(connection = ConnectionState.OFFLINE, statusText = "离线") }
            return
        }
        val generation = lifecycle.current() ?: return

        // The relay closed an idle session to free its upstream slot. End
        // hands-free entirely (mirrors the web client's stopMic on 4001):
        // leaving it half-alive kept the mic capturing, Bluetooth SCO routed,
        // and the orb pulsing "listening" with no session behind it.
        if (closeCode == IDLE_CLOSE_CODE && !crash.controller.active) {
            reconnectAttempts = 0
            lifecycle.finishOn(deviceScope, generation, teardown = { stop() }, publish = {
                _state.update { it.copy(statusText = "会话闲置已断开，请重新开启免提") }
            })
            return
        }

        // The relay answered but refused the WebSocket upgrade. Retrying can't
        // fix either case: 401 means a login token is required (accounts are
        // active on the shared relay — see the web HUD's 复制令牌 button),
        // anything else is a configuration problem (e.g. wrong path → 400).
        if (httpStatus != null && httpStatus != 101) {
            reconnectAttempts = 0
            // End hands-free entirely, like the idle-close branch: a rejected
            // upgrade left a zombie session (mic capturing, audio routed, no
            // reconnect) and the next helmet tap STOPPED the zombie instead of
            // retrying with the fresh login.
            lifecycle.finishOn(deviceScope, generation,
                teardown = { crash.controller.detachAccount(); stop(force = true) }, publish = {
                    _state.update {
                        it.copy(
                            connection = ConnectionState.DEGRADED,
                            authRequired = httpStatus == 401,
                            statusText = if (httpStatus == 401) {
                                "需要登录：在设置的「账号」里登录（或粘贴认证令牌）"
                            } else {
                                "中继拒绝连接（HTTP $httpStatus），请检查中继地址"
                            }
                        )
                    }
                })
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        reconnectAttempts += 1
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS && !crash.controller.active) {
            reconnectAttempts = 0
            lifecycle.finishOn(deviceScope, generation, teardown = { stop() }, publish = {
                _state.update {
                    it.copy(connection = ConnectionState.DEGRADED, statusText = "语音中继连接失败，请重新开启免提")
                }
            })
            return
        }
        val delayMs = if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) 30_000L else minOf(8_000L, 1_000L * (1L shl (reconnectAttempts - 1)))
        _state.update {
            it.copy(connection = ConnectionState.OFFLINE, statusText = "连接已断开，${delayMs / 1000} 秒后自动重连…")
        }
        reconnectJob = scope.launch {
            delay(delayMs)
            connect()
        }
    }

    // ---- event handling ----------------------------------------------------

    private fun handleEvent(event: AgentEvent, sourceSocket: WebSocket) {
        when (event) {
            is AgentEvent.SessionStarted -> {
                socketOpen = true
                deviceScope.launch { if (sourceSocket === webSocket && !syntheticCapture) crash.controller.ready() }
                _state.update {
                    it.copy(
                        provider = event.provider,
                        isLive = event.mode != "mock",
                        capabilities = event.capabilities,
                        connection = ConnectionState.READY,
                        statusText = if (event.mode == "mock") "模拟路线已启用" else "豆包实时语音在线"
                    )
                }
            }

            is AgentEvent.Connection -> _state.update {
                it.copy(connection = mapConnectionState(event.state, it.connection), statusText = event.detail)
            }

            is AgentEvent.Status -> {
                if (event.state == "hearing") stopAgentSpeech()
                _state.update {
                    val connection = when (event.state) {
                        "connecting" -> ConnectionState.PROVIDER
                        "ready" -> ConnectionState.READY
                        "closed" -> ConnectionState.OFFLINE
                        else -> it.connection
                    }
                    it.copy(
                        statusText = event.detail,
                        connection = connection,
                        turnState = if (transmitting) mapTurnState(event.state, it.turnState) else it.turnState
                    )
                }
            }

            is AgentEvent.CrashAck -> deviceScope.launch { if (sourceSocket === webSocket && !syntheticCapture) crash.controller.ack(event.incidentId, event.status, event.detail) }
            AgentEvent.CrashSimulate -> deviceScope.launch { if (sourceSocket === webSocket && BuildConfig.DEBUG && !syntheticCapture) crash.controller.simulate() }
            is AgentEvent.Transcript -> {
                if (event.speaker == Speaker.RIDER && event.final) deviceScope.launch { if (sourceSocket === webSocket && !syntheticCapture) { crash.controller.transcript(event.text); navController.handleConfirmationReply(event.text) } }
                // Barge-in: the rider talking always silences the agent.
                if (event.speaker == Speaker.RIDER) {
                    stopAgentSpeech()
                }
                pushTranscript(event.speaker, event.text, event.final, event.turnId, event.deliveryId)
                val shouldSpeak = event.useBrowserSpeech ?: event.final
                if (!crash.controller.active && event.speaker == Speaker.AGENT && shouldSpeak && spokenDeliveryIds.add(event.deliveryId)) {
                    if (spokenDeliveryIds.size > 512) spokenDeliveryIds.remove(spokenDeliveryIds.first())
                    ttsSpeak(event.text)
                }
            }

            is AgentEvent.Metric -> event.latencyMs?.let { latency ->
                _state.update { it.copy(latencyMs = latency) }
            }

            is AgentEvent.WeatherUpdate -> _state.update {
                // rideContext.hazardLevel is owned by ride.context events (already fused
                // with weather server-side); fusedHazard folds the current weather in at
                // read time. Mutating hazardLevel here would only ever raise it (max),
                // so an improving weather reading could leave the HUD stuck high.
                it.copy(weather = event.weather)
            }

            is AgentEvent.RideContextUpdate -> _state.update { it.copy(rideContext = event.rideContext, hasRideContext = true) }

            is AgentEvent.SessionMemoryUpdate -> _state.update { it.copy(sessionMemory = event.memory) }

            is AgentEvent.TelemetryUpdate -> _state.update { it.copy(telemetry = event.telemetry) }

            is AgentEvent.HazardAlert -> handleHazardAlert(event)

            is AgentEvent.ErrorEvent -> _state.update { it.copy(statusText = event.message) }

            is AgentEvent.DeviceCommand -> {
                if (syntheticCapture) {
                    sourceSocket.send(buildDeviceResult(event.commandId, "failed", "synthetic-disabled", "Device actions are disabled for synthetic QA"))
                    return
                }
                val source = sourceSocket
                val job = deviceScope.launch {
                    if (source !== webSocket || !state.value.handsFree || event.commandId.isBlank()) return@launch
                    if (!deviceCommandIds.add(event.commandId)) return@launch
                    if (deviceCommandIds.size > 512) deviceCommandIds.remove(deviceCommandIds.first())
                    if (event.action.startsWith("navigation.") || event.action == "destination.show") {
                        navController.handleCommand(event.commandId,
                            if (event.action == "destination.show") "navigation.start" else event.action, event.query)
                    } else {
                        val result = deviceActions.execute(event,
                            isCurrent = { source === webSocket && state.value.handsFree }, send = source::send)
                        if (source === webSocket && state.value.handsFree) source.send(result.json(event.commandId))
                    }
                }
                // The dispatch scope is the session's main scope; mutations stay
                // on it even though socket callbacks arrive from OkHttp threads.
                deviceScope.launch { deviceJobs.removeAll { it.isCompleted }; if (!job.isCompleted) deviceJobs.add(job) }
            }

            is AgentEvent.NavRoute -> navSearch.handleNavRoute(event.data)

            is AgentEvent.NavError -> navSearch.handleNavError(event.commandId, event.code)

            AgentEvent.Unhandled -> Unit
        }
    }

    /** Upserts partial/final transcript events by their relay-issued turn id. */
    private fun pushTranscript(speaker: Speaker, text: String, final: Boolean, turnId: String, deliveryId: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        val now = System.currentTimeMillis()
        val language = detectLanguage(clean)
        val existingIndex = _state.value.transcript.indexOfFirst { it.turnId == turnId }
        if (existingIndex >= 0) {
            _state.update { state ->
                state.copy(
                    transcript = state.transcript.mapIndexed { index, item ->
                        if (index == existingIndex) {
                            item.copy(at = now, text = clean, final = final, language = language, deliveryId = deliveryId)
                        } else item
                    }
                )
            }
            persistTranscript()
            return
        }

        _state.update { state ->
            val items = state.transcript
            val last = items.lastOrNull()

            // New turn: finalize any dangling in-progress entry, then append.
            val finalized = if (last != null && !last.final) {
                items.dropLast(1) + last.copy(final = true)
            } else {
                items
            }
            state.copy(
                transcript = finalized + TranscriptItem(
                    id = ++transcriptTurn,
                    turnId = turnId,
                    deliveryId = deliveryId,
                    at = now,
                    speaker = speaker,
                    text = clean,
                    final = final,
                    language = language
                )
            )
        }
        persistTranscript()
    }

    /**
     * Persists the finished turns so the conversation survives restarts (the
     * counterpart of saveStoredTranscript in src/lib/persistence.ts). Final
     * entries never mutate, so a (count, last id) signature is enough to skip
     * the disk write while a partial turn is still streaming in.
     */
    private fun persistTranscript() {
        val owner = transcriptOwnerId ?: return
        val finals = _state.value.transcript.filter { it.final }.takeLast(TRANSCRIPT_CAP)
        val signature = finals.size to (finals.lastOrNull()?.id ?: 0)
        if (signature == persistedTranscriptSignature) return
        persistedTranscriptSignature = signature
        prefs.edit().putString("$KEY_TRANSCRIPT_PREFIX$owner", encodeStoredTranscript(finals)).apply()
    }

    // ---- ADAS hazard alerts ------------------------------------------------

    /**
     * A proactive ADAS alert: cut any in-progress agent speech so the warning is
     * heard immediately, surface the banner, speak it, then auto-clear it.
     */
    data class SyntheticHazardPlayback(
        val hazardGeneration: Int,
        val before: PcmPlayer.PlaybackDiagnostics,
        val after: PcmPlayer.PlaybackDiagnostics
    )

    @Volatile
    var syntheticHazardPlayback: SyntheticHazardPlayback? = null
        private set

    private fun handleHazardAlert(alert: AgentEvent.HazardAlert) {
        val before = if (BuildConfig.DEBUG && syntheticCapture) player.playbackDiagnostics() else null
        if (alert.interrupt) stopAgentSpeech()
        hazardAlertGeneration += 1
        if (before != null) {
            syntheticHazardPlayback = SyntheticHazardPlayback(hazardAlertGeneration, before, player.playbackDiagnostics())
        }
        val generation = hazardAlertGeneration
        _state.update {
            it.copy(hazardAlert = alert, turnState = TurnState.SPEAKING, statusText = "⚠️ ${alert.label}")
        }
        ttsSpeak(
            "${alert.message} ${alert.advice}",
            utteranceId = if (syntheticCapture) "synthetic-hazard-$generation" else "max-reply"
        )
        scope.launch {
            delay((alert.ttcSeconds + 2) * 1000L)
            if (hazardAlertGeneration == generation) {
                _state.update { it.copy(hazardAlert = null) }
            }
        }
    }

    // ---- speech output -----------------------------------------------------

    /** Barge-in: silence whatever the agent is currently saying. */
    private fun stopAgentSpeech() {
        tts?.stop()
        player.stopPlayback()
        if (transmitting) {
            _state.update { it.copy(turnState = TurnState.LISTENING, statusText = "已打断 Max，继续听你说") }
        }
    }

    /** Device-TTS speech, generalized to take a queueing mode: `flush = true`
     *  (agent replies, ADAS hazards) cuts whatever is currently queued;
     *  `flush = false` (nav far/near prompts) appends behind it instead, so a
     *  turn-by-turn prompt never cuts an in-flight agent reply. */
    private fun ttsSpeak(text: String, flush: Boolean = true, utteranceId: String = "max-reply") {
        val engine = tts ?: return
        if (!ttsReady || text.isBlank()) return
        engine.language = if (detectLanguage(text) == "zh") Locale.SIMPLIFIED_CHINESE else Locale.US
        engine.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, utteranceId)
    }

    // ---- NavSpeaker (NavigationController's speech + hazard-suppression seam) ----

    /** Read-only: NavigationController checks this before speaking a
     *  maneuver prompt (a suppressed prompt is DROPPED, not queued — see
     *  NavSpeaker's doc). Never calls back into navController — onFix holds
     *  NavigationController's lock across this whole speaker path, so any
     *  such call would deadlock. */
    override val hazardActive: Boolean
        get() = _state.value.hazardAlert != null

    /** Pre-route locating feedback is visible in the UI. Route prompts use
     *  sendRelayPrompt so only MAX's selected relay voice reaches playback. */
    override fun speak(text: String, interrupt: Boolean) {
        _state.update { it.copy(statusText = text) }
    }

    // ---- location ----------------------------------------------------------

    /**
     * Fresh cached fix for session startup; the continuous stream supplies later fixes.
     */
    @SuppressLint("MissingPermission")
    private suspend fun resolveLocation(): Pair<Double, Double>? {
        if (!hasLocationPermission()) return null
        return withContext(Dispatchers.IO) {
            runCatching {
                val manager = context.getSystemService(LocationManager::class.java) ?: return@runCatching null
                listOf(
                    LocationManager.GPS_PROVIDER,
                    LocationManager.NETWORK_PROVIDER,
                    LocationManager.PASSIVE_PROVIDER
                ).mapNotNull { provider ->
                    runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
                }.filter {
                    val age = android.os.SystemClock.elapsedRealtimeNanos() - it.elapsedRealtimeNanos
                    age in 0..15_000_000_000L && it.hasAccuracy() && it.accuracy in 0f..100f
                }.maxByOrNull { it.elapsedRealtimeNanos }?.let { it.latitude to it.longitude }
            }.getOrNull()
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun resolveCrashLocation(): Pair<Double, Double>? = withContext(Dispatchers.IO) {
        if (!hasLocationPermission()) return@withContext null
        val manager = context.getSystemService(LocationManager::class.java) ?: return@withContext null
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).mapNotNull {
            runCatching { manager.getLastKnownLocation(it) }.getOrNull()
        }.filter { android.os.SystemClock.elapsedRealtimeNanos() - it.elapsedRealtimeNanos in 0..30_000_000_000L }
            .maxByOrNull { it.elapsedRealtimeNanos }?.let { it.latitude to it.longitude }
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** navigation.start's permission gate — deliberately FINE-only, unlike
     *  [hasLocationPermission] above (which also accepts COARSE for the
     *  best-effort weather fix). LocationManagerSource requests only
     *  GPS_PROVIDER and itself requires FINE; a COARSE-accepting check here
     *  would report permission granted while the location stream silently
     *  never starts, so navigation.start would time out after
     *  firstFixTimeoutMillis and answer unsupported/route.unavailable
     *  instead of the truthful denied/permission.location. */
    private fun hasFineLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
}

/** Process-wide owner of the single AgentSession instance. */
object AgentSessionHolder {
    @Volatile
    private var session: AgentSession? = null

    fun get(context: Context): AgentSession =
        session ?: synchronized(this) {
            session ?: AgentSession(
                context.applicationContext,
                CoroutineScope(SupervisorJob() + Dispatchers.Default)
            ).also { session = it }
        }
}
