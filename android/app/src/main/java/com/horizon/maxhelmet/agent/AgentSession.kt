package com.horizon.maxhelmet.agent

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.speech.tts.TextToSpeech
import android.util.Log
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
) {

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
        val sessionMemory: SessionMemory = SessionMemory(),
        val telemetry: Telemetry? = null,
        val bluetoothRouted: Boolean = false,
        /** The active ADAS hazard alert, shown as a banner until it auto-clears. */
        val hazardAlert: AgentEvent.HazardAlert? = null,
        /** Guided demo ride: the mock provider auto-tours the scenario catalog. */
        val guidedDemo: Boolean = false
    ) {
        /** 态势摘要 fusion: ride hazard + weather risk (fusedHazard in src/main.tsx). */
        val fusedHazard: HazardLevel
            get() = combineHazardLevels(rideContext.hazardLevel, weather?.riskLevel ?: HazardLevel.NORMAL)
    }

    companion object {
        private const val TAG = "AgentSession"

        /** Mirrors MAX_RECONNECT_ATTEMPTS in src/main.tsx. */
        const val MAX_RECONNECT_ATTEMPTS = 6

        /** Mirrors IDLE_CLOSE_CODE in shared/agent.ts: the relay closed this idle
         * session to free its upstream slot; auto-reconnecting would defeat it. */
        const val IDLE_CLOSE_CODE = 4001

        /** Repeated agent lines inside this window are dropped (src/main.tsx). */
        private const val AGENT_DEDUPE_WINDOW_MS = 8_000L

        /** Same prefs file the HUD settings use (MainViewModel.PREFS). */
        private const val PREFS = "max_helmet"
        private const val KEY_TRANSCRIPT_LOG = "transcript_log"

        /** Keep the stored conversation bounded (TRANSCRIPT_CAP in src/lib/persistence.ts). */
        private const val TRANSCRIPT_CAP = 200
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var httpClient: OkHttpClient = buildHttpClient(allowSelfSigned = false)
    private var allowSelfSigned = false

    // @Volatile: read from the mic capture thread (onFrame), written on OkHttp
    // listener threads and coroutine dispatchers.
    @Volatile
    private var webSocket: WebSocket? = null

    /** True only between onOpen (after session.start/audio.start are enqueued)
     * and the socket being closed/superseded. Mic frames sent while OkHttp is
     * still connecting would be buffered and flushed AHEAD of the handshake
     * events, so the server would receive raw audio before session.start —
     * the web client drops those frames too (useMicCapture readyState check). */
    @Volatile
    private var socketOpen = false

    private var relayUrl: String = ""
    private var reconnectAttempts = 0
    private var reconnectJob: Job? = null
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
    private var location: Pair<Double, Double>? = null

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** (count, last id) of the final turns last written, so partial updates skip the disk. */
    private var persistedTranscriptSignature: Pair<Int, Int>? = null

    private val player = PcmPlayer()
    private val audioRouter = AudioRouter(context)
    private val mic = MicStreamer(
        onFrame = { frame -> if (transmitting && !micMuted && socketOpen) webSocket?.send(frame.toByteString()) },
        onLevel = { level -> _state.update { it.copy(voiceLevel = if (transmitting && !micMuted) level else 0f) } }
    )

    // Device-TTS fallback, the counterpart of the browser speechSynthesis path:
    // speaks agent reply text when there is no synthesized audio (always the
    // case for the mock provider).
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    init {
        tts = TextToSpeech(context) { status -> ttsReady = status == TextToSpeech.SUCCESS }
        // Restore the persisted ride log so the conversation survives restarts,
        // seeding the turn counter past it so ids never collide (useHelmetAgent.ts).
        val restored = decodeStoredTranscript(prefs.getString(KEY_TRANSCRIPT_LOG, null))
        if (restored.isNotEmpty()) {
            transcriptTurn = restored.maxOf { it.id }
            _state.update { it.copy(transcript = restored) }
        }
    }

    // ---- public API --------------------------------------------------------

    /**
     * Activates hands-free: route audio, resolve location, open the relay, and
     * start the mic. `allowSelfSignedTls` opts into trusting the test server's
     * self-signed certificate for wss:// URLs. A non-empty `authToken` is sent
     * as the relay's `token` query parameter (server/auth.ts).
     */
    fun start(url: String, allowSelfSignedTls: Boolean, authToken: String = "") {
        if (_state.value.handsFree) return
        relayUrl = appendAuthToken(url, authToken)

        if (allowSelfSignedTls != allowSelfSigned) {
            allowSelfSigned = allowSelfSignedTls
            httpClient = buildHttpClient(allowSelfSigned)
        }

        intentionalClose = false
        reconnectAttempts = 0
        transmitting = true
        micMuted = false

        // In-helmet Bluetooth headset routing; playback follows the same path.
        val bluetoothRouted = audioRouter.startVoiceRouting()
        player.useVoiceCall = bluetoothRouted

        _state.update {
            it.copy(
                handsFree = true,
                turnState = TurnState.LISTENING,
                micMuted = false,
                bluetoothRouted = bluetoothRouted
            )
        }
        scope.launch {
            location = resolveLocation()
            connect()
            try {
                mic.start()
            } catch (error: Exception) {
                Log.w(TAG, "Mic start failed", error)
                _state.update { it.copy(statusText = "麦克风不可用，请检查录音权限") }
            }
        }
    }

    /** Deactivates hands-free: stop the mic, restore routing, close the relay. */
    fun stop() {
        if (!_state.value.handsFree) return
        transmitting = false
        micMuted = false
        intentionalClose = true
        reconnectJob?.cancel()
        webSocket?.send(AUDIO_STOP_EVENT)
        webSocket?.close(1000, "rider stopped")
        socketOpen = false
        webSocket = null
        mic.stop()
        tts?.stop()
        // Release (not just flush) so the next session can pick a new audio route.
        player.release()
        audioRouter.stopVoiceRouting()
        _state.update {
            it.copy(
                handsFree = false,
                connection = ConnectionState.OFFLINE,
                statusText = "离线",
                turnState = TurnState.IDLE,
                voiceLevel = 0f,
                micMuted = false,
                bluetoothRouted = false,
                hazardAlert = null
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

    /** Clears both the live transcript and its persisted copy (清空对话记录). */
    fun clearTranscript() {
        _state.update { it.copy(transcript = emptyList()) }
        persistedTranscriptSignature = null
        prefs.edit().remove(KEY_TRANSCRIPT_LOG).apply()
    }

    // ---- relay connection --------------------------------------------------

    private fun buildHttpClient(allowSelfSigned: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS)

        if (allowSelfSigned) {
            // Prototype-only: the Lightsail test relay uses a self-signed
            // certificate. This trust-all manager is gated behind an explicit
            // settings toggle and must never ship in a production build.
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

    private fun restartSession() {
        val socket = webSocket
        webSocket = null
        intentionalClose = true
        socket?.close(1000, "session restart")
        scope.launch {
            delay(150)
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

        val request = Request.Builder().url(relayUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(socket: WebSocket, response: Response) {
                if (socket !== webSocket) return
                reconnectAttempts = 0
                _state.update { it.copy(connection = ConnectionState.RELAY, statusText = "就绪") }
                val current = _state.value
                socket.send(
                    buildSessionStart(
                        voiceGender = current.voiceGender,
                        voicePersonality = current.voicePersonality,
                        rideMode = current.rideContext.mode,
                        scenario = current.rideContext.scenario,
                        lat = location?.first,
                        lon = location?.second,
                        memory = current.sessionMemory
                    )
                )
                // The guided tour lives in the provider instance, so a fresh session
                // must be told about it again (mirrors the web client's open handler).
                if (current.guidedDemo) socket.send(buildGuidedDemo(enabled = true))
                // Resume the audio stream if the rider was transmitting before a drop.
                if (transmitting) socket.send(AUDIO_START_EVENT)
                // Only now may mic frames flow: they are guaranteed to be queued
                // behind the session.start/audio.start just sent above.
                socketOpen = true
            }

            override fun onMessage(socket: WebSocket, text: String) {
                if (socket !== webSocket) return
                val event = runCatching { parseAgentEvent(text) }.getOrElse {
                    _state.update { state -> state.copy(statusText = "收到异常代理消息") }
                    return
                }
                handleEvent(event)
            }

            override fun onMessage(socket: WebSocket, bytes: ByteString) {
                if (socket !== webSocket) return
                // AudioTrack setup can throw (unsupported config / bad state); keep it
                // from escaping onto the reader thread and tearing down the listener.
                runCatching { player.play(bytes.toByteArray()) }
                    .onFailure { Log.w(TAG, "PCM playback failed", it) }
            }

            override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                handleSocketClosed(socket, code)
            }

            override fun onFailure(socket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Relay socket failure", t)
                handleSocketClosed(socket)
            }
        })
    }

    private fun handleSocketClosed(socket: WebSocket, closeCode: Int = 0) {
        // Ignore a socket already superseded by a newer one (e.g. a restart).
        if (webSocket != null && socket !== webSocket) return
        socketOpen = false
        webSocket = null
        if (intentionalClose) {
            if (_state.value.handsFree) return // restartSession() will reconnect
            _state.update { it.copy(connection = ConnectionState.OFFLINE, statusText = "离线") }
            return
        }

        // The relay closed an idle session to free its upstream slot. Stay
        // offline — the rider restarts hands-free when they actually need it.
        if (closeCode == IDLE_CLOSE_CODE) {
            reconnectAttempts = 0
            _state.update { it.copy(connection = ConnectionState.OFFLINE, statusText = "会话闲置已断开，请重新开启免提") }
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        reconnectAttempts += 1
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts = 0
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
            is AgentEvent.SessionStarted -> _state.update {
                it.copy(
                    provider = event.provider,
                    isLive = event.mode != "mock",
                    capabilities = event.capabilities,
                    connection = ConnectionState.READY,
                    statusText = if (event.mode == "mock") "模拟路线已启用" else "豆包实时语音在线"
                )
            }

            is AgentEvent.Connection -> _state.update {
                it.copy(connection = mapConnectionState(event.state, it.connection), statusText = event.detail)
            }

            is AgentEvent.Status -> _state.update {
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

            is AgentEvent.Transcript -> {
                // Barge-in: the rider talking always silences the agent.
                if (event.speaker == Speaker.RIDER) stopAgentSpeech()
                pushTranscript(event.speaker, event.text, event.final)
                val shouldSpeak = event.useBrowserSpeech ?: event.final
                if (event.speaker == Speaker.AGENT && shouldSpeak) speak(event.text)
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

            AgentEvent.Unhandled -> Unit
        }
    }

    /** Port of pushTranscript in src/main.tsx, including the dedupe rules. */
    private fun pushTranscript(speaker: Speaker, text: String, final: Boolean) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        val now = System.currentTimeMillis()
        val language = detectLanguage(clean)

        _state.update { state ->
            val items = state.transcript
            val last = items.lastOrNull()

            // Repeated agent line within the dedupe window → drop it.
            if (speaker == Speaker.AGENT && last?.speaker == Speaker.AGENT &&
                normalizeTranscriptText(last.text) == normalizeTranscriptText(clean) &&
                now - last.at < AGENT_DEDUPE_WINDOW_MS
            ) {
                return@update state
            }

            // Same speaker still mid-turn → update that entry in place.
            if (last != null && last.speaker == speaker && !last.final) {
                return@update state.copy(
                    transcript = items.dropLast(1) +
                        last.copy(at = now, text = clean, final = final, language = language)
                )
            }

            // New turn: finalize any dangling in-progress entry, then append.
            val finalized = if (last != null && !last.final) {
                items.dropLast(1) + last.copy(final = true)
            } else {
                items
            }
            transcriptTurn += 1
            state.copy(
                transcript = finalized + TranscriptItem(transcriptTurn, now, speaker, clean, final, language)
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
        val finals = _state.value.transcript.filter { it.final }.takeLast(TRANSCRIPT_CAP)
        val signature = finals.size to (finals.lastOrNull()?.id ?: 0)
        if (signature == persistedTranscriptSignature) return
        persistedTranscriptSignature = signature
        prefs.edit().putString(KEY_TRANSCRIPT_LOG, encodeStoredTranscript(finals)).apply()
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
        speak("${alert.message} ${alert.advice}")
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

    private fun speak(text: String) {
        val engine = tts ?: return
        if (!ttsReady || text.isBlank()) return
        engine.language = if (detectLanguage(text) == "zh") Locale.SIMPLIFIED_CHINESE else Locale.US
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "max-reply")
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
