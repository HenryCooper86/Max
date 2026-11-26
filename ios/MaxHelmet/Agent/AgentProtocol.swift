import CoreLocation
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
    var label: String { self == .female ? L("voice.female") : L("voice.male") }
}

/// Mirror of VoicePersonality in shared/agent.ts, labels from the web HUD.
enum VoicePersonality: String, CaseIterable {
    case concise, friendly, technical, rally

    var wire: String { rawValue }
    var label: String {
        switch self {
        case .concise: return L("persona.concise")
        case .friendly: return L("persona.friendly")
        case .technical: return L("persona.technical")
        case .rally: return L("persona.rally")
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
        case .normal: return L("hazard.label.normal")
        case .caution: return L("hazard.label.caution")
        case .critical: return L("hazard.label.critical")
        }
    }

    var riderAction: String {
        switch self {
        case .normal: return L("hazard.action.normal")
        case .caution: return L("hazard.action.caution")
        case .critical: return L("hazard.action.critical")
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
        case .ride: return L("mode.ride")
        case .navigation: return L("mode.navigation")
        case .stop: return L("mode.stop")
        case .emergency: return L("mode.emergency")
        }
    }

    static func fromWire(_ value: String) -> RideMode {
        allCases.first { $0.wire == value } ?? .navigation
    }
}

/// Mirror of DemoScenario in shared/ride.ts, with SCENARIO_HAZARDS from src/main.tsx.
enum DemoScenario: String, CaseIterable {
    case commute, wind, fuel, group, emergency, adas, crash

    var wire: String { rawValue }
    var label: String {
        switch self {
        case .commute: return L("scenario.commute")
        case .wind: return L("scenario.wind")
        case .fuel: return L("scenario.fuel")
        case .group: return L("scenario.group")
        case .emergency: return L("scenario.emergency")
        case .adas: return L("scenario.adas")
        case .crash: return L("scenario.crash")
        }
    }

    var hazard: HazardLevel {
        switch self {
        case .commute, .fuel, .group: return .normal
        case .wind, .adas: return .caution
        case .emergency, .crash: return .critical
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
    case .emergency, .crash: return .emergency
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
    case "online": return L("network.online")
    case "degraded": return L("network.degraded")
    default: return L("network.offline")
    }
}

/// Mirror of RESPONSE_MODE_LABELS in src/main.tsx.
func responseModeLabel(_ responseMode: String) -> String {
    switch responseMode {
    case "normal": return L("response.normal")
    case "emergency": return L("response.emergency")
    default: return L("response.concise")
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

/// The reason as shown to the wearer. The wire value stays Chinese (it lands on
/// the relay-side turn and in the admin replay); only the display is localised.
func turnFlagReasonLabel(_ reason: String) -> String {
    switch reason {
    case "听错了": return L("flag.mishear")
    case "回答不对": return L("flag.wrong")
    case "太慢": return L("flag.slow")
    case "不安全": return L("flag.unsafe")
    default: return reason
    }
}

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
    /// The backend runs relay-side tools (weather lookups and the like). Absent
    /// on relays older than tool support, so it reads as false there.
    var tools: Bool = false
    /// The backend accepts typed `text.input` turns. Doubao and the original
    /// helmet demo do not; absent on older relays.
    var textInput: Bool = false
    /// The backend takes pictures (`image.input`). Absent on relays older
    /// than image input, so it reads as false there.
    var imageInput: Bool = false
    /// The session takes live video (`video.frame`). Absent on relays older
    /// than live video, so it reads as false there.
    var videoInput: Bool = false
}

/// Mirror of the ride.context event payload / DEFAULT_RIDE_CONTEXT in src/main.tsx.
struct RideContext: Equatable {
    var mode: RideMode = .navigation
    var modeLabel: String = L("mode.navigation")
    var scenario: DemoScenario = .commute
    var scenarioLabel: String = L("scenario.commute")
    /// nil when the relay left the field out, which every live backend does;
    /// only the mock demo sends a number. Never read an absent value as 0.
    var speedKmh: Int? = nil
    var routePhase: String = L("ride.default.routePhase")
    var network: String = "offline"
    var batteryPct: Int = 0
    var hazardLevel: HazardLevel = .normal
    var glanceableFocus: String = L("ride.default.focus")
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
        case "front", "rear", "left", "right", "left_rear", "right_rear": return L("hazard.dir." + direction)
        default: return ""
        }
    }
}

enum CrashAckStatus: String {
    case notified, failed, unconfigured
    /// Unknown outcomes read as failure — Max must never claim success it wasn't told about.
    static func fromWire(_ raw: String) -> CrashAckStatus { CrashAckStatus(rawValue: raw) ?? .failed }
}

enum DeviceActionTier: String, Equatable {
    case low, high
}

enum MusicControl: String, Equatable {
    case play, pause, next, previous
}

enum VolumeDirection: String, Equatable {
    case up, down
}

/// One executable device action. Typed rather than a raw dictionary so the
/// router's dispatch is exhaustive and every case is Equatable in tests.
enum DeviceAction: Equatable {
    case torchSet(on: Bool)
    case volumeSet(direction: VolumeDirection)
    case musicControl(control: MusicControl, app: String?)
    case smsCompose(name: String, body: String)
    case callDial(name: String?, number: String?)
    case destinationShow(query: String)
    case cameraPhoto
    case cameraRecord(start: Bool)
    case galleryOpen
    case galleryDescribe(kind: String, question: String?)
    case navigationStart(query: String)
    case navigationStop
}

struct DeviceCommand: Equatable {
    let commandId: String
    let action: DeviceAction
    let tier: DeviceActionTier
}

enum DeviceActionStatus: String, Equatable {
    case ok, failed, denied, unsupported
}

/// Every handler returns exactly one of these. There is no "no result" case —
/// the relay treats silence as a failure after 8 s.
struct DeviceActionResult: Equatable {
    let status: DeviceActionStatus
    let reason: String?
    let detail: String?

    static let ok = DeviceActionResult(status: .ok, reason: nil, detail: nil)
    static func failed(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .failed, reason: reason, detail: detail)
    }
    static func denied(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .denied, reason: reason, detail: detail)
    }
    static func unsupported(_ reason: String, _ detail: String? = nil) -> DeviceActionResult {
        DeviceActionResult(status: .unsupported, reason: reason, detail: detail)
    }
}

/// Server → client: the relay resolved a `nav.request` into a route. Every
/// coordinate here is GCJ-02 exactly as received — WGS-84 conversion is the
/// map layer's job (Task 4's edge), not this parsing layer's.
struct NavRouteData: Equatable {
    let commandId: String
    let destinationName: String
    let destination: CLLocationCoordinate2D
    let polyline: [CLLocationCoordinate2D]
    let steps: [ManeuverStep]
    let distanceMeters: Double
    let etaSeconds: Double

    static func == (lhs: NavRouteData, rhs: NavRouteData) -> Bool {
        lhs.commandId == rhs.commandId
            && lhs.destinationName == rhs.destinationName
            && coordinatesEqual(lhs.destination, rhs.destination)
            && lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy { coordinatesEqual($0, $1) }
            && lhs.steps == rhs.steps
            && lhs.distanceMeters == rhs.distanceMeters
            && lhs.etaSeconds == rhs.etaSeconds
    }
}

enum AgentEvent {
    /// `resume` is the relay's id for the conversation, to send back on a reconnect; nil on
    /// relays older than resumption. `relayProtocol` is the relay's wire protocol version; nil
    /// on relays older than the version handshake.
    case sessionStarted(provider: String, mode: String, capabilities: ProviderCapabilities, resume: String?, relayProtocol: Int?)
    case connection(state: String, detail: String)
    case status(state: String, detail: String)
    case transcript(turnId: String, deliveryId: String, speaker: Speaker, text: String, final: Bool, useBrowserSpeech: Bool?)
    case metric(latencyMs: Int)
    case weatherUpdate(Weather)
    case rideContextUpdate(RideContext)
    case sessionMemoryUpdate(SessionMemory)
    case telemetryUpdate(Telemetry)
    case hazardAlert(HazardAlert)
    case deviceCommand(DeviceCommand)
    /// A device.command this app cannot carry out as sent: an action it has never heard of
    /// (`action.unknown`), or a known one whose arguments it cannot read (`action.invalid`).
    /// The relay wants exactly one device.result either way, and counts silence as a failure.
    case unsupportedDeviceCommand(commandId: String, reason: String)
    case crashAck(incidentId: String, status: CrashAckStatus, detail: String?)
    case crashSimulate
    case error(message: String)
    case navRoute(NavRouteData)
    case navError(commandId: String, code: String)
    case toolActivity(ToolActivity)
    /// A client-tool call. This app declares no client tools, so one arriving
    /// is unexpected; it still gets the single answer the protocol requires.
    case toolCall(callId: String, name: String)
    /// The relay is ending the conversation and says why (docs/protocol.md, session.ended).
    case sessionEnded(reason: String)
    /// The conversation moved to another of the assistant's agents (docs/protocol.md, agent.changed).
    case agentChanged(agent: String)
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
    guard let requiredFields = serverEventRequiredFields[type] else { return .unhandled }
    // A device command is answered even when a required field is missing: the relay wants a
    // device.result for every command it issues, and counts silence as a failure.
    let skipsRequiredFields = type == ServerEventTypes.deviceCommand
    guard skipsRequiredFields || requiredFields.allSatisfy({ json[$0] != nil }) else { return .unhandled }

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
        // An id is only worth keeping if it can be sent back.
        let resume = json["resume"] as? String
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
                emergencyMode: caps["emergencyMode"] as? Bool ?? false,
                tools: caps["tools"] as? Bool ?? false,
                textInput: caps["textInput"] as? Bool ?? false,
                imageInput: caps["imageInput"] as? Bool ?? false,
                videoInput: caps["videoInput"] as? Bool ?? false
            ),
            resume: resume?.isEmpty == false ? resume : nil,
            relayProtocol: jsonInteger(json["protocol"])
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
            riderAdvice: str("riderAdvice", L("ride.default.advice"))
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
            speedKmh: relaySpeedKmh(json["speedKmh"]).map { Int($0.rounded()) },
            routePhase: routePhase.isEmpty ? L("ride.default.routePhase2") : routePhase,
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

    case ServerEventTypes.deviceCommand:
        // A command id the relay itself would refuse cannot be answered (its device.result check).
        let commandId = str("commandId")
        guard !commandId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, commandId.count <= 120 else {
            return .unhandled
        }
        let args = json["args"] as? [String: Any] ?? [:]
        switch parseDeviceAction(str("action"), args) {
        case let .action(action):
            return .deviceCommand(DeviceCommand(
                commandId: commandId,
                action: action,
                tier: DeviceActionTier(rawValue: str("tier", "low")) ?? .low
            ))
        case .unknownAction:
            return .unsupportedDeviceCommand(commandId: commandId, reason: "action.unknown")
        case .invalidArguments:
            return .unsupportedDeviceCommand(commandId: commandId, reason: "action.invalid")
        }

    case ServerEventTypes.error:
        return .error(message: str("message", "Voice relay failed"))

    case ServerEventTypes.crashAck:
        let detail = str("detail")
        return .crashAck(incidentId: str("incidentId"),
                         status: CrashAckStatus.fromWire(str("status")),
                         detail: detail.isEmpty ? nil : detail)

    case ServerEventTypes.crashSimulate:
        return .crashSimulate

    case ServerEventTypes.navRoute:
        guard let destination = parseCoordinateDict(json["destination"]),
              let polyline = parseCoordinateArray(json["polyline"]),
              let steps = parseManeuverSteps(json["steps"]),
              let distanceMeters = numberValue(json["distanceMeters"]),
              let etaSeconds = numberValue(json["etaSeconds"]) else {
            return .unhandled
        }
        return .navRoute(NavRouteData(
            commandId: str("commandId"),
            destinationName: str("destinationName"),
            destination: destination,
            polyline: polyline,
            steps: steps,
            distanceMeters: distanceMeters,
            etaSeconds: etaSeconds
        ))

    case ServerEventTypes.navError:
        return .navError(commandId: str("commandId"), code: str("code"))

    case ServerEventTypes.toolActivity:
        guard let state = ToolActivity.State(rawValue: str("state")) else { return .unhandled }
        return .toolActivity(ToolActivity(callId: str("callId"), name: str("name"), state: state))

    case ServerEventTypes.toolCall:
        return .toolCall(callId: str("callId"), name: str("name"))

    case ServerEventTypes.sessionEnded:
        return .sessionEnded(reason: str("reason", "ended"))

    case ServerEventTypes.agentChanged:
        guard let agent = json["agent"] as? String, !agent.isEmpty else { return .unhandled }
        return .agentChanged(agent: agent)

    default:
        return .unhandled
    }
}

/// Extracts a numeric JSON value regardless of whether JSONSerialization
/// produced it as an Int or a Double (a whole-number lat/lon like `31`
/// bridges differently than `31.2`), matching the `int(_:)` dual-check above.
private func numberValue(_ any: Any?) -> Double? {
    if let d = any as? Double { return d }
    if let n = any as? Int { return Double(n) }
    return nil
}

/// A JSON `true` or `false` and nothing else: JSONSerialization bridges the numbers 0 and 1 to
/// Bool as well, and a command's `on` or `start` must really be a boolean.
private func jsonBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

/// A JSON whole number and nothing else: `true` bridges to 1, and a fraction is no version.
private func jsonInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return Int(exactly: number.doubleValue)
}

/// Parses a `{lat, lon}` object into a coordinate; nil when either field is
/// missing or not numeric.
private func parseCoordinateDict(_ any: Any?) -> CLLocationCoordinate2D? {
    guard let dict = any as? [String: Any],
          let lat = numberValue(dict["lat"]),
          let lon = numberValue(dict["lon"]) else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
}

/// Parses a `nav.route` polyline array of `{lat, lon}` objects; nil if the
/// array is missing or any entry fails to parse — a corrupt point silently
/// truncating the route is worse than dropping the whole event.
private func parseCoordinateArray(_ any: Any?) -> [CLLocationCoordinate2D]? {
    guard let array = any as? [[String: Any]] else { return nil }
    var result: [CLLocationCoordinate2D] = []
    result.reserveCapacity(array.count)
    for item in array {
        guard let coordinate = parseCoordinateDict(item) else { return nil }
        result.append(coordinate)
    }
    return result
}

/// Parses a `nav.route` steps array of `{instruction, lat, lon, alongRouteMeters}`
/// objects; nil if the array is missing or any entry fails to parse.
private func parseManeuverSteps(_ any: Any?) -> [ManeuverStep]? {
    guard let array = any as? [[String: Any]] else { return nil }
    var result: [ManeuverStep] = []
    result.reserveCapacity(array.count)
    for item in array {
        guard let coordinate = parseCoordinateDict(item),
              let alongRouteMeters = numberValue(item["alongRouteMeters"]) else { return nil }
        result.append(ManeuverStep(
            instruction: item["instruction"] as? String ?? "",
            coordinate: coordinate,
            alongRouteMeters: alongRouteMeters,
            localizedInstruction: (item["localizedInstruction"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        ))
    }
    return result
}

/// The wire protocol this app speaks (PROTOCOL_VERSION in shared/agent.ts): sent as
/// session.start `protocol`, and compared with the relay's own in session.started.
let protocolVersion = 1

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
    memory: SessionMemory? = nil,
    voiceProvider: String? = nil,
    /// The app's effective language ("zh" / "en"); the key is omitted when nil.
    language: String? = nil,
    /// The relay's `session.started.resume` of the conversation being reconnected to
    /// (docs/protocol.md, Resuming); omitted when nil, so a new conversation starts fresh.
    resume: String? = nil
) -> String {
    var payload: [String: Any] = [
        "type": "session.start",
        // The relay logs a mismatch with its own version, and answers with it in session.started.
        "protocol": protocolVersion,
        "sampleRate": MicStreamer.sampleRate,
        "channels": 1,
        "voiceGender": voiceGender.wire,
        "voicePersonality": voicePersonality.wire,
        "rideMode": rideMode.wire,
        "scenario": scenario.wire,
        "testingCampaignId": testingCampaignId,
        "testingTestCaseId": testingTestCaseId
    ]
    if let voiceProvider, !voiceProvider.isEmpty { payload["voiceProvider"] = voiceProvider }
    if let language, !language.isEmpty { payload["language"] = language }
    if let testerId, !testerId.isEmpty { payload["testerId"] = testerId }
    if let testerRegion, !testerRegion.isEmpty { payload["testerRegion"] = testerRegion }
    if let testingRunId, !testingRunId.isEmpty { payload["testingRunId"] = testingRunId }
    if let testingAssignmentId, !testingAssignmentId.isEmpty { payload["testingAssignmentId"] = testingAssignmentId }
    if let appVersion, !appVersion.isEmpty { payload["appVersion"] = appVersion }
    if let gitCommit, !gitCommit.isEmpty { payload["gitCommit"] = gitCommit }
    if let deviceLabel, !deviceLabel.isEmpty { payload["deviceLabel"] = deviceLabel }
    if let browserLanguage, !browserLanguage.isEmpty { payload["browserLanguage"] = browserLanguage }
    if let networkType, !networkType.isEmpty { payload["networkType"] = networkType }
    // Only a reconnect carries the conversation on; the relay drops an id it cannot use.
    if let resume, !resume.isEmpty { payload["resume"] = resume }
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

/// What a device.command's action name and arguments parsed into.
enum DeviceCommandParse: Equatable {
    case action(DeviceAction)

    /// An action this app has never heard of, from a relay newer than it. A newer relay
    /// must never crash or stall an older client.
    case unknownAction

    /// A known action whose arguments are missing or of the wrong kind. Nothing is guessed:
    /// a torch asked to switch on with no `on` must not switch off, and a recording asked
    /// to start with no `start` must not stop.
    case invalidArguments
}

/// Maps the wire action name plus its args onto a typed DeviceAction, or says why it cannot.
func parseDeviceAction(_ name: String, _ args: [String: Any]) -> DeviceCommandParse {
    switch name {
    case "torch.set":
        guard let on = jsonBoolean(args["on"]) else { return .invalidArguments }
        return .action(.torchSet(on: on))
    case "volume.set":
        guard let raw = args["direction"] as? String,
              let direction = VolumeDirection(rawValue: raw) else { return .invalidArguments }
        return .action(.volumeSet(direction: direction))
    case "music.control":
        guard let raw = args["control"] as? String,
              let control = MusicControl(rawValue: raw) else { return .invalidArguments }
        // No app named means the rider's own player; a value of another kind is not a name.
        guard args["app"] == nil || args["app"] is String else { return .invalidArguments }
        return .action(.musicControl(control: control, app: args["app"] as? String))
    case "sms.compose":
        guard let recipient = args["name"] as? String, let body = args["body"] as? String else { return .invalidArguments }
        return .action(.smsCompose(name: recipient, body: body))
    case "call.dial":
        let name = args["name"] as? String
        let number = args["number"] as? String
        if name == nil && number == nil { return .invalidArguments }
        return .action(.callDial(name: name, number: number))
    case "destination.show":
        guard let query = args["query"] as? String, !query.isEmpty else { return .invalidArguments }
        return .action(.destinationShow(query: query))
    case "camera.photo":
        return .action(.cameraPhoto)
    case "camera.record":
        guard let start = jsonBoolean(args["start"]) else { return .invalidArguments }
        return .action(.cameraRecord(start: start))
    case "gallery.open":
        return .action(.galleryOpen)
    case "gallery.describe":
        // No kind named is the latest capture, the relay's own default.
        guard args["kind"] == nil || args["kind"] is String else { return .invalidArguments }
        let kind = args["kind"] as? String ?? "latest"
        guard ["latest", "photo", "video"].contains(kind) else { return .invalidArguments }
        return .action(.galleryDescribe(kind: kind, question: args["question"] as? String))
    case "navigation.start":
        guard let query = args["query"] as? String, !query.isEmpty else { return .invalidArguments }
        return .action(.navigationStart(query: query))
    case "navigation.stop":
        return .action(.navigationStop)
    default:
        return .unknownAction
    }
}

/// Client → server device.result (validated by server/session-controller.ts).
/// Optional keys are omitted entirely rather than sent as null.
func buildDeviceResult(commandId: String, result: DeviceActionResult) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.deviceResult,
        "commandId": commandId,
        "status": result.status.rawValue
    ]
    if let reason = result.reason { payload["reason"] = reason }
    if let detail = result.detail { payload["detail"] = detail }
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}

/// Client → server nav.request: ask the relay to route the rider (validated
/// by server/session-controller.ts). `origin`/`destination` are GCJ-02, like
/// every nav.* coordinate — no CoordinateDatum conversion at this layer.
/// Optional keys are omitted entirely rather than sent as null: reason
/// "start" carries `query` and no destination; reason "reroute" carries
/// `destination`/`destinationName` and no `query`.
func buildNavRequest(commandId: String, reason: String, originLat: Double, originLon: Double,
                     query: String?, destinationLat: Double?, destinationLon: Double?,
                     destinationName: String?) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.navRequest,
        "commandId": commandId,
        "reason": reason,
        "origin": ["lat": originLat, "lon": originLon]
    ]
    if let query { payload["query"] = query }
    if let destinationLat, let destinationLon {
        payload["destination"] = ["lat": destinationLat, "lon": destinationLon]
    }
    if let destinationName { payload["destinationName"] = destinationName }
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
}

func buildCrashAlert(incidentId: String, lat: Double?, lon: Double?, speedKmhRecent: Double?,
                     contactNumber: String?, contactOptIn: Bool, detectedAt: Double) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.crashAlert,
        "incidentId": incidentId,
        "contactOptIn": contactOptIn,
        "detectedAt": detectedAt
    ]
    if let lat { payload["lat"] = lat }
    if let lon { payload["lon"] = lon }
    if let speedKmhRecent { payload["speedKmhRecent"] = speedKmhRecent }
    if let contactNumber, contactOptIn { payload["contactNumber"] = contactNumber }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

/// Client → server vision.frames: one chunk of a gallery.describe upload
/// (validated by server/session-controller.ts). `question` is omitted
/// entirely, not sent as null, when the rider didn't ask one.
func buildVisionFrame(commandId: String, index: Int, total: Int, image: String, question: String?) -> String {
    var payload: [String: Any] = [
        "type": ClientEventTypes.visionFrames,
        "commandId": commandId,
        "reason": "gallery",
        "index": index,
        "total": total,
        "image": image
    ]
    if let question { payload["question"] = question }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

func buildCrashCancel(incidentId: String) -> String {
    let payload: [String: Any] = ["type": ClientEventTypes.crashCancel, "incidentId": incidentId]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

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

// MARK: - typed input and tools

/// One `tool.activity` update. Only what the status line needs is kept; the
/// tool's arguments and output never reach the client.
struct ToolActivity: Equatable {
    enum State: String { case started, succeeded, failed }
    let callId: String
    let name: String
    let state: State
}

/// Tracks the tool calls in flight so the HUD can say "looking that up…" while
/// any of them runs. The relay fails a call it gets no answer for after 15 s,
/// so a `started` whose end never arrives is forgotten a little after that.
struct ToolActivityTracker {
    static let staleAfter: TimeInterval = 20
    private var running: [String: TimeInterval] = [:]

    var isBusy: Bool { !running.isEmpty }

    mutating func apply(_ activity: ToolActivity, now: TimeInterval) {
        switch activity.state {
        case .started: running[activity.callId] = now
        case .succeeded, .failed: running.removeValue(forKey: activity.callId)
        }
    }

    mutating func expire(now: TimeInterval) {
        running = running.filter { now - $0.value < Self.staleAfter }
    }

    mutating func reset() { running.removeAll() }
}

enum TextInputRejection: Error, Equatable {
    case empty, tooLong, unsupported, notReady
    /// The bike is known to be moving (see typedInputLockedForSpeed).
    case moving
}

/// `text.input` limit from docs/protocol.md, counted the way the relay counts
/// it: UTF-16 code units, so an emoji takes two.
let textInputMaxUTF16Units = 2000

/// Trims typed text to the limit without splitting a character.
func clampToTextInputLimit(_ text: String) -> String {
    guard text.utf16.count > textInputMaxUTF16Units else { return text }
    var units = 0
    var end = text.startIndex
    for index in text.indices {
        let next = text.index(after: index)
        let characterUnits = text[index..<next].utf16.count
        guard units + characterUnits <= textInputMaxUTF16Units else { break }
        units += characterUnits
        end = next
    }
    return String(text[..<end])
}

/// Validates a typed turn and builds its `text.input` event. The relay would
/// answer an unsupported or malformed turn with an `error`; refusing here keeps
/// the rider's text in the field instead of silently losing it.
func prepareTextInput(_ raw: String, textInputSupported: Bool, ready: Bool, speedKmh: Double? = nil) -> Result<String, TextInputRejection> {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return .failure(.empty) }
    guard text.utf16.count <= textInputMaxUTF16Units else { return .failure(.tooLong) }
    guard textInputSupported else { return .failure(.unsupported) }
    guard ready else { return .failure(.notReady) }
    guard !typedInputLockedForSpeed(speedKmh) else { return .failure(.moving) }
    let payload: [String: Any] = ["type": ClientEventTypes.textInput, "text": text]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return .failure(.empty) }
    return .success(json)
}

/// The typing field belongs on screen only when it can work: the backend said
/// it takes typed turns and the session is up.
func typedInputVisible(capabilities: ProviderCapabilities, connection: ConnectionState) -> Bool {
    capabilities.textInput && connection == .ready
}

/// The protocol wants exactly one `tool.result` per `tool.call` and only sends
/// calls for declared tools, which this app has none of. Answering with an
/// error at once lets the model move on instead of waiting out the 15 s
/// timeout. A call id the relay itself would reject cannot be answered.
func unexpectedToolCallReply(callId: String, name: String) -> String? {
    guard !callId.isEmpty, callId.count <= 128 else { return nil }
    let shownName = String(name.prefix(64))
    let payload: [String: Any] = [
        "type": ClientEventTypes.toolResult,
        "callId": callId,
        "error": "The iOS app has no client tool named \(shownName)."
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
    return String(data: data, encoding: .utf8)
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
/// The speech-synthesis voice for a line of text: Chinese when it contains
/// Han characters, otherwise English, so English lines never get a Chinese voice.
func speechVoiceLanguage(for text: String) -> String {
    detectLanguage(text) == "zh" ? "zh-CN" : "en-US"
}

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
