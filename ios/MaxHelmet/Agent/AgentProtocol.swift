import Foundation

// ============================================================
// /agent relay protocol — the iOS counterpart of shared/agent.ts,
// shared/ride.ts, and the pure helpers in src/main.tsx and
// shared/language.ts. Mirrors android/.../agent/AgentProtocol.kt.
// The relay speaks JSON events both ways and binary PCM16 audio
// frames (16 kHz up, 24 kHz down).
// ============================================================

/// Mirror of ConnectionState in shared/agent.ts.
enum ConnectionState: Equatable {
    case offline, connecting, relay, provider, ready, degraded
}

/// Conversational state of the hands-free session, driven by server events.
/// Hashable so it can key the turn-caption table in the HUD.
enum TurnState: Hashable {
    case idle, listening, hearing, thinking, speaking
}

enum VoiceGender: String, CaseIterable {
    case female, male

    var wire: String { rawValue }
    var label: String { self == .female ? "女声" : "男声" }
}

/// Mirror of VoicePersonality in shared/agent.ts, labels from the web HUD.
enum VoicePersonality: String, CaseIterable {
    case concise, friendly, technical, rally

    var wire: String { rawValue }
    var label: String {
        switch self {
        case .concise: return "极简"
        case .friendly: return "友好"
        case .technical: return "技术"
        case .rally: return "领航"
        }
    }
}

/// Hazard levels with the web HUD's labels and rider actions
/// (HAZARD_LABELS / HAZARD_ACTIONS in src/main.tsx). The `severity`
/// ordinal encodes severity so `combineHazardLevels` can compare.
enum HazardLevel: Int, CaseIterable {
    case normal = 0, caution = 1, critical = 2

    var wire: String {
        switch self {
        case .normal: return "normal"
        case .caution: return "caution"
        case .critical: return "critical"
        }
    }

    var label: String {
        switch self {
        case .normal: return "稳定"
        case .caution: return "注意"
        case .critical: return "高风险"
        }
    }

    var riderAction: String {
        switch self {
        case .normal: return "保持节奏，专注下一步提示"
        case .caution: return "放缓一点，扩大车距"
        case .critical: return "优先靠边，确认安全"
        }
    }

    static func fromWire(_ value: String) -> HazardLevel {
        allCases.first { $0.wire == value } ?? .normal
    }
}

/// Mirror of RideMode in shared/ride.ts, in the web HUD's display order.
enum RideMode: String, CaseIterable {
    case ride, navigation, stop, emergency

    var wire: String { rawValue }
    var label: String {
        switch self {
        case .ride: return "骑行"
        case .navigation: return "导航"
        case .stop: return "停车"
        case .emergency: return "紧急"
        }
    }

    static func fromWire(_ value: String) -> RideMode {
        allCases.first { $0.wire == value } ?? .navigation
    }
}

/// Mirror of DemoScenario in shared/ride.ts, with SCENARIO_HAZARDS from src/main.tsx.
enum DemoScenario: String, CaseIterable {
    case commute, wind, fuel, group, emergency, adas

    var wire: String { rawValue }
    var label: String {
        switch self {
        case .commute: return "通勤"
        case .wind: return "横风"
        case .fuel: return "低油"
        case .group: return "小队"
        case .emergency: return "紧急"
        case .adas: return "ADAS"
        }
    }

    var hazard: HazardLevel {
        switch self {
        case .commute, .fuel, .group: return .normal
        case .wind, .adas: return .caution
        case .emergency: return .critical
        }
    }

    static func fromWire(_ value: String) -> DemoScenario {
        allCases.first { $0.wire == value } ?? .commute
    }
}

/// Port of combineHazardLevels in shared/ride.ts — returns the more severe level.
func combineHazardLevels(_ first: HazardLevel, _ second: HazardLevel) -> HazardLevel {
    first.rawValue >= second.rawValue ? first : second
}

/// Port of scenarioDefaultMode in shared/ride.ts.
func scenarioDefaultMode(_ scenario: DemoScenario) -> RideMode {
    switch scenario {
    case .emergency: return .emergency
    case .commute, .fuel: return .navigation
    default: return .ride
    }
}

/// Hazard a ride mode contributes on its own (setRideMode in src/main.tsx).
func rideModeHazard(_ mode: RideMode) -> HazardLevel {
    switch mode {
    case .emergency: return .critical
    case .navigation: return .caution
    default: return .normal
    }
}

/// Mirror of NETWORK_LABELS in src/main.tsx.
func networkLabel(_ network: String) -> String {
    switch network {
    case "online": return "在线"
    case "degraded": return "弱网"
    default: return "离线"
    }
}

/// Mirror of RESPONSE_MODE_LABELS in src/main.tsx.
func responseModeLabel(_ responseMode: String) -> String {
    switch responseMode {
    case "normal": return "正常"
    case "emergency": return "紧急"
    default: return "极简"
    }
}

enum Speaker: String, Codable {
    case rider, agent

    var wire: String { rawValue }

    static func fromWire(_ value: String) -> Speaker {
        value == Speaker.rider.wire ? .rider : .agent
    }
}

/// Codable so AgentSession can persist the recent final turns across launches.
struct TranscriptItem: Identifiable, Equatable, Codable {
    let id: Int
    /// Optional only so transcripts persisted by older app builds still decode.
    var turnId: String? = nil
    var deliveryId: String? = nil
    var at: Date
    let speaker: Speaker
    var text: String
    var final: Bool
    var language: String
    /// Reason the tester flagged this turn as bad (mirrors the web client's
    /// TranscriptItem.feedback); optional so older persisted logs still decode.
    var feedback: String? = nil
}

/// Preset turn-feedback reasons — single tap, no typing mid-ride. Mirrors
/// TURN_FLAG_REASONS in src/App.tsx; the string lands on the relay-side turn
/// and in the admin session replay.
let turnFlagReasons = ["听错了", "回答不对", "太慢", "不安全"]

struct Weather: Equatable {
    let description: String
    let temperatureC: Int
    let windSpeedKmh: Int
    let isDay: Bool
    let riskLevel: HazardLevel
    let riderAdvice: String
}

struct Telemetry: Equatable {
    let asrMs: Int
    let thinkMs: Int
    let firstAudioMs: Int
    let totalMs: Int
}

/// Mirror of ProviderCapabilities in shared/agent.ts, carried by session.started.
/// Defaults match the web's DEFAULT_CAPABILITIES (all off).
struct ProviderCapabilities: Equatable {
    var serverVad: Bool = false
    var synthesizedAudio: Bool = false
    var transcriptEvents: Bool = false
    var bargeIn: Bool = false
    var voiceSelection: Bool = false
    var weatherContext: Bool = false
    var sessionMemory: Bool = false
    var emergencyMode: Bool = false
}

/// Mirror of the ride.context event payload / DEFAULT_RIDE_CONTEXT in src/main.tsx.
struct RideContext: Equatable {
    var mode: RideMode = .navigation
    var modeLabel: String = "导航"
    var scenario: DemoScenario = .commute
    var scenarioLabel: String = "通勤"
    var speedKmh: Int = 0
    var routePhase: String = "等待骑行上下文"
    var network: String = "offline"
    var batteryPct: Int = 0
    var hazardLevel: HazardLevel = .normal
    var glanceableFocus: String = "下一步提示"
}

/// Mirror of the session.memory event payload / DEFAULT_MEMORY in src/main.tsx.
struct SessionMemory: Equatable {
    var language: String = "zh"
    var destination: String? = nil
    var lastIntent: String? = nil
    var responseMode: String = "concise"
}

/// Server → client JSON events (shared/agent.ts AgentEvent).
/// A proactive ADAS safety alert (`hazard.alert`). Mirrors shared/adas.ts.
struct HazardAlert: Equatable {
    let threat: String
    let direction: String
    let severity: HazardLevel
    let label: String
    let message: String
    let advice: String
    let ttcSeconds: Int
    let interrupt: Bool

    /// Chinese label for the threat direction.
    var directionLabel: String {
        switch direction {
        case "front": return "前方"
        case "rear": return "后方"
        case "left": return "左侧"
        case "right": return "右侧"
        case "left_rear": return "左后方"
        case "right_rear": return "右后方"
        default: return ""
        }
    }
}

enum AgentEvent {
    case sessionStarted(provider: String, mode: String, capabilities: ProviderCapabilities)
    case connection(state: String, detail: String)
    case status(state: String, detail: String)
    case transcript(turnId: String, deliveryId: String, speaker: Speaker, text: String, final: Bool, useBrowserSpeech: Bool?)
    case metric(latencyMs: Int)
    case weatherUpdate(Weather)
    case rideContextUpdate(RideContext)
    case sessionMemoryUpdate(SessionMemory)
    case telemetryUpdate(Telemetry)
    case hazardAlert(HazardAlert)
    case error(message: String)
    /// Event types this client does not consume.
    case unhandled
}

/// Parses a server JSON event string. Returns `.unhandled` for unknown types and
/// throws only when the payload is not valid JSON (the caller treats that as an error).
func parseAgentEvent(_ text: String) -> AgentEvent {
    guard let data = text.data(using: .utf8),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        return .unhandled
    }
    let type = json["type"] as? String ?? ""
    guard let requiredFields = serverEventRequiredFields[type],
          requiredFields.allSatisfy({ json[$0] != nil }) else { return .unhandled }

    func str(_ key: String, _ fallback: String = "") -> String { json[key] as? String ?? fallback }
    func int(_ key: String, _ fallback: Int = 0) -> Int {
        if let n = json[key] as? Int { return n }
        if let d = json[key] as? Double { return Int(d) }
        return fallback
    }
    func bool(_ key: String, _ fallback: Bool) -> Bool { json[key] as? Bool ?? fallback }

    switch type {
    case ServerEventTypes.sessionStarted:
        let caps = json["capabilities"] as? [String: Any] ?? [:]
        return .sessionStarted(
            provider: str("provider", "unknown"),
            mode: str("mode", "mock"),
            capabilities: ProviderCapabilities(
                serverVad: caps["serverVad"] as? Bool ?? false,
                synthesizedAudio: caps["synthesizedAudio"] as? Bool ?? false,
                transcriptEvents: caps["transcriptEvents"] as? Bool ?? false,
                bargeIn: caps["bargeIn"] as? Bool ?? false,
                voiceSelection: caps["voiceSelection"] as? Bool ?? false,
                weatherContext: caps["weatherContext"] as? Bool ?? false,
                sessionMemory: caps["sessionMemory"] as? Bool ?? false,
                emergencyMode: caps["emergencyMode"] as? Bool ?? false
            )
        )

    case ServerEventTypes.connection:
        return .connection(state: str("state"), detail: str("detail"))

    case ServerEventTypes.status:
        return .status(state: str("state"), detail: str("detail"))

    case ServerEventTypes.transcript:
        let useBrowserSpeech = json.keys.contains("useBrowserSpeech") ? bool("useBrowserSpeech", false) : nil
        return .transcript(
            turnId: str("turnId"),
            deliveryId: str("deliveryId"),
            speaker: Speaker.fromWire(str("speaker")),
            text: str("text"),
            final: bool("final", true),
            useBrowserSpeech: useBrowserSpeech
        )

    case ServerEventTypes.metric:
        return .metric(latencyMs: int("latencyMs"))

    case ServerEventTypes.weather:
        return .weatherUpdate(Weather(
            description: str("description"),
            temperatureC: int("temperatureC"),
            windSpeedKmh: int("windSpeedKmh"),
            isDay: bool("isDay", true),
            riskLevel: HazardLevel.fromWire(str("riskLevel", "normal")),
            riderAdvice: str("riderAdvice", "天气风险较低，保持正常安全骑行。")
        ))

    case ServerEventTypes.rideContext:
        let mode = RideMode.fromWire(str("mode"))
        let scenario = DemoScenario.fromWire(str("scenario"))
        let routePhase = str("routePhase")
        let network = str("network")
        return .rideContextUpdate(RideContext(
            mode: mode,
            modeLabel: str("modeLabel", mode.label),
            scenario: scenario,
            scenarioLabel: str("scenarioLabel", scenario.label),
            speedKmh: int("speedKmh"),
            routePhase: routePhase.isEmpty ? "等待路线信息" : routePhase,
            network: network.isEmpty ? "online" : network,
            batteryPct: int("batteryPct"),
            hazardLevel: HazardLevel.fromWire(str("hazardLevel")),
            glanceableFocus: str("glanceableFocus")
        ))

    case ServerEventTypes.sessionMemory:
        let destination = str("destination")
        let lastIntent = str("lastIntent")
        let responseMode = str("responseMode")
        return .sessionMemoryUpdate(SessionMemory(
            language: str("language", "zh"),
            destination: destination.isEmpty ? nil : destination,
            lastIntent: lastIntent.isEmpty ? nil : lastIntent,
            responseMode: responseMode.isEmpty ? "concise" : responseMode
        ))

    case ServerEventTypes.telemetry:
        return .telemetryUpdate(Telemetry(
            asrMs: max(0, int("asrMs")),
            thinkMs: max(0, int("thinkMs")),
            firstAudioMs: max(0, int("firstAudioMs")),
            totalMs: max(0, int("totalMs"))
        ))

    case ServerEventTypes.hazardAlert:
        return .hazardAlert(HazardAlert(
            threat: str("threat"),
            direction: str("direction"),
            severity: HazardLevel.fromWire(str("severity", "caution")),
            label: str("label"),
            message: str("message"),
            advice: str("advice"),
            ttcSeconds: int("ttcSeconds"),
            interrupt: bool("interrupt", true)
        ))

    case ServerEventTypes.error:
        return .error(message: str("message", "Voice relay failed"))

    default:
        return .unhandled
    }
}

/// Client → server session.start payload (validated by server/session-controller.ts).
func buildSessionStart(
    voiceGender: VoiceGender,
    voicePersonality: VoicePersonality,
    rideMode: RideMode,
    scenario: DemoScenario,
    lat: Double?,
    lon: Double?,
    testerId: String? = nil,
    testerRegion: String? = nil,
    testingCampaignId: String = "release-readiness",
    testingTestCaseId: String = "baseline-live-session",
    testingRunId: String? = nil,
    testingAssignmentId: String? = nil,
    appVersion: String? = nil,
    gitCommit: String? = nil,
    deviceLabel: String? = nil,
    browserLanguage: String? = nil,
    networkType: String? = nil,
    memory: SessionMemory? = nil
) -> String {
    var payload: [String: Any] = [
        "type": "session.start",
        "sampleRate": MicStreamer.sampleRate,
        "channels": 1,
        "voiceGender": voiceGender.wire,
        "voicePersonality": voicePersonality.wire,
        "rideMode": rideMode.wire,
        "scenario": scenario.wire,
        "testingCampaignId": testingCampaignId,
        "testingTestCaseId": testingTestCaseId
    ]
    if let testerId, !testerId.isEmpty { payload["testerId"] = testerId }
    if let testerRegion, !testerRegion.isEmpty { payload["testerRegion"] = testerRegion }
    if let testingRunId, !testingRunId.isEmpty { payload["testingRunId"] = testingRunId }
    if let testingAssignmentId, !testingAssignmentId.isEmpty { payload["testingAssignmentId"] = testingAssignmentId }
    if let appVersion, !appVersion.isEmpty { payload["appVersion"] = appVersion }
    if let gitCommit, !gitCommit.isEmpty { payload["gitCommit"] = gitCommit }
    if let deviceLabel, !deviceLabel.isEmpty { payload["deviceLabel"] = deviceLabel }
    if let browserLanguage, !browserLanguage.isEmpty { payload["browserLanguage"] = browserLanguage }
    if let networkType, !networkType.isEmpty { payload["networkType"] = networkType }
    payload["platform"] = "ios"
    if let lat, let lon {
        payload["lat"] = lat
        payload["lon"] = lon
    }
    // Echo the last session.memory snapshot so a settings-change restart keeps
    // the agent's short-term memory (shared/agent.ts SessionMemorySnapshot).
    if let memory {
        var snapshot: [String: Any] = [
            "language": memory.language,
            "responseMode": memory.responseMode
        ]
        if let destination = memory.destination { snapshot["destination"] = destination }
        if let lastIntent = memory.lastIntent { snapshot["lastIntent"] = lastIntent }
        payload["memory"] = snapshot
    }
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}

/// Guided-demo toggle (mock provider tours the scenario catalog hands-off).
func buildGuidedDemo(enabled: Bool) -> String {
    #"{"type":"demo.guided","enabled":\#(enabled)}"#
}

/// Client → server turn.feedback: the tester flags a bad transcript turn
/// (validated by server/session-controller.ts; the relay matches the turn by
/// speaker + text and attaches the reason for the admin session replay).
func buildTurnFeedback(turnId: String, speaker: Speaker, text: String, reason: String) -> String {
    let payload: [String: Any] = [
        "type": ClientEventTypes.turnFeedback,
        "turnId": turnId,
        "speaker": speaker.wire,
        "text": text,
        "reason": reason
    ]
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}

let audioStartEvent = #"{"type":"audio.start"}"#
let audioStopEvent = #"{"type":"audio.stop"}"#

/// Port of mapTurnState in src/main.tsx — unknown states keep the previous one.
func mapTurnState(_ state: String, previous: TurnState) -> TurnState {
    switch state {
    case "listening", "ready": return .listening
    case "hearing", "asr": return .hearing
    case "thinking": return .thinking
    case "speaking": return .speaking
    case "closed": return .idle
    default: return previous
    }
}

/// Maps a server connection-state string to ConnectionState; unknown keeps the previous.
func mapConnectionState(_ state: String, previous: ConnectionState) -> ConnectionState {
    switch state {
    case "offline": return .offline
    case "connecting": return .connecting
    case "relay": return .relay
    case "provider": return .provider
    case "ready": return .ready
    case "degraded": return .degraded
    default: return previous
    }
}

/// Port of detectLanguage in shared/language.ts — any Han character means Chinese.
func detectLanguage(_ text: String) -> String {
    for scalar in text.unicodeScalars where isHan(scalar) {
        return "zh"
    }
    return "en"
}

/// CJK Unified Ideographs ranges, matching Character.UnicodeScript.HAN coverage
/// used by the Android port and the \p{Han} test in shared/language.ts.
private func isHan(_ scalar: Unicode.Scalar) -> Bool {
    let v = scalar.value
    return (0x4E00...0x9FFF).contains(v) ||   // CJK Unified Ideographs
        (0x3400...0x4DBF).contains(v) ||       // Extension A
        (0x20000...0x2A6DF).contains(v) ||     // Extension B
        (0x2A700...0x2EBEF).contains(v) ||     // Extensions C–F
        (0xF900...0xFAFF).contains(v) ||       // Compatibility Ideographs
        (0x2F800...0x2FA1F).contains(v)        // Compatibility Supplement
}

/// Port of normalizeTranscriptText in src/main.tsx (and server/providers/doubao.ts):
/// NFKC-normalize, lowercase, and keep only letters and digits (Han characters are
/// letters), so repeated agent lines can be deduplicated.
func normalizeTranscriptText(_ text: String) -> String {
    let normalized = text.precomposedStringWithCompatibilityMapping.lowercased()
    var result = String.UnicodeScalarView()
    for scalar in normalized.unicodeScalars {
        if CharacterSet.alphanumerics.contains(scalar) {
            result.append(scalar)
        }
    }
    return String(result)
}

/// Port of exportTranscriptLog in src/main.tsx — builds the export JSON payload.
func buildTranscriptExportJSON(_ items: [TranscriptItem]) -> String {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    iso.timeZone = TimeZone(identifier: "UTC")

    let turns: [[String: Any]] = items.map { item in
        var turn: [String: Any] = [
            "id": item.id,
            "at": iso.string(from: item.at),
            "speaker": item.speaker.wire,
            "language": item.language,
            "final": item.final,
            "text": item.text
        ]
        if let turnId = item.turnId { turn["turnId"] = turnId }
        if let deliveryId = item.deliveryId { turn["deliveryId"] = deliveryId }
        return turn
    }
    let payload: [String: Any] = [
        "exportedAt": iso.string(from: Date()),
        "turns": turns
    ]
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}
