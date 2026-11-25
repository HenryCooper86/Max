package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AssistantBranding

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.speech.tts.TextToSpeech
import io.github.henrycooper86.max.ui.Localization
import android.util.Log
import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.actions.DeviceActions
import io.github.henrycooper86.max.capture.CameraController
import io.github.henrycooper86.max.capture.CaptureStore
import io.github.henrycooper86.max.capture.encodeVideoBitmap
import android.graphics.Bitmap
import kotlinx.coroutines.isActive
import io.github.henrycooper86.max.music.MusicController
import io.github.henrycooper86.max.navigation.LocationManagerSource
import io.github.henrycooper86.max.navigation.NavGuidanceState
import io.github.henrycooper86.max.navigation.NavSpeaker
import io.github.henrycooper86.max.navigation.NavigationController
import io.github.henrycooper86.max.navigation.RelayNavigationSearch
import io.github.henrycooper86.max.power.DeviceLoad
import io.github.henrycooper86.max.power.DeviceLoadGuard
import io.github.henrycooper86.max.power.LoadNotice
import io.github.henrycooper86.max.power.loadNoticeText
import io.github.henrycooper86.max.service.VoiceAgentService
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
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

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
        val statusText: String = tr(Str.CONN_OFFLINE),
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
        /** Chosen voice backend id (relay /health voice.providers); null = relay default. */
        val voiceProvider: String? = null,
        val voiceLevel: Float = 0f,
        val latencyMs: Int = 0,
        val transcript: List<TranscriptItem> = emptyList(),
        val weather: Weather? = null,
        val rideContext: RideContext = RideContext(),
        val hasRideContext: Boolean = false,
        val sessionMemory: SessionMemory = SessionMemory(),
        val telemetry: Telemetry? = null,
        val bluetoothRouted: Boolean = false,
        val speedKmh: Double? = null,
        /** Capture and assistant audio are paused because another app (a phone call) has the audio. */
        val audioPaused: Boolean = false,
        /** The microphone stopped working; voice is off and retried, crash detection stays on. */
        val voiceCaptureDown: Boolean = false,
        /** The transient tool line from tool.activity; null when no tool is running. */
        val toolStatus: ToolStatus? = null,
        /** Heat or battery saver has switched off the map and other extras (the voice session stays). */
        val extrasShed: Boolean = false,
        /** The active ADAS hazard alert, shown as a banner until it auto-clears. */
        val hazardAlert: AgentEvent.HazardAlert? = null,
        /** NavigationController's published turn-by-turn state, rendered as the
         *  guidance card. Null whenever no navigation session is running —
         *  including at arrival, which publishes null rather than a terminal
         *  "arrived" guidance value (see NavGuidanceState's doc). */
        val navGuidance: NavGuidanceState? = null,
        /** Guided demo ride: the mock provider auto-tours the scenario catalog. */
        val guidedDemo: Boolean = false,
        /** The relay refused the credentials — HTTP 401 on the upgrade, or close code 1008
         * once connected — so a login (or token) is required. The UI opens the account
         * settings when this flips on. */
        val authRequired: Boolean = false,
        /** Transcript ids above this floor belong to the CURRENT relay session
         *  and may be flagged via turn.feedback (the relay matches inside its
         *  live session transcript, so a restored/previous-session turn could
         *  tag the wrong turn). MAX_VALUE = nothing flaggable (offline). */
        val feedbackFloorId: Int = Int.MAX_VALUE,
        /** The camera is on and the assistant is being sent what it shows (live video). */
        val videoActive: Boolean = false
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

        /** Mirrors USAGE_LIMIT_CLOSE_CODE in shared/agent.ts: the account's voice minutes are
         * spent, and every reconnect would be refused the same way. */
        const val USAGE_LIMIT_CLOSE_CODE = 4003

        /** Mirrors UNAUTHORIZED_CLOSE_CODE in shared/agent.ts: the relay refused the
         * credentials (signed out, expired, revoked or deleted). */
        const val UNAUTHORIZED_CLOSE_CODE = 1008

        /** Repeated agent lines inside this window are dropped (src/main.tsx). */

        /** Same prefs file the HUD settings use (MainViewModel.PREFS). */
        private const val PREFS = "max_helmet"
        private const val LEGACY_KEY_TRANSCRIPT_LOG = "transcript_log"
        private const val KEY_TRANSCRIPT_PREFIX = "transcript_log_v2_"

        /** Keep the stored conversation bounded (TRANSCRIPT_CAP in src/lib/persistence.ts). */
        private const val TRANSCRIPT_CAP = 200
        private const val VIDEO_TICK_MS = 250L
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
    @Volatile
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
    /** The phone's own speed, fed by [sessionLocation]; see RideSpeed for the precedence. */
    private val rideSpeed = RideSpeed(android.os.SystemClock::elapsedRealtime)
    private var speedExpiryJob: Job? = null
    private var lastLocationSentAt = Long.MIN_VALUE / 2
    /** Relay-issued speech deliveries already handed to device TTS. */
    private val spokenDeliveryIds = linkedSetOf<String>()

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** (count, last id) of the final turns last written, so partial updates skip the disk. */
    private var persistedTranscriptSignature: Pair<Int, Int>? = null

    private val player = PcmPlayer()
    private val warningPlayer = PcmPlayer(verifyWarningRender = BuildConfig.DEBUG)
    private val warningAudio = SafetyWarningAudio(
        load = { SafetyWarningCatalog.load { path -> context.assets.open("adas/$path").use { it.readBytes() } } },
        sink = object : SafetyWarningSink {
            override fun prepare() = warningPlayer.prepare()
            override fun warmUp() = warningPlayer.warmUp()
            override fun play(pcm: ByteArray) = warningPlayer.play(pcm)
            override fun stop() = warningPlayer.stopPlayback()
            override fun release() = warningPlayer.release()
            override fun diagnostics() = warningPlayer.warningOutputState()
        }
    )

    fun syntheticWarningDiagnostics(): SafetyWarningDiagnostics {
        check(BuildConfig.DEBUG && syntheticCapture)
        return warningAudio.diagnostics()
    }

    /** Opt-in observations for synthetic diagnostics; no payload text or credentials. */
    var syntheticPipelineObserver: ((String, Int) -> Unit)? = null
        set(value) {
            check(BuildConfig.DEBUG && syntheticCapture)
            field = value
            player.syntheticPipelineObserver = value
            warningPlayer.syntheticPipelineObserver = value?.let { observer ->
                { stage, amount -> observer("warning.$stage", amount) }
            }
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
        io.github.henrycooper86.max.crash.CrashRuntime(context, deviceScope,
            speed = rideSpeed::forCrash,
            gateSpeed = rideSpeed::forCrashGate,
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
        speed = ::currentSpeedKmh,
        load = { loadGuard.load })
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
            // Marshal off the capture thread. A headset change or a phone call
            // makes AudioRecord fail just before its own callback arrives, so the
            // environment decides: recover the mic, wait for the call, or end
            // hands-free rather than leave the HUD pulsing "listening" behind a
            // mic that will never emit another frame (mirrors web/iOS).
            deviceScope.launch {
                if (!_state.value.handsFree || lifecycle.current() == null) return@launch
                synchronized(captureLock) { captureRunning = false }
                if (syntheticCapture) endForCaptureFailure() else environment.onCaptureFailed()
            }
        }
    )

    /** Serialises AudioRecord start/stop between the startup coroutine and main-thread callbacks. */
    private val captureLock = Any()
    @Volatile private var captureRunning = false

    /** Mirror of state.audioPaused for the socket reader threads. */
    @Volatile private var audioPaused = false

    /** A call ended before session.started: audio.start is owed once the provider is ready. */
    @Volatile private var audioStartPending = false

    private val environmentControls = EnvironmentControls()
    private val environment = SessionEnvironment(
        focus = AndroidVoiceFocus(context),
        devices = AndroidAudioDeviceWatch(context),
        network = AndroidNetworkWatch(context),
        controls = environmentControls,
        scope = deviceScope,
        clock = android.os.SystemClock::elapsedRealtime,
        media = AndroidMediaPlaybackWatch(context),
        calls = AndroidCallStateWatch(context)
    )
    private val loadGuard = DeviceLoadGuard(AndroidDeviceLoadSource(context), ::onLoadNotice, ::shedLoad,
        onLoad = { load -> _state.update { it.copy(extrasShed = !load.extrasAllowed) } })
    private val toolTracker = ToolActivityTracker()
    private var toolRefreshJob: Job? = null
    /** tool.call ids already answered: the protocol allows exactly one tool.result per call. */
    private val answeredToolCalls = linkedSetOf<String>()

    private fun startCapture(generation: Int): Boolean = synchronized(captureLock) {
        if (!lifecycle.accepts(generation) || audioPaused || !_state.value.handsFree) return false
        if (!captureRunning) {
            mic.start()
            captureRunning = true
        }
        true
    }

    private fun stopCapture() = synchronized(captureLock) {
        captureRunning = false
        mic.stop()
    }

    // ---- navigation ---------------------------------------------------------

    val hudCast = io.github.henrycooper86.max.navigation.HudCastClient(context)

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
     * start the mic. `allowSelfSignedTls` allows debug builds to trust device-installed
     * CAs for wss:// URLs. A non-empty `authToken` is sent
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
        environment.reconnect.reset()
        transmitting = true
        micMuted = false
        audioPaused = false
        audioStartPending = false
        rideSpeed.reset()
        spokenDeliveryIds.clear()
        deviceScope.launch { deviceCommandIds.clear(); answeredToolCalls.clear() }

        // In-helmet Bluetooth headset routing; playback follows the same path.
        val bluetoothRouted = audioRouter.startVoiceRouting()
        player.useVoiceCall = true
        warningPlayer.useVoiceCall = true
        // Arm playback for this session. stop() release()s the player; arming here
        // is what lets a late frame from a previous session be dropped instead of
        // resurrecting a track nothing would release.
        player.prepare()
        warningAudio.prepare(generation)

        _state.update {
            it.copy(
                handsFree = true,
                turnState = TurnState.LISTENING,
                micMuted = false,
                bluetoothRouted = bluetoothRouted,
                authRequired = false,
                hasRideContext = false,
                speedKmh = null,
                audioPaused = false,
                voiceCaptureDown = false,
                toolStatus = null,
                extrasShed = false
            )
        }
        if (!syntheticCapture) {
            // Focus, device, network and heat watchers live exactly as long as
            // this generation; stop() releases them. In-app music plays under
            // the session's focus rather than competing with it.
            music.underVoiceFocus = true
            environment.start()
            loadGuard.start()
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
                    lifecycle.accepts(generation) && warningAudio.warmUp() &&
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
                failHandsFreeStart(generation, tr(Str.STATUS_AUDIO_UNAVAILABLE))
                return@launch
            }
            if (!playbackReady || !lifecycle.accepts(generation)) return@launch
            connect()
            if (webSocket == null) {
                failHandsFreeStart(generation, tr(Str.STATUS_RELAY_BAD))
                return@launch
            }
            try {
                // A session started during a phone call waits for the call to end;
                // resumeAudio() starts capture then. The generation is checked under
                // the capture lock, and stop() invalidates it before stopping capture,
                // so a stop racing this start always releases the microphone.
                startCapture(generation)
            } catch (error: Exception) {
                Log.w(TAG, "Mic start failed", error)
                // A dead microphone must not take crash detection down with it:
                // voice stays off and is retried; only synthetic QA ends the session.
                if (syntheticCapture) failHandsFreeStart(generation, tr(Str.STATUS_MIC_UNAVAILABLE))
                else deviceScope.launch { if (lifecycle.accepts(generation)) environment.onCaptureStartFailed() }
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
        sessionLocation.start(onFix = { fix ->
            if (lifecycle.accepts(generation)) {
                location = fix.lat to fix.lon
                val now = android.os.SystemClock.elapsedRealtime()
                lastLocationFixAt = now
                if (_state.value.connection == ConnectionState.READY && now - lastLocationSentAt >= 10_000) {
                    lastLocationSentAt = now
                    webSocket?.send(buildLocationUpdate(fix.lat, fix.lon, rideSpeed.freshGpsKmh()))
                }
            }
        }, onSpeed = { kmh, fixAtMs, fromGps ->
            if (lifecycle.accepts(generation)) {
                rideSpeed.onGps(kmh, fixAtMs, fromGps)
                publishSpeed()
            }
        })
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
        stopVideo()
        if (crash.controller.active && !force) {
            stopAfterIncident = true
            transmitting = false; micMuted = false; stopCapture(); stopAgentSpeech()
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
        environment.stop()
        loadGuard.stop()
        music.underVoiceFocus = false
        audioPaused = false
        audioStartPending = false
        toolRefreshJob?.cancel()
        toolTracker.clear()
        speedExpiryJob?.cancel()
        rideSpeed.reset()
        webSocket?.send(AUDIO_STOP_EVENT)
        webSocket?.close(1000, "rider stopped")
        socketOpen = false
        webSocket = null
        stopCapture()
        tts?.stop()
        // Release (not just flush) so the next session can pick a new audio route.
        player.release()
        warningAudio.release()
        audioRouter.stopVoiceRouting()
        // stop() is also called internally on idle/auth/startup failures, not
        // only through MainViewModel, so it owns foreground-service cleanup.
        if (!crash.controller.active) VoiceAgentService.stop(context)
        // A dead/closing socket delivers no route: resolve any in-flight
        // nav.request as an honest failure and retire the active route
        // (silently — there is no rider-facing turn left to answer or speak
        // it to). Every abnormal handleSocketClosed branch that ends the
        // session (idle close, used-up minutes, refused credentials, rejected
        // upgrade, exhausted reconnects) routes through this same stop(), so
        // they inherit the same teardown.
        navSearch.failPending()
        navController.teardown()
        _state.update {
            it.copy(
                handsFree = false,
                connection = ConnectionState.OFFLINE,
                statusText = tr(Str.CONN_OFFLINE),
                turnState = TurnState.IDLE,
                voiceLevel = 0f,
                micMuted = false,
                bluetoothRouted = false,
                speedKmh = null,
                audioPaused = false,
                voiceCaptureDown = false,
                toolStatus = null,
                extrasShed = false,
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
                statusText = if (gender == VoiceGender.MALE) tr(Str.STATUS_MALE) else tr(Str.STATUS_FEMALE)
            )
        }
        restartIfConnected()
    }

    /** The app language changed: a live session restarts so the assistant follows it, like a voice change. */
    fun languageChanged() = restartIfConnected()

    /** Selects the relay voice backend; restarts the session like a gender change. */
    fun setVoiceProvider(id: String?) {
        if (_state.value.voiceProvider == id) return
        _state.update { it.copy(voiceProvider = id) }
        restartIfConnected()
    }

    /** Mirrors setVoicePersonality in src/main.tsx. */
    fun setVoicePersonality(personality: VoicePersonality) {
        if (_state.value.voicePersonality == personality) return
        _state.update {
            it.copy(voicePersonality = personality, statusText = tr(Str.STATUS_TONE, "label" to personality.label))
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
                    tr(Str.STATUS_TOUR_ON)
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

    private fun buildHttpClient(allowSelfSigned: Boolean): OkHttpClient =
        relayHttpClient(allowSelfSigned) { pingInterval(20, TimeUnit.SECONDS) }

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
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: BuildConfig.VERSION_NAME
        }.getOrDefault(BuildConfig.VERSION_NAME).take(40)

    private fun restartSession() {
        val socket = webSocket
        webSocket = null
        warningAudio.stop()
        intentionalClose = true
        socket?.close(1000, "session restart")
        restartJob?.cancel()
        restartJob = scope.launch {
            delay(150)
            // The rider may have ended hands-free inside the delay window;
            // reconnecting anyway would open a zombie session with no mic.
            if (!_state.value.handsFree) return@launch
            intentionalClose = false
            environment.reconnect.onConnected()
            connect()
        }
    }

    // Synchronized: a network handover reconnects from the main thread while a
    // backoff retry may fire on a worker; only one socket may be current.
    @Synchronized
    private fun connect() {
        if (intentionalClose) return
        socketOpen = false
        rideSpeed.onSocketClosed()
        environment.onSocketChanged()
        val attempts = environment.reconnect.attempts
        _state.update {
            it.copy(
                connection = ConnectionState.CONNECTING,
                statusText = if (attempts > 0) tr(Str.STATUS_RECONNECTING, "n" to attempts) else tr(Str.CONN_CONNECTING)
            )
        }

        // The relay address is a free-text settings field: an invalid or
        // scheme-less URL throws here, and an uncaught exception in the
        // connect coroutine would crash the whole app (the iOS client guards
        // its URL parse the same way).
        val request = runCatching { Request.Builder().url(relayUrl).build() }.getOrElse { error ->
            Log.w(TAG, "Invalid relay URL", error)
            _state.update {
                it.copy(connection = ConnectionState.DEGRADED, statusText = tr(Str.STATUS_RELAY_BAD))
            }
            return
        }
        val superseded = webSocket
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== this@AgentSession.webSocket) return
                environment.reconnect.onConnected()
                // Only turns appended from here on belong to this relay session
                // and are eligible for turn.feedback.
                _state.update {
                    it.copy(
                        connection = ConnectionState.RELAY,
                        statusText = tr(Str.STATUS_READY),
                        feedbackFloorId = transcriptTurn
                    )
                }
                val current = _state.value
                webSocket.send(
                    buildSessionStart(
                        voiceGender = current.voiceGender,
                        language = io.github.henrycooper86.max.ui.Localization.language.wire,
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
                        memory = current.sessionMemory,
                        voiceProvider = current.voiceProvider
                    )
                )
                // The guided tour lives in the provider instance, so a fresh session
                // must be told about it again (mirrors the web client's open handler).
                if (current.guidedDemo) webSocket.send(buildGuidedDemo(enabled = true))
                // Resume the audio stream if the rider was transmitting before a drop
                // (not while a phone call holds the audio: resumeAudio() sends it).
                if (transmitting && !audioPaused) { audioStartPending = false; webSocket.send(AUDIO_START_EVENT) }
                // Mic frames wait for session.started, not merely the relay handshake.
                socketOpen = false
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== this@AgentSession.webSocket) return
                environment.onRelayTraffic()
                observePipeline("socket.text.received", text.length)
                val event = runCatching { parseAgentEvent(text) }.getOrElse {
                    _state.update { state -> state.copy(statusText = tr(Str.STATUS_BAD_PROVIDER)) }
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
                environment.onRelayTraffic()
                // AudioTrack setup can throw (unsupported config / bad state); keep it
                // from escaping onto the reader thread and tearing down the listener.
                observePipeline("socket.binary.received", bytes.size)
                runCatching {
                    // While a phone call has the audio, the reply is dropped, not queued
                    // to blare out when the call ends.
                    if (!crash.controller.active && !audioPaused) player.play(bytes.toByteArray()) {
                        webSocket === this@AgentSession.webSocket && lifecycle.current() != null
                    }
                }
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
        // A reconnect that raced another one: the older socket must not linger open.
        if (superseded != null) runCatching { superseded.cancel() }
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
        // The socket is gone, so there is no one to show: the camera goes off, and is not left on unseen.
        stopVideo()
        rideSpeed.onSocketClosed()
        environment.onSocketChanged()
        warningAudio.stop()
        if (intentionalClose) {
            if (_state.value.handsFree) return // restartSession() will reconnect
            _state.update { it.copy(connection = ConnectionState.OFFLINE, statusText = tr(Str.CONN_OFFLINE)) }
            return
        }
        val generation = lifecycle.current() ?: return

        // The relay closed the session for good (docs/protocol.md, Close
        // codes): reconnecting with the same account would only be refused
        // again, so hands-free ends instead and the status says why. An idle
        // close ends it entirely (mirrors the web client's stopMic on 4001):
        // leaving it half-alive kept the mic capturing, Bluetooth SCO routed,
        // and the orb pulsing "listening" with no session behind it.
        val finalClose = FinalRelayClose.from(closeCode, crashActive = crash.controller.active)
        if (finalClose != null) {
            endHandsFree(generation, finalClose)
            return
        }

        // The relay answered but refused the WebSocket upgrade. Retrying can't
        // fix either case: 401 means a login token is required (accounts are
        // active on the shared relay — see the web HUD's 复制令牌 button),
        // anything else is a configuration problem (e.g. wrong path → 400).
        if (httpStatus != null && httpStatus != 101) {
            environment.reconnect.onConnected()
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
                                tr(Str.STATUS_LOGIN_REQUIRED)
                            } else {
                                tr(Str.STATUS_RELAY_REFUSED, "status" to httpStatus)
                            }
                        )
                    }
                })
            return
        }

        deviceScope.launch { clearToolStatus() }
        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx),
        // except while the phone has no network: the network callback reconnects
        // the moment it returns, without spending the retry budget on a tunnel.
        when (val decision = environment.reconnect.onDrop(keepTrying = crash.controller.active)) {
            ReconnectPolicy.Decision.GiveUp -> lifecycle.finishOn(deviceScope, generation, teardown = { stop() }, publish = {
                _state.update {
                    it.copy(connection = ConnectionState.DEGRADED, statusText = tr(Str.STATUS_RELAY_FAILED))
                }
            })
            ReconnectPolicy.Decision.WaitForNetwork -> _state.update {
                it.copy(connection = ConnectionState.OFFLINE, statusText = tr(Str.STATUS_WAITING_NETWORK))
            }
            is ReconnectPolicy.Decision.Retry -> {
                _state.update {
                    it.copy(connection = ConnectionState.OFFLINE, statusText = tr(Str.STATUS_RECONNECT_IN, "n" to decision.delayMs / 1000))
                }
                reconnectJob = scope.launch {
                    delay(decision.delayMs)
                    connect()
                }
            }
        }
    }

    /**
     * Ends hands-free for a close the rider cannot reconnect past (see
     * [FinalRelayClose]) and leaves its reason on the HUD. Nothing retries, so
     * the reconnect budget starts afresh for the next session.
     */
    private fun endHandsFree(generation: Int, close: FinalRelayClose) {
        environment.reconnect.onConnected()
        // Refused credentials take the HTTP 401 route: a crash alert could not
        // reach the relay without them either.
        val accountRefused = close.authRequired
        lifecycle.finishOn(deviceScope, generation,
            teardown = {
                if (accountRefused) crash.controller.detachAccount()
                stop(force = accountRefused)
            },
            publish = {
                _state.update {
                    it.copy(
                        connection = if (close.failed) ConnectionState.DEGRADED else it.connection,
                        authRequired = accountRefused,
                        statusText = tr(close.status)
                    )
                }
            })
    }

    // ---- event handling ----------------------------------------------------

    private fun handleEvent(event: AgentEvent, sourceSocket: WebSocket) {
        when (event) {
            is AgentEvent.SessionStarted -> {
                socketOpen = true
                // The relay counts pictures per connection.
                imageLimiter.reset()
                // A reconnect to a session that takes no video ends it, here and on the relay.
                if (video.sessionStarted(event.capabilities.videoInput)) videoEnded()
                // A live relay's ride.context speed is the phone's own echo: only a mock relay's counts.
                rideSpeed.onSessionMode(event.mode)
                if (audioStartPending && transmitting && !audioPaused) { audioStartPending = false; sourceSocket.send(AUDIO_START_EVENT) }
                deviceScope.launch { if (sourceSocket === webSocket && !syntheticCapture) crash.controller.ready() }
                _state.update {
                    it.copy(
                        provider = event.provider,
                        isLive = event.mode != "mock",
                        capabilities = event.capabilities,
                        connection = ConnectionState.READY,
                        statusText = if (event.mode == "mock") tr(Str.STATUS_MOCK_ON) else tr(Str.STATUS_DOUBAO_ON)
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
                // Only the relay's own status says its audio should be streaming (relay watchdog).
                if (sourceSocket === webSocket) environment.onRelayStatus(event.state)
                // Natural points for audio focus when another app keeps it (see VoiceFocusPolicy).
                when (event.state) {
                    "speaking" -> deviceScope.launch { if (sourceSocket === webSocket) environment.onAssistantSpeaking() }
                    "listening", "ready", "hearing", "closed" -> deviceScope.launch {
                        if (sourceSocket === webSocket && _state.value.hazardAlert == null) environment.onAssistantQuiet()
                    }
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
                if (!crash.controller.active && !audioPaused && event.speaker == Speaker.AGENT && shouldSpeak && spokenDeliveryIds.add(event.deliveryId)) {
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

            is AgentEvent.RideContextUpdate -> {
                _state.update { it.copy(rideContext = event.rideContext, hasRideContext = true) }
                if (sourceSocket === webSocket) rideSpeed.onRelay(event.rideContext.speedKmh?.toDouble())
                deviceScope.launch { publishSpeed() }
            }

            is AgentEvent.SessionMemoryUpdate -> _state.update { it.copy(sessionMemory = event.memory) }

            is AgentEvent.TelemetryUpdate -> _state.update { it.copy(telemetry = event.telemetry) }

            // Safety warnings play even while a phone call has paused the session.
            is AgentEvent.HazardAlert -> handleHazardAlert(event, sourceSocket)

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

            is AgentEvent.ToolActivity -> deviceScope.launch { if (sourceSocket === webSocket) showToolActivity(event) }

            is AgentEvent.ToolCall -> {
                val reply = unexpectedToolCallReply(event) ?: return
                deviceScope.launch {
                    if (sourceSocket !== webSocket || !answeredToolCalls.add(event.callId)) return@launch
                    if (answeredToolCalls.size > 512) answeredToolCalls.remove(answeredToolCalls.first())
                    sourceSocket.send(reply)
                }
            }

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
        val after: PcmPlayer.PlaybackDiagnostics,
        val warningText: String,
        val voiceGender: String,
        val threat: String,
        val warningSessionEpoch: Long
    )

    @Volatile
    var syntheticHazardPlayback: SyntheticHazardPlayback? = null
        private set

    private fun handleHazardAlert(alert: AgentEvent.HazardAlert, sourceSocket: WebSocket) {
        val owner = lifecycle.current() ?: return
        deviceScope.launch { if (sourceSocket === webSocket) environment.onAssistantSpeaking() }
        warningAudio.withCurrentOwner(owner, { sourceSocket === webSocket && lifecycle.accepts(owner) }) {
            if (!lifecycle.accepts(owner)) return@withCurrentOwner
            val text = "${alert.message} ${alert.advice}"
            val gender = _state.value.voiceGender.wire
            val before = if (BuildConfig.DEBUG && syntheticCapture) player.playbackDiagnostics() else null
            if (alert.interrupt) stopAgentSpeech()
            hazardAlertGeneration += 1
            if (before != null) {
                syntheticHazardPlayback = SyntheticHazardPlayback(hazardAlertGeneration, before, player.playbackDiagnostics(),
                    text, gender, alert.threat, warningAudio.diagnostics().sessionEpoch)
            }
            val generation = hazardAlertGeneration
            _state.update {
                it.copy(hazardAlert = alert, turnState = TurnState.SPEAKING, statusText = "⚠️ ${alert.label}")
            }
            try {
                tts?.stop()
                // English mode: speak the event's English message with device TTS (the bundled clips are
                // Chinese). If TTS is unavailable, fall through to the clip so a warning is never silent.
                val spokenByTts = hazardSpeechPath(Localization.language, alert.message) == HazardSpeech.DEVICE_TTS &&
                    ttsSpeak(alert.message, utteranceId = if (syntheticCapture) "synthetic-hazard-$generation" else "max-reply")
                if (spokenByTts) {
                    warningAudio.stop()
                } else if (!warningAudio.play(alert.threat, text, gender, generation, owner)) {
                    check(!warningAudio.isKnown(alert.threat, text, gender)) {
                        "Prepared bundled safety warning is unavailable"
                    }
                    // Unknown future vocabulary must never substitute a different bundled warning.
                    warningAudio.stop()
                    if (lifecycle.accepts(owner)) check(ttsSpeak(text,
                        utteranceId = if (syntheticCapture) "synthetic-hazard-$generation" else "max-reply")) {
                        "Device safety speech is unavailable"
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Safety warning playback failed", error)
                if (lifecycle.accepts(owner)) _state.update { it.copy(statusText = tr(Str.STATUS_SAFETY_SOUND_FAILED)) }
            }
            scope.launch {
                delay((alert.ttcSeconds + 2) * 1000L)
                warningAudio.withCurrentOwner(owner, { sourceSocket === webSocket && lifecycle.accepts(owner) }) {
                    if (lifecycle.accepts(owner) && hazardAlertGeneration == generation) {
                        _state.update { it.copy(hazardAlert = null) }
                        deviceScope.launch { if (_state.value.turnState != TurnState.SPEAKING) environment.onAssistantQuiet() }
                    }
                }
            }
        }
    }

    // ---- speed ----------------------------------------------------------------

    /** Fresh phone GPS, else a mock relay's scenario speed, else unknown (see RideSpeed). */
    private fun currentSpeedKmh(): Double? = rideSpeed.current()

    /** Main thread: mirrors the effective speed into state and expires a GPS reading when it goes stale. */
    private fun publishSpeed() {
        _state.update { it.copy(speedKmh = currentSpeedKmh()) }
        speedExpiryJob?.cancel()
        val until = rideSpeed.freshUntilMs() ?: return
        speedExpiryJob = deviceScope.launch {
            delay((until - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(0) + 1)
            _state.update { it.copy(speedKmh = currentSpeedKmh()) }
        }
    }

    // ---- typed turns and tool activity --------------------------------------

    /**
     * Sends a typed turn (text.input). The relay shows it as a final rider line
     * and the assistant answers aloud, so nothing is added to the transcript
     * here. False when the backend does not accept typed turns or the session
     * is not ready.
     */
    fun sendTextInput(text: String): Boolean {
        if (!socketOpen || typedInputMode(_state.value) != TypedInputMode.READY) return false
        val payload = buildTextInput(text) ?: return false
        return webSocket?.send(payload) == true
    }

    private val imageLimiter = ImageInputLimiter()

    /**
     * Shows the model a picture (image.input): a JPEG as base64, already
     * scaled to fit. With [text] it is a typed turn with the picture attached;
     * without, the model sees it with the user's next turn. Null when it went
     * out, else why it did not.
     */
    fun sendImageInput(jpegBase64: String, text: String? = null): ImageRefusal? {
        if (!socketOpen || !imageInputReady(_state.value)) return ImageRefusal.NOT_READY
        val now = android.os.SystemClock.elapsedRealtime()
        imageLimiter.refusal(now)?.let { return it }
        val payload = buildImageInput(jpegBase64, text) ?: return ImageRefusal.TOO_LARGE
        if (webSocket?.send(payload) != true) return ImageRefusal.NOT_READY
        imageLimiter.sent(now)
        return null
    }

    // Live video: the newest camera frame is encoded and sent about once a second, off the main thread.
    // takesVideo reads the state, which holds the capabilities of the current session.started.
    private val video = LiveVideo<Bitmap>(
        connected = { socketOpen },
        takesVideo = { _state.value.capabilities.videoInput },
        send = { payload -> webSocket?.send(payload) == true },
        encode = ::encodeVideoBitmap,
        now = { android.os.SystemClock.elapsedRealtime() }
    )
    private var videoJob: Job? = null

    /** Turns live video on. False when the session cannot take it now. */
    @Synchronized
    fun startVideo(): Boolean {
        if (!video.start()) return false
        _state.update { it.copy(videoActive = true) }
        videoJob?.cancel()
        videoJob = deviceScope.launch(Dispatchers.Default) {
            // Often, so the frame sent is a fresh one; LiveVideo keeps the pace.
            while (isActive) {
                video.sendNewest()
                delay(VIDEO_TICK_MS)
            }
        }
        return true
    }

    /** Turns live video off and tells the relay. Safe to call when it is off. */
    fun stopVideo() {
        video.stop()
        videoEnded()
    }

    // Turned on from the main thread, ended from there or from the socket's: one at a time.
    @Synchronized
    private fun videoEnded() {
        videoJob?.cancel()
        videoJob = null
        if (_state.value.videoActive) _state.update { it.copy(videoActive = false) }
    }

    /** The camera's newest frame, from its own thread. */
    fun offerVideoFrame(frame: Bitmap) = video.offer(frame)

    /** Main thread only, like the refresh job it schedules. */
    private fun showToolActivity(event: AgentEvent.ToolActivity) {
        val now = android.os.SystemClock.elapsedRealtime()
        val status = toolTracker.apply(event, now)
        _state.update { it.copy(toolStatus = status) }
        scheduleToolRefresh(now)
    }

    /** Re-reads the tracker when a failure line or a stale call expires, so the line never sticks. */
    private fun scheduleToolRefresh(now: Long) {
        toolRefreshJob?.cancel()
        val wait = toolTracker.nextExpiryIn(now) ?: return
        toolRefreshJob = deviceScope.launch {
            delay(wait)
            val later = android.os.SystemClock.elapsedRealtime()
            _state.update { it.copy(toolStatus = toolTracker.current(later)) }
            scheduleToolRefresh(later)
        }
    }

    private fun clearToolStatus() {
        toolRefreshJob?.cancel()
        toolTracker.clear()
        _state.update { it.copy(toolStatus = null) }
    }

    // ---- heat and battery saver ----------------------------------------------

    private fun onLoadNotice(notice: LoadNotice) {
        val text = loadNoticeText(notice)
        _state.update { it.copy(statusText = text) }
        // Heat warnings are spoken, queued behind any reply and never into a phone call.
        if (notice.spoken && !audioPaused) ttsSpeak(text, flush = false, utteranceId = "max-load")
    }

    /** Stops what the new load forbids; the voice session, crash detection and guidance keep running. */
    private fun shedLoad(load: DeviceLoad) {
        if (load.recordingMustStop && camera.isRecording.value) deviceScope.launch { camera.stopRecording() }
        if (!load.extrasAllowed) {
            music.stopOwnPlayback()
            hudCast.stop()
            deviceScope.launch { camera.setTorch(false) }
        }
    }

    // ---- focus, devices and network (SessionEnvironment) ----------------------

    /** Runs on the main thread; every entry point re-checks that a session is still current. */
    private inner class EnvironmentControls : SessionEnvironment.Controls {
        override fun pauseAudio() {
            if (lifecycle.current() == null) return
            audioPaused = true
            stopCapture()
            stopAgentSpeech()
            music.stopOwnPlayback()
            if (socketOpen) webSocket?.send(AUDIO_STOP_EVENT)
            _state.update {
                it.copy(audioPaused = true, voiceLevel = 0f,
                    statusText = tr(Str.STATUS_AUDIO_PAUSED, "name" to AssistantBranding.name))
            }
        }

        override fun resumeAudio(): Boolean {
            val generation = lifecycle.current() ?: return true
            audioPaused = false
            // While a dead-mic episode is open the "microphone unavailable" status stays.
            _state.update {
                if (it.voiceCaptureDown) it.copy(audioPaused = false)
                else it.copy(audioPaused = false, statusText = tr(Str.STATUS_AUDIO_RESUMED, "name" to AssistantBranding.name))
            }
            return try {
                if (startCapture(generation) && transmitting) {
                    if (socketOpen) webSocket?.send(AUDIO_START_EVENT) else audioStartPending = true
                }
                true
            } catch (error: Exception) {
                Log.w(TAG, "Mic restart after a pause failed", error)
                false
            }
        }

        override fun silenceOutput() = stopAgentSpeech()
        override fun audioYielded() {
            if (lifecycle.current() == null) return
            val text = tr(Str.STATUS_AUDIO_YIELDED, "name" to AssistantBranding.name)
            _state.update { it.copy(statusText = text) }
            if (!audioPaused) ttsSpeak(text, flush = false, utteranceId = "max-focus")
        }

        override val relayConnected: Boolean get() = webSocket != null

        override fun rerouteAudio() {
            // The environment never calls this during a call; the router also refuses in call modes.
            if (lifecycle.current() == null) return
            val change = audioRouter.refreshRouting() ?: return
            _state.update { it.copy(bluetoothRouted = change.bluetooth) }
            // The relay session is untouched; only capture moves to the new device.
            if (change.changed && captureRunning && !restartCapture()) environment.onCaptureStartFailed()
        }

        override fun restartCapture(): Boolean {
            val generation = lifecycle.current() ?: return true
            if (audioPaused || !_state.value.handsFree) return true
            return try {
                stopCapture()
                startCapture(generation)
                true
            } catch (error: Exception) {
                Log.w(TAG, "Mic restart failed", error)
                runCatching { stopCapture() }
                false
            }
        }

        override fun voiceCaptureLost() {
            if (lifecycle.current() == null) return
            runCatching { stopCapture() }
            _state.update {
                it.copy(voiceCaptureDown = true, voiceLevel = 0f,
                    statusText = tr(Str.STATUS_VOICE_DOWN, "name" to AssistantBranding.name))
            }
            // Said once, through whatever output still works; crash detection stays armed.
            ttsSpeak(tr(Str.STATUS_VOICE_DOWN, "name" to AssistantBranding.name), flush = false, utteranceId = "max-mic")
        }

        override fun voiceCaptureRestored() {
            if (lifecycle.current() == null) return
            _state.update {
                it.copy(voiceCaptureDown = false, statusText = tr(Str.STATUS_AUDIO_RESUMED, "name" to AssistantBranding.name))
            }
        }

        override fun replaceSocket() {
            if (lifecycle.current() == null || webSocket == null) return
            if (_state.value.handsFree) restartSession() else {
                // Crash-alarm tail: drop the silent socket and connect again directly.
                webSocket?.cancel()
            }
        }

        override fun reconnectNow() {
            if (lifecycle.current() == null) return
            // Only called with no socket: an open one is never restarted over a
            // network change (it fails on its own if the network took it down).
            if (webSocket != null) return
            reconnectJob?.cancel()
            connect()
        }

        override fun waitForNetwork() {
            if (lifecycle.current() == null) return
            reconnectJob?.cancel()
            _state.update { it.copy(statusText = tr(Str.STATUS_WAITING_NETWORK)) }
        }
    }

    /** Synthetic QA only: its injected capture has no retries to wait for. */
    private fun endForCaptureFailure() {
        if (!_state.value.handsFree) return
        stop()
        _state.update {
            it.copy(connection = ConnectionState.DEGRADED, statusText = tr(Str.STATUS_MIC_INTERRUPTED))
        }
    }

    // ---- speech output -----------------------------------------------------

    /** Barge-in: silence whatever the agent is currently saying. */
    private fun stopAgentSpeech() {
        tts?.stop()
        warningAudio.stop()
        player.stopPlayback()
        if (transmitting) {
            _state.update { it.copy(turnState = TurnState.LISTENING, statusText = tr(Str.STATUS_INTERRUPTED, "name" to AssistantBranding.name)) }
        }
    }

    /** Device-TTS speech, generalized to take a queueing mode: `flush = true`
     *  (agent replies, ADAS hazards) cuts whatever is currently queued;
     *  `flush = false` (nav far/near prompts) appends behind it instead, so a
     *  turn-by-turn prompt never cuts an in-flight agent reply. */
    private fun ttsSpeak(text: String, flush: Boolean = true, utteranceId: String = "max-reply"): Boolean {
        val engine = tts ?: return false
        if (!ttsReady || text.isBlank()) return false
        if (engine.setLanguage(ttsLocaleFor(text)) < 0) return false
        return engine.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, utteranceId) == TextToSpeech.SUCCESS
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

/** How a hazard warning is voiced: the bundled Chinese clip, or the event's English message through device TTS. */
internal enum class HazardSpeech { CLIP, DEVICE_TTS }

internal fun hazardSpeechPath(language: io.github.henrycooper86.max.ui.AppLanguage, message: String): HazardSpeech =
    if (language == io.github.henrycooper86.max.ui.AppLanguage.EN && message.isNotBlank()) HazardSpeech.DEVICE_TTS else HazardSpeech.CLIP

/** The TTS voice for a line of text: any Han character selects Chinese, otherwise US English. */
internal fun ttsLocaleFor(text: String): Locale =
    if (detectLanguage(text) == "zh") Locale.SIMPLIFIED_CHINESE else Locale.US

/**
 * A relay close that ends hands-free instead of reconnecting, and how the HUD is left
 * (docs/protocol.md, Close codes; shouldReconnect in sdk/src/protocol.ts). Reconnecting
 * with the same account would only be refused again. Mirrors FinalRelayClose in
 * ios/.../AgentSession.swift.
 */
internal enum class FinalRelayClose(val status: Str, val authRequired: Boolean = false) {
    /** 4001: the session sat idle, or the relay ended the conversation. */
    IDLE_ENDED(Str.STATUS_IDLE_ENDED),
    /** 4003: the account's voice minutes are used up until next month. */
    MINUTES_USED_UP(Str.STATUS_MINUTES_USED_UP),
    /** 1008: the relay refused the credentials (signed out, expired or revoked). */
    CREDENTIALS_REJECTED(Str.STATUS_SIGN_IN_AGAIN, authRequired = true);

    /** An idle session ended normally; the other closes are failures. */
    val failed: Boolean get() = this != IDLE_ENDED

    companion object {
        /**
         * The final close a code stands for, or null when the reconnect budget decides.
         * Only an idle close is not final under a crash incident: its alert still needs the
         * relay. Used-up minutes and refused credentials would refuse that alert too, so
         * retrying gains nothing.
         */
        fun from(closeCode: Int, crashActive: Boolean): FinalRelayClose? = when (closeCode) {
            AgentSession.IDLE_CLOSE_CODE -> IDLE_ENDED.takeUnless { crashActive }
            AgentSession.USAGE_LIMIT_CLOSE_CODE -> MINUTES_USED_UP
            AgentSession.UNAUTHORIZED_CLOSE_CODE -> CREDENTIALS_REJECTED
            else -> null
        }
    }
}
