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
    private val scope: CoroutineScope
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
         * but rider audio frames are withheld (voice-assistant-style mute).
         */
        val micMuted: Boolean = false,
        val voiceGender: VoiceGender = VoiceGender.FEMALE,
        val voicePersonality: VoicePersonality = VoicePersonality.CONCISE,
        val voiceLevel: Float = 0f,
        val latencyMs: Int = 0,
        val transcript: List<TranscriptItem> = emptyList(),
        val weather: Weather? = null,
        val rideContext: RideContext = RideContext(),
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
    private var location: Pair<Double, Double>? = null
    /** Relay-issued speech deliveries already handed to device TTS. */
    private val spokenDeliveryIds = linkedSetOf<String>()

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** (count, last id) of the final turns last written, so partial updates skip the disk. */
    private var persistedTranscriptSignature: Pair<Int, Int>? = null

    private val player = PcmPlayer()
    private val audioRouter = AudioRouter(context)
    private val mic = MicStreamer(
        onFrame = { frame ->
            val socket = webSocket
            if (
                transmitting && !micMuted && socketOpen &&
                socket != null && socket.queueSize() + frame.size < MAX_MIC_QUEUE_BYTES
            ) {
                socket.send(frame.toByteString())
            }
        },
        onLevel = { level -> _state.update { it.copy(voiceLevel = if (transmitting && !micMuted) level else 0f) } },
        onError = {
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
        onGuidance = { guidance -> _state.update { it.copy(navGuidance = guidance) } },
        hasLocationPermission = ::hasFineLocationPermission
    )

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

        intentionalClose = false
        reconnectAttempts = 0
        transmitting = true
        micMuted = false
        spokenDeliveryIds.clear()

        // In-helmet Bluetooth headset routing; playback follows the same path.
        val bluetoothRouted = audioRouter.startVoiceRouting()
        player.useVoiceCall = bluetoothRouted
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
                authRequired = false
            )
        }
        scope.launch {
            val resolvedLocation = resolveLocation()
            if (!lifecycle.accepts(generation)) return@launch
            location = resolvedLocation
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

    /** Tears down every resource acquired before an async start failed. */
    private fun failHandsFreeStart(generation: Int, message: String) {
        if (!lifecycle.accepts(generation)) return
        stop()
        _state.update { it.copy(connection = ConnectionState.DEGRADED, statusText = message) }
    }

    /** Deactivates hands-free: stop the mic, restore routing, close the relay. */
    fun stop() {
        if (!lifecycle.stop()) return
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
        VoiceAgentService.stop(context)
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
        "Android ${Build.MANUFACTURER} ${Build.MODEL}"
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(120)

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
                        lat = location?.first,
                        lon = location?.second,
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
                        networkType = "android-native",
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
                val event = runCatching { parseAgentEvent(text) }.getOrElse {
                    _state.update { state -> state.copy(statusText = "收到异常代理消息") }
                    return
                }
                handleEvent(event)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== this@AgentSession.webSocket) return
                // AudioTrack setup can throw (unsupported config / bad state); keep it
                // from escaping onto the reader thread and tearing down the listener.
                runCatching { player.play(bytes.toByteArray()) }
                    .onFailure { Log.w(TAG, "PCM playback failed", it) }
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

        // The relay closed an idle session to free its upstream slot. End
        // hands-free entirely (mirrors the web client's stopMic on 4001):
        // leaving it half-alive kept the mic capturing, Bluetooth SCO routed,
        // and the orb pulsing "listening" with no session behind it.
        if (closeCode == IDLE_CLOSE_CODE) {
            reconnectAttempts = 0
            stop()
            _state.update { it.copy(statusText = "会话闲置已断开，请重新开启免提") }
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
            stop()
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
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        reconnectAttempts += 1
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts = 0
            stop()
            _state.update {
                it.copy(connection = ConnectionState.DEGRADED, statusText = "语音中继连接失败，请重新开启免提")
            }
            return
        }
        val delayMs = minOf(8_000L, 1_000L * (1L shl (reconnectAttempts - 1)))
        _state.update {
            it.copy(connection = ConnectionState.OFFLINE, statusText = "连接已断开，${delayMs / 1000} 秒后自动重连…")
        }
        reconnectJob = scope.launch {
            delay(delayMs)
            connect()
        }
    }

    // ---- event handling ----------------------------------------------------

    private fun handleEvent(event: AgentEvent) {
        when (event) {
            is AgentEvent.SessionStarted -> {
                socketOpen = true
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

            is AgentEvent.Transcript -> {
                // Barge-in: the rider talking always silences the agent.
                if (event.speaker == Speaker.RIDER) {
                    stopAgentSpeech()
                }
                pushTranscript(event.speaker, event.text, event.final, event.turnId, event.deliveryId)
                val shouldSpeak = event.useBrowserSpeech ?: event.final
                if (event.speaker == Speaker.AGENT && shouldSpeak && spokenDeliveryIds.add(event.deliveryId)) {
                    if (spokenDeliveryIds.size > 512) spokenDeliveryIds.remove(spokenDeliveryIds.first())
                    ttsSpeak(event.text)
                }
            }

            is AgentEvent.Metric -> _state.update { it.copy(latencyMs = event.latencyMs) }

            is AgentEvent.WeatherUpdate -> _state.update {
                // rideContext.hazardLevel is owned by ride.context events (already fused
                // with weather server-side); fusedHazard folds the current weather in at
                // read time. Mutating hazardLevel here would only ever raise it (max),
                // so an improving weather reading could leave the HUD stuck high.
                it.copy(weather = event.weather)
            }

            is AgentEvent.RideContextUpdate -> _state.update { it.copy(rideContext = event.rideContext) }

            is AgentEvent.SessionMemoryUpdate -> _state.update { it.copy(sessionMemory = event.memory) }

            is AgentEvent.TelemetryUpdate -> _state.update { it.copy(telemetry = event.telemetry) }

            is AgentEvent.HazardAlert -> handleHazardAlert(event)

            is AgentEvent.ErrorEvent -> _state.update { it.copy(statusText = event.message) }

            // Only navigation.* actions route to the controller — every other
            // device.command action stays silent, as before Task 6.
            is AgentEvent.DeviceCommand -> {
                if (event.action.startsWith("navigation.")) {
                    scope.launch { navController.handleCommand(event.commandId, event.action, event.query) }
                }
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
    private fun handleHazardAlert(alert: AgentEvent.HazardAlert) {
        if (alert.interrupt) stopAgentSpeech()
        hazardAlertGeneration += 1
        val generation = hazardAlertGeneration
        _state.update {
            it.copy(hazardAlert = alert, turnState = TurnState.SPEAKING, statusText = "⚠️ ${alert.label}")
        }
        ttsSpeak("${alert.message} ${alert.advice}")
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
    private fun ttsSpeak(text: String, flush: Boolean = true) {
        val engine = tts ?: return
        if (!ttsReady || text.isBlank()) return
        engine.language = if (detectLanguage(text) == "zh") Locale.SIMPLIFIED_CHINESE else Locale.US
        engine.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "max-reply")
    }

    // ---- NavSpeaker (NavigationController's speech + hazard-suppression seam) ----

    /** Read-only: NavigationController checks this before speaking a
     *  maneuver prompt (a suppressed prompt is DROPPED, not queued — see
     *  NavSpeaker's doc). Never calls back into navController — onFix holds
     *  NavigationController's lock across this whole speaker path, so any
     *  such call would deadlock. */
    override val hazardActive: Boolean
        get() = _state.value.hazardAlert != null

    /** NOW-identity prompts (interrupt = true) cut whatever the agent is
     *  currently saying first; far/near prompts (interrupt = false) queue
     *  behind it instead. Strictly speech emission — never touches
     *  navController. */
    override fun speak(text: String, interrupt: Boolean) {
        if (interrupt) stopAgentSpeech()
        ttsSpeak(text, flush = interrupt)
    }

    // ---- location ----------------------------------------------------------

    /**
     * Best-effort one-shot location for the weather context. Last-known is good
     * enough — the server falls back to its demo location when this is null.
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
                ).firstNotNullOfOrNull { provider ->
                    runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
                }?.let { it.latitude to it.longitude }
            }.getOrNull()
        }
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
