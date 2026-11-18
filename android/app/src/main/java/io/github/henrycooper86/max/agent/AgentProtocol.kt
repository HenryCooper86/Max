package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.navigation.LatLon
import io.github.henrycooper86.max.navigation.ManeuverStep
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

enum class VoiceGender(val wire: String, private val text: Str) {
    FEMALE("female", Str.GENDER_FEMALE),
    MALE("male", Str.GENDER_MALE);

    val label: String get() = tr(text)
}

/** Mirror of VoicePersonality in shared/agent.ts, labels from the web HUD. */
enum class VoicePersonality(val wire: String, private val text: Str) {
    CONCISE("concise", Str.TONE_CONCISE),
    FRIENDLY("friendly", Str.TONE_FRIENDLY),
    TECHNICAL("technical", Str.TONE_TECHNICAL),
    RALLY("rally", Str.TONE_RALLY);

    val label: String get() = tr(text)
}

/**
 * Hazard levels with the web HUD's labels and rider actions
 * (HAZARD_LABELS / HAZARD_ACTIONS in src/main.tsx). Ordinal order encodes
 * severity so combineHazardLevels can compare.
 */
enum class HazardLevel(val wire: String, private val text: Str, private val action: Str) {
    NORMAL("normal", Str.HZ_NORMAL, Str.HZ_NORMAL_ACTION),
    CAUTION("caution", Str.RISK_CAUTION, Str.HZ_CAUTION_ACTION),
    CRITICAL("critical", Str.RISK_HIGH, Str.HZ_CRITICAL_ACTION);

    val label: String get() = tr(text)
    val riderAction: String get() = tr(action)

    companion object {
        fun fromWire(value: String): HazardLevel = entries.firstOrNull { it.wire == value } ?: NORMAL
    }
}

/** Mirror of RideMode in shared/ride.ts, in the web HUD's display order. */
enum class RideMode(val wire: String, private val text: Str) {
    RIDE("ride", Str.MODE_RIDE),
    NAVIGATION("navigation", Str.MODE_NAV),
    STOP("stop", Str.MODE_STOP),
    EMERGENCY("emergency", Str.MODE_EMERGENCY);

    val label: String get() = tr(text)

    companion object {
        fun fromWire(value: String): RideMode = entries.firstOrNull { it.wire == value } ?: NAVIGATION
    }
}

/** Mirror of DemoScenario in shared/ride.ts, with SCENARIO_HAZARDS from src/main.tsx. */
enum class DemoScenario(val wire: String, private val text: Str?, val hazard: HazardLevel) {
    COMMUTE("commute", Str.SC_COMMUTE, HazardLevel.NORMAL),
    WIND("wind", Str.SC_WIND, HazardLevel.CAUTION),
    FUEL("fuel", Str.SC_FUEL, HazardLevel.NORMAL),
    GROUP("group", Str.SC_GROUP, HazardLevel.NORMAL),
    EMERGENCY("emergency", Str.MODE_EMERGENCY, HazardLevel.CRITICAL),
    ADAS("adas", null, HazardLevel.CAUTION);

    val label: String get() = text?.let { tr(it) } ?: "ADAS"

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
    "online" -> tr(Str.NET_ONLINE)
    "degraded" -> tr(Str.NET_WEAK)
    else -> tr(Str.CONN_OFFLINE)
}

/** Mirror of RESPONSE_MODE_LABELS in src/main.tsx. */
fun responseModeLabel(responseMode: String): String = when (responseMode) {
    "normal" -> tr(Str.RISK_NORMAL)
    "emergency" -> tr(Str.MODE_EMERGENCY)
    else -> tr(Str.TONE_CONCISE)
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
    val turnId: String? = null,
    val deliveryId: String? = null,
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
    val modeLabel: String = tr(Str.MODE_NAV),
    val scenario: DemoScenario = DemoScenario.COMMUTE,
    val scenarioLabel: String = tr(Str.SC_COMMUTE),
    val speedKmh: Int = 0,
    val routePhase: String = tr(Str.WAITING_RIDE_CONTEXT),
    val network: String = "offline",
    val batteryPct: Int = 0,
    val hazardLevel: HazardLevel = HazardLevel.NORMAL,
    val glanceableFocus: String = tr(Str.NEXT_PROMPT)
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
        val turnId: String,
        val deliveryId: String,
        val speaker: Speaker,
        val text: String,
        val final: Boolean,
        val useBrowserSpeech: Boolean?
    ) : AgentEvent

    /** Null means a packet-counter update, not a new first-audio measurement. */
    data class Metric(val latencyMs: Int?) : AgentEvent
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
                "front" -> tr(Str.DIR_FRONT)
                "rear" -> tr(Str.DIR_REAR)
                "left" -> tr(Str.DIR_LEFT)
                "right" -> tr(Str.DIR_RIGHT)
                "left_rear" -> tr(Str.DIR_LEFT_REAR)
                "right_rear" -> tr(Str.DIR_RIGHT_REAR)
                else -> ""
            }
    }

    data class ErrorEvent(val message: String) : AgentEvent

    /** Server → client: execute one device action. `commandId` is relay-issued
     *  and must be echoed back in the matching device.result. `query` is the
     *  navigation.start destination phrase (args.query); null for actions
     *  (like navigation.stop) that carry none. */
    data class DeviceCommand(
        val commandId: String,
        val action: String,
        val query: String?,
        val args: Map<String, Any?> = emptyMap()
    ) : AgentEvent

    /** Server → client: the relay resolved a nav.request into a route. */
    data class NavRoute(val data: NavRouteData) : AgentEvent

    /** Server → client: the relay could not resolve or route a nav.request. */
    data class CrashAck(val incidentId: String, val status: String, val detail: String?) : AgentEvent
    data object CrashSimulate : AgentEvent
    data class NavError(val commandId: String, val code: String) : AgentEvent

    /** Event types this client does not consume. */
    data object Unhandled : AgentEvent
}

/**
 * Server → client nav.route payload (shared/agent.ts NavRouteEvent). Every
 * coordinate is GCJ-02 exactly as received — never converted at this layer,
 * that edge belongs to CoordinateDatum at the location source — and
 * `ManeuverStep.alongRouteMeters` is cumulative from the route start, parsed
 * straight through with no arithmetic.
 */
data class NavRouteData(
    val commandId: String,
    val destinationName: String,
    val destination: LatLon,
    val polyline: List<LatLon>,
    val steps: List<ManeuverStep>,
    val distanceMeters: Double,
    val etaSeconds: Double
)

fun parseAgentEvent(text: String): AgentEvent {
    val json = JSONObject(text)
    val type = json.optString("type")
    val requiredFields = SERVER_EVENT_REQUIRED_FIELDS[type] ?: return AgentEvent.Unhandled
    if (requiredFields.any { !json.has(it) }) return AgentEvent.Unhandled
    return when (type) {
        "crash.ack" -> AgentEvent.CrashAck(json.optString("incidentId"), json.optString("status"), json.optString("detail").ifEmpty { null })
        "crash.simulate" -> AgentEvent.CrashSimulate
        ServerEventTypes.SESSION_STARTED -> {
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

        ServerEventTypes.CONNECTION -> AgentEvent.Connection(json.optString("state"), json.optString("detail"))

        ServerEventTypes.STATUS -> AgentEvent.Status(json.optString("state"), json.optString("detail"))

        ServerEventTypes.TRANSCRIPT -> AgentEvent.Transcript(
            turnId = json.optString("turnId"),
            deliveryId = json.optString("deliveryId"),
            speaker = Speaker.fromWire(json.optString("speaker")),
            text = json.optString("text"),
            final = json.optBoolean("final", true),
            useBrowserSpeech = if (json.has("useBrowserSpeech")) json.optBoolean("useBrowserSpeech") else null
        )

        ServerEventTypes.METRIC -> {
            val latency = json.optInt("latencyMs")
            val packetCounterOnly = latency == 0 && (json.has("outgoingFps") || json.has("droppedFrames"))
            AgentEvent.Metric(if (packetCounterOnly) null else latency)
        }

        ServerEventTypes.WEATHER -> AgentEvent.WeatherUpdate(
            Weather(
                description = json.optString("description"),
                temperatureC = json.optInt("temperatureC"),
                windSpeedKmh = json.optInt("windSpeedKmh"),
                isDay = json.optBoolean("isDay", true),
                riskLevel = HazardLevel.fromWire(json.optString("riskLevel", "normal")),
                riderAdvice = json.optString("riderAdvice", tr(Str.WEATHER_LOW_RISK))
            )
        )

        ServerEventTypes.RIDE_CONTEXT -> {
            val mode = RideMode.fromWire(json.optString("mode"))
            val scenario = DemoScenario.fromWire(json.optString("scenario"))
            AgentEvent.RideContextUpdate(
                RideContext(
                    mode = mode,
                    modeLabel = json.optString("modeLabel").ifEmpty { mode.label },
                    scenario = scenario,
                    scenarioLabel = json.optString("scenarioLabel").ifEmpty { scenario.label },
                    speedKmh = json.optInt("speedKmh", 0),
                    routePhase = json.optString("routePhase").ifEmpty { tr(Str.WAITING_ROUTE) },
                    network = json.optString("network").ifEmpty { "online" },
                    batteryPct = json.optInt("batteryPct", 0),
                    hazardLevel = HazardLevel.fromWire(json.optString("hazardLevel")),
                    glanceableFocus = json.optString("glanceableFocus")
                )
            )
        }

        ServerEventTypes.SESSION_MEMORY -> AgentEvent.SessionMemoryUpdate(
            SessionMemory(
                language = json.optString("language", "zh"),
                destination = json.optString("destination").takeIf { it.isNotEmpty() },
                lastIntent = json.optString("lastIntent").takeIf { it.isNotEmpty() },
                responseMode = json.optString("responseMode").ifEmpty { "concise" }
            )
        )

        ServerEventTypes.TELEMETRY -> AgentEvent.TelemetryUpdate(
            Telemetry(
                asrMs = maxOf(0, json.optInt("asrMs")),
                thinkMs = maxOf(0, json.optInt("thinkMs")),
                firstAudioMs = maxOf(0, json.optInt("firstAudioMs")),
                totalMs = maxOf(0, json.optInt("totalMs"))
            )
        )

        ServerEventTypes.HAZARD_ALERT -> AgentEvent.HazardAlert(
            threat = json.optString("threat"),
            direction = json.optString("direction"),
            severity = HazardLevel.fromWire(json.optString("severity", "caution")),
            label = json.optString("label"),
            message = json.optString("message"),
            advice = json.optString("advice"),
            ttcSeconds = json.optInt("ttcSeconds"),
            interrupt = json.optBoolean("interrupt", true)
        )

        ServerEventTypes.ERROR -> AgentEvent.ErrorEvent(json.optString("message", "Voice relay failed"))

        ServerEventTypes.DEVICE_COMMAND -> {
            val args = json.optJSONObject("args") ?: JSONObject()
            AgentEvent.DeviceCommand(
                commandId = json.optString("commandId"),
                action = json.optString("action"),
                query = args.optString("query").ifEmpty { null },
                args = args.keys().asSequence().associateWith { key -> args.opt(key).takeUnless { it == JSONObject.NULL } }
            )
        }

        ServerEventTypes.NAV_ROUTE -> {
            val destination = json.optJSONObject("destination")?.let(::parseLatLon) ?: return AgentEvent.Unhandled
            val polyline = json.optJSONArray("polyline")?.let(::parsePolyline) ?: return AgentEvent.Unhandled
            val steps = json.optJSONArray("steps")?.let(::parseManeuverSteps) ?: return AgentEvent.Unhandled
            val distanceMeters = (json.opt("distanceMeters") as? Number)?.toDouble() ?: return AgentEvent.Unhandled
            val etaSeconds = (json.opt("etaSeconds") as? Number)?.toDouble() ?: return AgentEvent.Unhandled
            AgentEvent.NavRoute(
                NavRouteData(
                    commandId = json.optString("commandId"),
                    destinationName = json.optString("destinationName"),
                    destination = destination,
                    polyline = polyline,
                    steps = steps,
                    distanceMeters = distanceMeters,
                    etaSeconds = etaSeconds
                )
            )
        }

        ServerEventTypes.NAV_ERROR -> AgentEvent.NavError(
            commandId = json.optString("commandId"),
            code = json.optString("code")
        )

        else -> AgentEvent.Unhandled
    }
}

/**
 * Parses a `{lat, lon}` object into a GCJ-02 LatLon; null when either field is
 * missing or not a number, so a malformed nav.* coordinate fails the parse
 * instead of silently becoming 0,0.
 */
private fun parseLatLon(json: JSONObject): LatLon? {
    val lat = json.opt("lat") as? Number ?: return null
    val lon = json.opt("lon") as? Number ?: return null
    return LatLon(lat.toDouble(), lon.toDouble())
}

/** Parses a nav.route `polyline` array; null if any entry is malformed. */
private fun parsePolyline(array: JSONArray): List<LatLon>? {
    val points = ArrayList<LatLon>(array.length())
    for (index in 0 until array.length()) {
        val point = array.optJSONObject(index) ?: return null
        points.add(parseLatLon(point) ?: return null)
    }
    return points
}

/**
 * Parses a nav.route `steps` array into ManeuverStep, preserving the wire's
 * cumulative alongRouteMeters verbatim; null if any entry is malformed.
 */
private fun parseManeuverSteps(array: JSONArray): List<ManeuverStep>? {
    val steps = ArrayList<ManeuverStep>(array.length())
    for (index in 0 until array.length()) {
        val step = array.optJSONObject(index) ?: return null
        val coordinate = parseLatLon(step) ?: return null
        val alongRouteMeters = (step.opt("alongRouteMeters") as? Number)?.toDouble() ?: return null
        steps.add(
            ManeuverStep(
                step.optString("instruction"), coordinate, alongRouteMeters,
                localizedInstruction = step.optString("localizedInstruction").trim().takeIf { it.isNotEmpty() }
            )
        )
    }
    return steps
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
    memory: SessionMemory? = null,
    voiceProvider: String? = null,
    /** The app's effective language, "zh" or "en"; the key is omitted when null so older relays are unaffected. */
    language: String? = null
): String =
    JSONObject().apply {
        put("type", "session.start")
        put("sampleRate", MicStreamer.SAMPLE_RATE)
        put("channels", 1)
        put("voiceGender", voiceGender.wire)
        put("voicePersonality", voicePersonality.wire)
        put("rideMode", rideMode.wire)
        put("scenario", scenario.wire)
        voiceProvider?.takeIf { it.isNotBlank() }?.let { put("voiceProvider", it) }
        language?.takeIf { it == "zh" || it == "en" }?.let { put("language", it) }
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
fun buildTurnFeedback(turnId: String, speaker: Speaker, text: String, reason: String): String =
    JSONObject().apply {
        put("type", ClientEventTypes.TURN_FEEDBACK)
        put("turnId", turnId)
        put("speaker", speaker.wire)
        put("text", text)
        put("reason", reason)
    }.toString()

/**
 * Client → server nav.request: ask the relay to route the rider (shared/agent.ts
 * NavRequestEvent). `reason == "start"` carries the spoken destination `query`
 * and omits `destination`/`destinationName`; `reason == "reroute"` carries the
 * previously announced `destination`/`destinationName` and omits `query`.
 * `originLat`/`originLon` (and destination, when present) are GCJ-02.
 */
fun buildNavRequest(
    commandId: String,
    reason: String,
    originLat: Double,
    originLon: Double,
    query: String? = null,
    destinationLat: Double? = null,
    destinationLon: Double? = null,
    destinationName: String? = null
): String =
    JSONObject().apply {
        put("type", ClientEventTypes.NAV_REQUEST)
        put("commandId", commandId)
        put("reason", reason)
        put(
            "origin",
            JSONObject().apply {
                put("lat", originLat)
                put("lon", originLon)
            }
        )
        if (query != null) put("query", query)
        if (destinationLat != null && destinationLon != null) {
            put(
                "destination",
                JSONObject().apply {
                    put("lat", destinationLat)
                    put("lon", destinationLon)
                }
            )
        }
        if (destinationName != null) put("destinationName", destinationName)
    }.toString()

/**
 * Client → server device.result: the outcome of one device.command, echoing
 * its commandId (shared/agent.ts DeviceResultEvent). `reason` and `detail`
 * are each omitted when null — mirrors iOS's `DeviceActionResult` (a
 * user-facing elaboration on `reason`, e.g. nav-first-fix-retry's
 * "还没定位到，到室外或空旷处再说一次。" alongside "route.unavailable").
 */
fun buildDeviceResult(commandId: String, status: String, reason: String? = null, detail: String? = null): String =
    JSONObject().apply {
        put("type", ClientEventTypes.DEVICE_RESULT)
        put("commandId", commandId)
        put("status", status)
        if (reason != null) put("reason", reason)
        if (detail != null) put("detail", detail)
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
    // Query parameters must precede a URL fragment. Appending after `#…` makes
    // the token client-side-only, so the relay receives an unauthenticated URL.
    val fragmentIndex = url.indexOf('#')
    val base = if (fragmentIndex >= 0) url.substring(0, fragmentIndex) else url
    val fragment = if (fragmentIndex >= 0) url.substring(fragmentIndex) else ""
    // Replace, never duplicate: a pasted relay URL may already carry ?token=.
    val stripped = base
        .replace(Regex("([?&])token=[^&#]*&"), "$1")
        .replace(Regex("[?&]token=[^&#]*"), "")
    val separator = if ('?' in stripped) '&' else '?'
    return stripped + separator + "token=" + URLEncoder.encode(clean, "UTF-8") + fragment
}

/** Serializes finished turns for SharedPreferences (saveStoredTranscript in src/lib/persistence.ts). */
fun encodeStoredTranscript(items: List<TranscriptItem>): String {
    val array = JSONArray()
    items.forEach { item ->
        array.put(
            JSONObject().apply {
                put("id", item.id)
                item.turnId?.let { put("turnId", it) }
                item.deliveryId?.let { put("deliveryId", it) }
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
                turnId = json.optString("turnId").ifEmpty { null },
                deliveryId = json.optString("deliveryId").ifEmpty { null },
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
                item.turnId?.let { put("turnId", it) }
                item.deliveryId?.let { put("deliveryId", it) }
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
