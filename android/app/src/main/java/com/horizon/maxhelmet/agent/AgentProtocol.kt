package com.horizon.maxhelmet.agent

import org.json.JSONObject
import java.text.Normalizer

// ============================================================
// /agent relay protocol — the Android counterpart of shared/agent.ts plus the
// pure helpers in src/main.tsx and shared/language.ts. The relay speaks JSON
// events both ways and binary PCM16 audio frames (16 kHz up, 24 kHz down).
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
    val language: String
)

data class Weather(
    val description: String,
    val temperatureC: Int,
    val windSpeedKmh: Int,
    val isDay: Boolean,
    val riskLevel: String,
    val riderAdvice: String
)

data class Telemetry(
    val asrMs: Int,
    val thinkMs: Int,
    val firstAudioMs: Int,
    val totalMs: Int
)

/** Server → client JSON events (shared/agent.ts AgentEvent). */
sealed interface AgentEvent {
    data class SessionStarted(val provider: String, val mode: String) : AgentEvent
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
    data class TelemetryUpdate(val telemetry: Telemetry) : AgentEvent
    data class ErrorEvent(val message: String) : AgentEvent

    /** Events the voice-first HUD does not render yet (ride.context, session.memory, …). */
    data object Unhandled : AgentEvent
}

fun parseAgentEvent(text: String): AgentEvent {
    val json = JSONObject(text)
    return when (json.optString("type")) {
        "session.started" -> AgentEvent.SessionStarted(
            provider = json.optString("provider", "unknown"),
            mode = json.optString("mode", "mock")
        )

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
                riskLevel = json.optString("riskLevel", "normal"),
                riderAdvice = json.optString("riderAdvice", "天气风险较低，保持正常安全骑行。")
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

        "error" -> AgentEvent.ErrorEvent(json.optString("message", "Voice relay failed"))

        else -> AgentEvent.Unhandled
    }
}

/** Client → server session.start payload (validated by server/session-controller.ts). */
fun buildSessionStart(voiceGender: VoiceGender, lat: Double?, lon: Double?): String =
    JSONObject().apply {
        put("type", "session.start")
        put("sampleRate", MicStreamer.SAMPLE_RATE)
        put("channels", 1)
        put("voiceGender", voiceGender.wire)
        if (lat != null && lon != null) {
            put("lat", lat)
            put("lon", lon)
        }
    }.toString()

const val AUDIO_START_EVENT = """{"type":"audio.start"}"""
const val AUDIO_STOP_EVENT = """{"type":"audio.stop"}"""

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
