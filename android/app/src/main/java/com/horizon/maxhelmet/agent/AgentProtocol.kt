package com.horizon.maxhelmet.agent

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.text.Normalizer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ============================================================
// /agent relay protocol — the Android counterpart of shared/agent.ts,
// shared/ride.ts, and the pure helpers in src/main.tsx and shared/language.ts.
// The relay speaks JSON events both ways and binary PCM16 audio frames
// (16 kHz up, 24 kHz down).
// ============================================================

/** Mirror of ConnectionState in shared/agent.ts. */
enum class ConnectionState {
    OFFLINE, CONNECTING, RELAY, PROVIDER, READY, DEGRADED
}

/** Conversational state of the hands-free session, driven by server events. */
enum class TurnState {
    IDLE, LISTENING, HEARING, THINKING, SPEAKING
}

enum class VoiceGender(val wire: String, val label: String) {
    FEMALE("female", "女声"),
    MALE("male", "男声")
}

/** Mirror of VoicePersonality in shared/agent.ts, labels from the web HUD. */
enum class VoicePersonality(val wire: String, val label: String) {
    CONCISE("concise", "极简"),
    FRIENDLY("friendly", "友好"),
    TECHNICAL("technical", "技术"),
    RALLY("rally", "领航")
}

/**
 * Hazard levels with the web HUD's labels and rider actions
 * (HAZARD_LABELS / HAZARD_ACTIONS in src/main.tsx). Ordinal order encodes
 * severity so combineHazardLevels can compare.
 */
enum class HazardLevel(val wire: String, val label: String, val riderAction: String) {
    NORMAL("normal", "稳定", "保持节奏，专注下一步提示"),
    CAUTION("caution", "注意", "放缓一点，扩大车距"),
    CRITICAL("critical", "高风险", "优先靠边，确认安全");

    companion object {
        fun fromWire(value: String): HazardLevel = entries.firstOrNull { it.wire == value } ?: NORMAL
    }
}

/** Mirror of RideMode in shared/ride.ts, in the web HUD's display order. */
enum class RideMode(val wire: String, val label: String) {
    RIDE("ride", "骑行"),
    NAVIGATION("navigation", "导航"),
    STOP("stop", "停车"),
    EMERGENCY("emergency", "紧急");

    companion object {
        fun fromWire(value: String): RideMode = entries.firstOrNull { it.wire == value } ?: NAVIGATION
    }
}

/** Mirror of DemoScenario in shared/ride.ts, with SCENARIO_HAZARDS from src/main.tsx. */
enum class DemoScenario(val wire: String, val label: String, val hazard: HazardLevel) {
    COMMUTE("commute", "通勤", HazardLevel.NORMAL),
    WIND("wind", "横风", HazardLevel.CAUTION),
    FUEL("fuel", "低油", HazardLevel.NORMAL),
    GROUP("group", "小队", HazardLevel.NORMAL),
    EMERGENCY("emergency", "紧急", HazardLevel.CRITICAL),
    ADAS("adas", "ADAS", HazardLevel.CAUTION);

    companion object {
        fun fromWire(value: String): DemoScenario = entries.firstOrNull { it.wire == value } ?: COMMUTE
    }
}

/** Port of combineHazardLevels in shared/ride.ts — returns the more severe level. */
fun combineHazardLevels(first: HazardLevel, second: HazardLevel): HazardLevel =
    if (first.ordinal >= second.ordinal) first else second

/** Port of scenarioDefaultMode in shared/ride.ts. */
fun scenarioDefaultMode(scenario: DemoScenario): RideMode = when (scenario) {
    DemoScenario.EMERGENCY -> RideMode.EMERGENCY
    DemoScenario.COMMUTE, DemoScenario.FUEL -> RideMode.NAVIGATION
    else -> RideMode.RIDE
}

/** Hazard a ride mode contributes on its own (setRideMode in src/main.tsx). */
fun rideModeHazard(mode: RideMode): HazardLevel = when (mode) {
    RideMode.EMERGENCY -> HazardLevel.CRITICAL
    RideMode.NAVIGATION -> HazardLevel.CAUTION
    else -> HazardLevel.NORMAL
}

/** Mirror of NETWORK_LABELS in src/main.tsx. */
fun networkLabel(network: String): String = when (network) {
    "online" -> "在线"
    "degraded" -> "弱网"
    else -> "离线"
}

/** Mirror of RESPONSE_MODE_LABELS in src/main.tsx. */
fun responseModeLabel(responseMode: String): String = when (responseMode) {
    "normal" -> "正常"
    "emergency" -> "紧急"
    else -> "极简"
}

enum class Speaker(val wire: String) {
    RIDER("rider"),
    AGENT("agent");

    companion object {
        fun fromWire(value: String): Speaker = if (value == RIDER.wire) RIDER else AGENT
    }
}

data class TranscriptItem(
    val id: Int,
    val at: Long,
    val speaker: Speaker,
    val text: String,
    val final: Boolean,
    val language: String,
    /** Reason the tester flagged this turn as bad (mirrors the web client's
     *  TranscriptItem.feedback); null = not flagged. */
    val feedback: String? = null
)

/**
 * Preset turn-feedback reasons — single tap, no typing mid-ride. Mirrors
 * TURN_FLAG_REASONS in src/App.tsx; the string lands on the relay-side turn
 * and in the admin session replay.
 */
val TURN_FLAG_REASONS = listOf("听错了", "回答不对", "太慢", "不安全")

data class Weather(
    val description: String,
    val temperatureC: Int,
    val windSpeedKmh: Int,
    val isDay: Boolean,
    val riskLevel: HazardLevel,
    val riderAdvice: String
)

data class Telemetry(
    val asrMs: Int,
    val thinkMs: Int,
    val firstAudioMs: Int,
    val totalMs: Int
)

/**
 * Mirror of ProviderCapabilities in shared/agent.ts, carried by session.started.
 * Defaults match the web's DEFAULT_CAPABILITIES (all off).
 */
data class ProviderCapabilities(
    val serverVad: Boolean = false,
    val synthesizedAudio: Boolean = false,
    val transcriptEvents: Boolean = false,
    val bargeIn: Boolean = false,
    val voiceSelection: Boolean = false,
    val weatherContext: Boolean = false,
    val sessionMemory: Boolean = false,
    val emergencyMode: Boolean = false
)

/** Mirror of the ride.context event payload / DEFAULT_RIDE_CONTEXT in src/main.tsx. */
data class RideContext(
    val mode: RideMode = RideMode.NAVIGATION,
    val modeLabel: String = "导航",
    val scenario: DemoScenario = DemoScenario.COMMUTE,
    val scenarioLabel: String = "通勤",
    val speedKmh: Int = 0,
    val routePhase: String = "等待骑行上下文",
    val network: String = "offline",
    val batteryPct: Int = 0,
    val hazardLevel: HazardLevel = HazardLevel.NORMAL,
    val glanceableFocus: String = "下一步提示"
)

/** Mirror of the session.memory event payload / DEFAULT_MEMORY in src/main.tsx. */
data class SessionMemory(
    val language: String = "zh",
    val destination: String? = null,
    val lastIntent: String? = null,
    val responseMode: String = "concise"
)

/** Server → client JSON events (shared/agent.ts AgentEvent). */
sealed interface AgentEvent {
    data class SessionStarted(val provider: String, val mode: String, val capabilities: ProviderCapabilities) : AgentEvent
    data class Connection(val state: String, val detail: String) : AgentEvent
    data class Status(val state: String, val detail: String) : AgentEvent
    data class Transcript(
        val speaker: Speaker,
        val text: String,
        val final: Boolean,
        val useBrowserSpeech: Boolean?
    ) : AgentEvent

    data class Metric(val latencyMs: Int) : AgentEvent
    data class WeatherUpdate(val weather: Weather) : AgentEvent
    data class RideContextUpdate(val rideContext: RideContext) : AgentEvent
    data class SessionMemoryUpdate(val memory: SessionMemory) : AgentEvent
    data class TelemetryUpdate(val telemetry: Telemetry) : AgentEvent

    /** A proactive ADAS safety alert (shared/adas.ts). */
    data class HazardAlert(
        val threat: String,
        val direction: String,
        val severity: HazardLevel,
        val label: String,
        val message: String,
        val advice: String,
        val ttcSeconds: Int,
        val interrupt: Boolean
    ) : AgentEvent {
        /** Chinese label for the threat direction. */
        val directionLabel: String
            get() = when (direction) {
                "front" -> "前方"
                "rear" -> "后方"
                "left" -> "左侧"
                "right" -> "右侧"
                "left_rear" -> "左后方"
                "right_rear" -> "右后方"
                else -> ""
            }
    }

    data class ErrorEvent(val message: String) : AgentEvent

    /** Event types this client does not consume. */
    data object Unhandled : AgentEvent
}

fun parseAgentEvent(text: String): AgentEvent {
    val json = JSONObject(text)
    return when (json.optString("type")) {
        "session.started" -> {
            val caps = json.optJSONObject("capabilities")
            AgentEvent.SessionStarted(
                provider = json.optString("provider", "unknown"),
                mode = json.optString("mode", "mock"),
                capabilities = ProviderCapabilities(
                    serverVad = caps?.optBoolean("serverVad", false) ?: false,
                    synthesizedAudio = caps?.optBoolean("synthesizedAudio", false) ?: false,
                    transcriptEvents = caps?.optBoolean("transcriptEvents", false) ?: false,
                    bargeIn = caps?.optBoolean("bargeIn", false) ?: false,
                    voiceSelection = caps?.optBoolean("voiceSelection", false) ?: false,
                    weatherContext = caps?.optBoolean("weatherContext", false) ?: false,
                    sessionMemory = caps?.optBoolean("sessionMemory", false) ?: false,
                    emergencyMode = caps?.optBoolean("emergencyMode", false) ?: false
                )
            )
        }

        "connection" -> AgentEvent.Connection(json.optString("state"), json.optString("detail"))

        "status" -> AgentEvent.Status(json.optString("state"), json.optString("detail"))

        "transcript" -> AgentEvent.Transcript(
            speaker = Speaker.fromWire(json.optString("speaker")),
            text = json.optString("text"),
            final = json.optBoolean("final", true),
            useBrowserSpeech = if (json.has("useBrowserSpeech")) json.optBoolean("useBrowserSpeech") else null
        )

        "metric" -> AgentEvent.Metric(json.optInt("latencyMs"))

        "weather" -> AgentEvent.WeatherUpdate(
            Weather(
                description = json.optString("description"),
                temperatureC = json.optInt("temperatureC"),
                windSpeedKmh = json.optInt("windSpeedKmh"),
                isDay = json.optBoolean("isDay", true),
                riskLevel = HazardLevel.fromWire(json.optString("riskLevel", "normal")),
                riderAdvice = json.optString("riderAdvice", "天气风险较低，保持正常安全骑行。")
            )
        )

        "ride.context" -> {
            val mode = RideMode.fromWire(json.optString("mode"))
            val scenario = DemoScenario.fromWire(json.optString("scenario"))
            AgentEvent.RideContextUpdate(
                RideContext(
                    mode = mode,
                    modeLabel = json.optString("modeLabel").ifEmpty { mode.label },
                    scenario = scenario,
                    scenarioLabel = json.optString("scenarioLabel").ifEmpty { scenario.label },
                    speedKmh = json.optInt("speedKmh", 0),
                    routePhase = json.optString("routePhase").ifEmpty { "等待路线信息" },
                    network = json.optString("network").ifEmpty { "online" },
                    batteryPct = json.optInt("batteryPct", 0),
                    hazardLevel = HazardLevel.fromWire(json.optString("hazardLevel")),
                    glanceableFocus = json.optString("glanceableFocus")
                )
            )
        }

        "session.memory" -> AgentEvent.SessionMemoryUpdate(
            SessionMemory(
                language = json.optString("language", "zh"),
                destination = json.optString("destination").takeIf { it.isNotEmpty() },
                lastIntent = json.optString("lastIntent").takeIf { it.isNotEmpty() },
                responseMode = json.optString("responseMode").ifEmpty { "concise" }
            )
        )

        "telemetry" -> AgentEvent.TelemetryUpdate(
            Telemetry(
                asrMs = maxOf(0, json.optInt("asrMs")),
                thinkMs = maxOf(0, json.optInt("thinkMs")),
                firstAudioMs = maxOf(0, json.optInt("firstAudioMs")),
                totalMs = maxOf(0, json.optInt("totalMs"))
            )
        )

        "hazard.alert" -> AgentEvent.HazardAlert(
            threat = json.optString("threat"),
            direction = json.optString("direction"),
            severity = HazardLevel.fromWire(json.optString("severity", "caution")),
            label = json.optString("label"),
            message = json.optString("message"),
            advice = json.optString("advice"),
            ttcSeconds = json.optInt("ttcSeconds"),
            interrupt = json.optBoolean("interrupt", true)
        )

        "error" -> AgentEvent.ErrorEvent(json.optString("message", "Voice relay failed"))

        else -> AgentEvent.Unhandled
    }
}

/** Client → server session.start payload (validated by server/session-controller.ts). */
fun buildSessionStart(
    voiceGender: VoiceGender,
    voicePersonality: VoicePersonality,
    rideMode: RideMode,
    scenario: DemoScenario,
    lat: Double?,
    lon: Double?,
    testerId: String? = null,
    testerRegion: String? = null,
    testingCampaignId: String = "release-readiness",
    testingTestCaseId: String = "baseline-live-session",
    testingRunId: String? = null,
    testingAssignmentId: String? = null,
    appVersion: String? = null,
    gitCommit: String? = null,
    deviceLabel: String? = null,
    browserLanguage: String? = null,
    networkType: String? = null,
    memory: SessionMemory? = null
): String =
    JSONObject().apply {
        put("type", "session.start")
        put("sampleRate", MicStreamer.SAMPLE_RATE)
        put("channels", 1)
        put("voiceGender", voiceGender.wire)
        put("voicePersonality", voicePersonality.wire)
        put("rideMode", rideMode.wire)
        put("scenario", scenario.wire)
        testerId?.takeIf { it.isNotBlank() }?.let { put("testerId", it) }
        testerRegion?.takeIf { it.isNotBlank() }?.let { put("testerRegion", it) }
        put("testingCampaignId", testingCampaignId)
        put("testingTestCaseId", testingTestCaseId)
        testingRunId?.takeIf { it.isNotBlank() }?.let { put("testingRunId", it) }
        testingAssignmentId?.takeIf { it.isNotBlank() }?.let { put("testingAssignmentId", it) }
        appVersion?.takeIf { it.isNotBlank() }?.let { put("appVersion", it) }
        gitCommit?.takeIf { it.isNotBlank() }?.let { put("gitCommit", it) }
        deviceLabel?.takeIf { it.isNotBlank() }?.let { put("deviceLabel", it) }
        browserLanguage?.takeIf { it.isNotBlank() }?.let { put("browserLanguage", it) }
        networkType?.takeIf { it.isNotBlank() }?.let { put("networkType", it) }
        put("platform", "android")
        if (lat != null && lon != null) {
            put("lat", lat)
            put("lon", lon)
        }
        // Echo the last session.memory snapshot so a settings-change restart
        // keeps the agent's short-term memory (shared/agent.ts SessionMemorySnapshot).
        if (memory != null) {
            put(
                "memory",
                JSONObject().apply {
                    put("language", memory.language)
                    put("responseMode", memory.responseMode)
                    memory.destination?.let { put("destination", it) }
                    memory.lastIntent?.let { put("lastIntent", it) }
                }
            )
        }
    }.toString()

/** Guided-demo toggle (mock provider tours the scenario catalog hands-off). */
fun buildGuidedDemo(enabled: Boolean): String = """{"type":"demo.guided","enabled":$enabled}"""

/**
 * Client → server turn.feedback: the tester flags a bad transcript turn
 * (validated by server/session-controller.ts; the relay matches the turn by
 * speaker + text and attaches the reason for the admin session replay).
 */
fun buildTurnFeedback(speaker: Speaker, text: String, reason: String): String =
    JSONObject().apply {
        put("type", "turn.feedback")
        put("speaker", speaker.wire)
        put("text", text)
        put("reason", reason)
    }.toString()

const val AUDIO_START_EVENT = """{"type":"audio.start"}"""
const val AUDIO_STOP_EVENT = """{"type":"audio.stop"}"""

/**
 * Appends the optional relay auth token as a `token` query parameter
 * (buildAgentUrl in src/lib/utils.ts). Handles a URL that already has a query.
 */
fun appendAuthToken(url: String, token: String): String {
    val clean = token.trim()
    if (clean.isEmpty()) return url
    // Replace, never duplicate: a pasted relay URL may already carry ?token=.
    val stripped = url
        .replace(Regex("([?&])token=[^&#]*&"), "$1")
        .replace(Regex("[?&]token=[^&#]*"), "")
    val separator = if ('?' in stripped) '&' else '?'
    return stripped + separator + "token=" + URLEncoder.encode(clean, "UTF-8")
}

/** Serializes finished turns for SharedPreferences (saveStoredTranscript in src/lib/persistence.ts). */
fun encodeStoredTranscript(items: List<TranscriptItem>): String {
    val array = JSONArray()
    items.forEach { item ->
        array.put(
            JSONObject().apply {
                put("id", item.id)
                put("at", item.at)
                put("speaker", item.speaker.wire)
                put("language", item.language)
                put("text", item.text)
                item.feedback?.let { put("feedback", it) }
            }
        )
    }
    return array.toString()
}

/**
 * Restores persisted turns (loadStoredTranscript in src/lib/persistence.ts).
 * Anything restored is by definition a finished turn, so `final` is true.
 * Best-effort: malformed storage yields an empty log, never a crash.
 */
fun decodeStoredTranscript(raw: String?): List<TranscriptItem> {
    if (raw.isNullOrEmpty()) return emptyList()
    return runCatching {
        val array = JSONArray(raw)
        (0 until array.length()).mapNotNull { index ->
            val json = array.optJSONObject(index) ?: return@mapNotNull null
            val text = json.optString("text")
            if (text.isEmpty()) return@mapNotNull null
            TranscriptItem(
                id = json.optInt("id"),
                at = json.optLong("at"),
                speaker = Speaker.fromWire(json.optString("speaker")),
                text = text,
                final = true,
                language = json.optString("language").ifEmpty { detectLanguage(text) },
                feedback = json.optString("feedback").ifEmpty { null }
            )
        }
    }.getOrElse { emptyList() }
}

/** Port of mapTurnState in src/main.tsx — unknown states keep the previous one. */
fun mapTurnState(state: String, previous: TurnState): TurnState = when (state) {
    "listening", "ready" -> TurnState.LISTENING
    "hearing", "asr" -> TurnState.HEARING
    "thinking" -> TurnState.THINKING
    "speaking" -> TurnState.SPEAKING
    "closed" -> TurnState.IDLE
    else -> previous
}

/** Maps a server connection-state string to ConnectionState; unknown keeps the previous. */
fun mapConnectionState(state: String, previous: ConnectionState): ConnectionState = when (state) {
    "offline" -> ConnectionState.OFFLINE
    "connecting" -> ConnectionState.CONNECTING
    "relay" -> ConnectionState.RELAY
    "provider" -> ConnectionState.PROVIDER
    "ready" -> ConnectionState.READY
    "degraded" -> ConnectionState.DEGRADED
    else -> previous
}

/** Port of detectLanguage in shared/language.ts — any Han character means Chinese. */
fun detectLanguage(text: String): String {
    val hasHan = text.codePoints().anyMatch { codePoint ->
        Character.UnicodeScript.of(codePoint) == Character.UnicodeScript.HAN
    }
    return if (hasHan) "zh" else "en"
}

/**
 * Port of normalizeTranscriptText in src/main.tsx (and server/providers/doubao.ts):
 * NFKC-normalize, lowercase, and keep only letters, digits, and Han characters,
 * so repeated agent lines can be deduplicated.
 */
fun normalizeTranscriptText(text: String): String {
    val normalized = Normalizer.normalize(text, Normalizer.Form.NFKC).lowercase()
    val builder = StringBuilder()
    normalized.codePoints().forEach { codePoint ->
        if (Character.isLetterOrDigit(codePoint)) builder.appendCodePoint(codePoint)
    }
    return builder.toString()
}

/** Port of exportTranscriptLog in src/main.tsx — builds the export JSON payload. */
fun buildTranscriptExportJson(items: List<TranscriptItem>): String {
    val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    val turns = JSONArray()
    items.forEach { item ->
        turns.put(
            JSONObject().apply {
                put("id", item.id)
                put("at", isoFormat.format(Date(item.at)))
                put("speaker", item.speaker.wire)
                put("language", item.language)
                put("final", item.final)
                put("text", item.text)
            }
        )
    }
    return JSONObject().apply {
        put("exportedAt", isoFormat.format(Date()))
        put("turns", turns)
    }.toString(2)
}
