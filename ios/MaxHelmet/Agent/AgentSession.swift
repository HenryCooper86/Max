import Foundation
import AVFoundation
import CoreLocation
import Combine
import UIKit

/// Owns one hands-free voice session end to end: relay WebSocket, mic streaming,
/// voice playback, audio routing, TTS fallback, and the HUD state. This is the
/// iOS counterpart of android/.../AgentSession.kt and the useHelmetAgent hook in
/// src/main.tsx. An ObservableObject so the SwiftUI HUD re-renders on state change.
final class AgentSession: NSObject, ObservableObject {

    struct State: Equatable {
        var handsFree = false
        var connection: ConnectionState = .offline
        var statusText = "离线"
        var provider = ""
        var isLive = false
        /// Provider capabilities advertised by session.started (mirror of
        /// ProviderCapabilities in shared/agent.ts). Defaults match the web's
        /// DEFAULT_CAPABILITIES (all off) until the relay reports the real set.
        var capabilities = ProviderCapabilities()
        var turnState: TurnState = .idle
        /// Mic muted mid-session: the relay stays open and Max can keep speaking,
        /// but rider audio frames are withheld (ChatGPT-style mute).
        var micMuted = false
        var voiceGender: VoiceGender = .female
        var voicePersonality: VoicePersonality = .concise
        var voiceLevel: Float = 0
        var latencyMs = 0
        var transcript: [TranscriptItem] = []
        var weather: Weather? = nil
        var rideContext = RideContext()
        var sessionMemory = SessionMemory()
        var telemetry: Telemetry? = nil
        var bluetoothRouted = false
        /// The active ADAS hazard alert, shown as a banner until it auto-clears.
        var hazardAlert: HazardAlert? = nil
        /// Guided demo ride: the mock provider auto-tours the scenario catalog.
        var guidedDemo = false
        /// The relay refused the connection with HTTP 401 — a login (or token)
        /// is required. The UI opens the account settings when this flips on.
        var authRequired = false
        /// Transcript ids above this floor belong to the CURRENT relay session
        /// and may be flagged via turn.feedback (the relay matches inside its
        /// live session transcript, so a restored/previous-session turn could
        /// tag the wrong turn). Int.max = nothing flaggable (offline).
        var feedbackFloorId = Int.max

        /// Whether the flag control should show for a transcript item at all
        /// (mirrors canFlagTurn in useHelmetAgent.ts). The connection check
        /// covers every disconnect path without each one resetting the floor.
        func canFlagTurn(_ item: TranscriptItem) -> Bool {
            let live = connection == .relay || connection == .provider || connection == .ready
            return live && item.final && item.turnId != nil && item.feedback == nil && item.id > feedbackFloorId
        }

        /// 态势摘要 fusion: ride hazard + weather risk (fusedHazard in src/main.tsx).
        var fusedHazard: HazardLevel {
            combineHazardLevels(rideContext.hazardLevel, weather?.riskLevel ?? .normal)
        }
    }

    /// Mirrors MAX_RECONNECT_ATTEMPTS in src/main.tsx.
    static let maxReconnectAttempts = 6
    /// Mirrors IDLE_CLOSE_CODE in shared/agent.ts: the relay closed this idle
    /// session to free its upstream slot; auto-reconnecting would defeat it.
    static let idleCloseCode = 4001

    /// Process-wide owner of the single session, mirroring AgentSessionHolder in
    /// android/.../AgentSession.kt.
    static let shared = AgentSession()

    @Published private(set) var state = State()

    private var urlSession: URLSession!
    private var allowSelfSigned = false

    private var webSocket: URLSessionWebSocketTask?
    private var relayURL = ""
    /// Optional shared relay auth token, appended to the /agent URL as ?token=….
    private var authToken = ""
    private var testerId = ""
    private var testingCampaignId = "release-readiness"
    private var testingTestCaseId = "baseline-live-session"
    private var testingRunId = ""
    private var testingAssignmentId = ""
    private var reconnectAttempts = 0
    private var reconnectWorkItem: DispatchWorkItem?
    /// The 150 ms deferred reconnect of a settings-change restart, so stop()
    /// can cancel it — otherwise it would resurrect the session (and clobber
    /// intentionalClose) after the rider ended hands-free inside that window.
    private var restartWorkItem: DispatchWorkItem?
    /// Pure generation gate for async location/permission startup.
    private var lifecycle = SessionLifecycle()

    private var intentionalClose = false
    private var transmitting = false
    /// True only after session.started confirms the upstream provider is ready.
    /// A transport-level open is not enough: streaming earlier builds a burst
    /// in the relay while Doubao is still starting its session.
    private var socketOpen = false
    private let micSendLock = NSLock()
    private var micSendsInFlight = 0
    private static let maxMicSendsInFlight = 4
    /// Plain mirror of `state.micMuted`, read off the audio thread alongside
    /// `transmitting` so the mic callback never touches `@Published` state.
    private var micMuted = false

    private var transcriptTurn = 0
    private var transcriptOwnerId: String?
    /// Relay-issued speech deliveries already handed to device TTS.
    private var spokenDeliveryIds = Set<String>()
    private var spokenDeliveryOrder: [String] = []
    /// Bumped on each hazard alert so a stale auto-clear can't dismiss a newer one.
    private var hazardAlertGeneration = 0
    private var location: CLLocationCoordinate2D?

    /// One AVAudioEngine shared by mic capture and agent playback. iOS only
    /// cancels echo across a single engine (see MicStreamer/PcmPlayer), so this
    /// is what stops the built-in speaker from feeding the agent's own voice back
    /// into the mic. Mirrors the web's single shared AudioContext.
    private let voiceEngine = AVAudioEngine()
    private lazy var player = PcmPlayer(engine: voiceEngine)
    private let audioRouter = AudioRouter()
    private lazy var mic = MicStreamer(
        engine: voiceEngine,
        onFrame: { [weak self] frame in
            guard let self, self.transmitting, !self.micMuted, self.socketOpen else { return }
            self.sendMicFrame(frame)
        },
        onLevel: { [weak self] level in
            guard let self else { return }
            let active = self.transmitting && !self.micMuted
            self.update { $0.voiceLevel = active ? level : 0 }
        }
    )

    private let synthesizer = AVSpeechSynthesizer()
    private let locationProvider = LocationProvider()

    override init() {
        super.init()
        urlSession = makeSession()
        // The legacy cache was device-global and cannot be assigned safely to
        // whichever account logs in first after an upgrade.
        UserDefaults.standard.removeObject(forKey: Self.legacyTranscriptStoreKey)
    }

    // MARK: - public API

    /// Activates hands-free: route audio, resolve location, open the relay, and
    /// start the mic. `authToken`, when non-empty, is appended to the /agent URL
    /// as ?token=… (relays without a configured token ignore it).
    /// `allowSelfSignedTls` opts into trusting the test server's self-signed
    /// certificate for wss:// URLs.
    func start(
        url: String,
        authToken: String = "",
        allowSelfSignedTls: Bool,
        testerId: String = "",
        testingCampaignId: String = "release-readiness",
        testingTestCaseId: String = "baseline-live-session",
        testingRunId: String = "",
        testingAssignmentId: String = ""
    ) {
        guard let generation = lifecycle.begin() else { return }
        relayURL = url
        self.authToken = authToken
        self.testerId = testerId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.testingCampaignId = String(testingCampaignId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        self.testingTestCaseId = String(testingTestCaseId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        self.testingRunId = String(testingRunId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        self.testingAssignmentId = String(testingAssignmentId.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        reconnectWorkItem?.cancel()

        let trustedSelfSigned = allowSelfSignedTls
        if trustedSelfSigned != allowSelfSigned {
            allowSelfSigned = trustedSelfSigned
            // URLSession retains its delegate until invalidated — replacing
            // without this leaked the old session (and pinned self) each time
            // the trust toggle changed.
            urlSession.finishTasksAndInvalidate()
            urlSession = makeSession()
        }

        intentionalClose = false
        reconnectAttempts = 0
        transmitting = true
        micMuted = false
        spokenDeliveryIds.removeAll(keepingCapacity: true)
        spokenDeliveryOrder.removeAll(keepingCapacity: true)

        let bluetoothRouted = audioRouter.startVoiceRouting()
        update {
            $0.handsFree = true
            $0.turnState = .listening
            $0.micMuted = false
            $0.bluetoothRouted = bluetoothRouted
            $0.authRequired = false
        }

        locationProvider.resolve { [weak self] coordinate in
            guard let self else { return }
            guard self.lifecycle.accepts(generation) else { return }
            self.location = coordinate
            guard self.connect() else {
                self.failHandsFreeStart(generation: generation, message: "中继地址无效，请在设置中检查服务器地址")
                return
            }
            self.requestMicAndStart(generation: generation)
        }
    }

    /// Requests microphone permission (the iOS analogue of the Android RECORD_AUDIO
    /// runtime grant) and starts capture only once granted.
    private func requestMicAndStart(generation: Int) {
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self,
                      self.lifecycle.accepts(generation) else { return }
                guard granted else {
                    self.failHandsFreeStart(generation: generation, message: "请在设置中允许麦克风权限")
                    return
                }
                do {
                    // Attach the playback node first so it renders through the
                    // shared engine before the mic starts it — the engine's output
                    // is the echo-cancellation reference signal.
                    self.player.prepare()
                    try self.mic.start()
                    // Any agent audio that arrived while the permission dialog was
                    // up (e.g. the opening greeting) was buffered — play it now
                    // that the shared engine is running.
                    self.player.flushPending()
                } catch {
                    self.failHandsFreeStart(generation: generation, message: "麦克风不可用，请检查录音权限")
                }
            }
        }
    }

    /// Tears down every resource acquired before an async start failed.
    private func failHandsFreeStart(generation: Int, message: String) {
        guard lifecycle.accepts(generation) else { return }
        stop()
        update {
            $0.connection = .degraded
            $0.statusText = message
        }
    }

    /// Deactivates hands-free: stop the mic, restore routing, close the relay.
    func stop() {
        guard lifecycle.stop() else { return }
        transmitting = false
        micMuted = false
        intentionalClose = true
        reconnectWorkItem?.cancel()
        restartWorkItem?.cancel()
        webSocket?.send(.string(audioStopEvent)) { _ in }
        webSocket?.cancel(with: .normalClosure, reason: nil)
        socketOpen = false
        webSocket = nil
        mic.stop()
        synthesizer.stopSpeaking(at: .immediate)
        player.release()
        audioRouter.stopVoiceRouting()
        update {
            $0.handsFree = false
            $0.connection = .offline
            $0.statusText = "离线"
            $0.turnState = .idle
            $0.voiceLevel = 0
            $0.micMuted = false
            $0.bluetoothRouted = false
            $0.hazardAlert = nil
            $0.feedbackFloorId = Int.max
        }
    }

    /// The UI handled the 401 (opened the account settings): consume the flag
    /// so re-composition or repeated observation can't re-trigger it. A fresh
    /// 401 sets it true again.
    func acknowledgeAuthRequired() {
        update { $0.authRequired = false }
    }

    /// Toggles the guided demo ride (mock provider only — the live provider
    /// ignores it). Mirrors setGuidedDemo in useHelmetAgent.ts: send now when the
    /// socket is up, and handleSocketOpened re-sends it for fresh sessions.
    func setGuidedDemo(_ enabled: Bool) {
        update {
            $0.guidedDemo = enabled
            if enabled && $0.connection != .ready {
                $0.statusText = "巡游演示已开启，开启免提后自动巡游场景"
            }
        }
        webSocket?.send(.string(buildGuidedDemo(enabled: enabled))) { _ in }
    }

    /// Tester flags a transcript turn as bad (mirrors sendTurnFeedback in
    /// useHelmetAgent.ts). The relay attaches the reason to the matching turn
    /// of its CURRENT session, so only turns above feedbackFloorId qualify —
    /// State.canFlagTurn gates the UI and this re-checks before sending.
    func sendTurnFeedback(item: TranscriptItem, reason: String) {
        guard socketOpen, state.value.canFlagTurn(item), let turnId = item.turnId else { return }
        webSocket?.send(.string(buildTurnFeedback(
            turnId: turnId, speaker: item.speaker, text: item.text, reason: reason
        ))) { _ in }
        update {
            if let index = $0.transcript.firstIndex(where: { $0.id == item.id }) {
                $0.transcript[index].feedback = reason
            }
        }
    }

    /// Mutes/unmutes the rider's microphone without ending the session, so Max can
    /// keep talking while the rider's audio is withheld (the bottom mute control).
    func toggleMute() {
        guard state.value.handsFree else { return }
        micMuted.toggle()
        let muted = micMuted
        update {
            $0.micMuted = muted
            if muted { $0.voiceLevel = 0 }
        }
    }

    /// Switches the live speaker. Mirrors restartSession in src/main.tsx: the
    /// Doubao speaker is fixed at session start, so reconnect for a fresh session.
    /// The mic keeps running across the restart.
    func setVoiceGender(_ gender: VoiceGender) {
        guard state.value.voiceGender != gender else { return }
        update {
            $0.voiceGender = gender
            $0.statusText = gender == .male ? "已切换到男声" : "已切换到女声"
        }
        restartIfConnected()
    }

    func setVoicePersonality(_ personality: VoicePersonality) {
        guard state.value.voicePersonality != personality else { return }
        update {
            $0.voicePersonality = personality
            $0.statusText = "已切换语气：\(personality.label)"
        }
        restartIfConnected()
    }

    /// Mirrors setRideMode in src/main.tsx, including the hazard fusion.
    func setRideMode(_ mode: RideMode) {
        guard state.value.rideContext.mode != mode else { return }
        update {
            let hazard = combineHazardLevels(rideModeHazard(mode), $0.rideContext.scenario.hazard)
            $0.rideContext.mode = mode
            $0.rideContext.hazardLevel = hazard
        }
        restartIfConnected()
    }

    /// Mirrors setScenario in src/main.tsx — the scenario also picks a default mode.
    func setScenario(_ scenario: DemoScenario) {
        guard state.value.rideContext.scenario != scenario else { return }
        update {
            let mode = scenarioDefaultMode(scenario)
            let hazard = combineHazardLevels(rideModeHazard(mode), scenario.hazard)
            $0.rideContext.scenario = scenario
            $0.rideContext.mode = mode
            $0.rideContext.hazardLevel = hazard
        }
        restartIfConnected()
    }

    /// Builds the transcript export JSON (port of exportTranscriptLog in src/main.tsx).
    func buildTranscriptExport() -> String { buildTranscriptExportJSON(state.value.transcript) }

    /// Selects the immutable account that owns the on-device transcript cache.
    /// Signing out hides the log; another account loads a different record.
    func selectTranscriptOwner(_ userId: String?) {
        let candidate = userId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let owner = candidate?.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: .regularExpression
        ) == nil ? nil : candidate
        guard transcriptOwnerId != owner else { return }
        transcriptOwnerId = owner
        UserDefaults.standard.removeObject(forKey: Self.legacyTranscriptStoreKey)
        let restored = owner.map { loadStoredTranscript(for: $0) } ?? []
        transcriptTurn = restored.map(\.id).max() ?? 0
        update {
            $0.transcript = restored
            $0.feedbackFloorId = .max
            $0.sessionMemory = SessionMemory()
        }
    }

    /// Empties the conversation log and its persisted copy (设置 → 诊断 → 清空).
    func clearTranscript() {
        update { $0.transcript = [] }
        if let owner = transcriptOwnerId {
            UserDefaults.standard.removeObject(forKey: Self.transcriptStoreKeyPrefix + owner)
        }
    }

    // MARK: - transcript persistence

    /// The most recent final turns survive app restarts, stored as JSON in
    /// UserDefaults and refreshed on every transcript change (see update()).
    private static let legacyTranscriptStoreKey = "transcript_log"
    private static let transcriptStoreKeyPrefix = "transcript_log_v2_"
    private static let transcriptStoreLimit = 200

    private func loadStoredTranscript(for owner: String) -> [TranscriptItem] {
        guard let data = UserDefaults.standard.data(forKey: Self.transcriptStoreKeyPrefix + owner),
              var items = try? JSONDecoder().decode([TranscriptItem].self, from: data) else {
            return []
        }
        // Only final turns are stored, but normalize anyway: a restored turn can
        // never resume streaming, so it always counts as final.
        for index in items.indices { items[index].final = true }
        return items
    }

    private func storeTranscript(_ items: [TranscriptItem]) {
        guard let owner = transcriptOwnerId else { return }
        let finals = Array(items.filter(\.final).suffix(Self.transcriptStoreLimit))
        guard let data = try? JSONEncoder().encode(finals) else { return }
        UserDefaults.standard.set(data, forKey: Self.transcriptStoreKeyPrefix + owner)
    }

    // MARK: - relay connection

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    private func restartIfConnected() {
        if state.value.handsFree && webSocket != nil { restartSession() }
    }

    private func nativeDeviceLabel() -> String {
        let device = UIDevice.current
        return "\(device.model) \(device.systemName) \(device.systemVersion)"
    }

    private func nativeAppVersion() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? "unknown"
        return "\(version)+\(build)"
    }

    private func nativeGitCommit() -> String {
        let value = (Bundle.main.infoDictionary?["HorizonGitCommit"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("$(") else { return "unknown" }
        let isGitCommit = value.range(of: "^[0-9a-fA-F]{7,40}$", options: .regularExpression) != nil
        return isGitCommit ? String(value.prefix(12)).lowercased() : String(value.prefix(80))
    }

    private func restartSession() {
        let socket = webSocket
        webSocket = nil
        socketOpen = false
        intentionalClose = true
        socket?.cancel(with: .normalClosure, reason: nil)
        restartWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // The rider may have ended hands-free inside the delay window;
            // reconnecting anyway would open a zombie session with no mic.
            guard self.state.value.handsFree else { return }
            self.intentionalClose = false
            self.reconnectAttempts = 0
            self.connect()
        }
        restartWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    /// The relay endpoint with the optional shared auth token appended as a
    /// `token` query parameter (URL-encoded, preserving any existing query).
    private func relayEndpointURL() -> URL? {
        guard var components = URLComponents(string: relayURL),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              components.host != nil else { return nil }
        if !authToken.isEmpty {
            // Replace, never duplicate: a pasted URL may already carry ?token=.
            var items = (components.queryItems ?? []).filter { $0.name != "token" }
            items.append(URLQueryItem(name: "token", value: authToken))
            components.queryItems = items
        }
        return components.url
    }

    @discardableResult
    private func connect() -> Bool {
        guard !intentionalClose, let url = relayEndpointURL() else { return false }
        socketOpen = false
        update {
            $0.connection = .connecting
            $0.statusText = self.reconnectAttempts > 0 ? "重新连接中…（第 \(self.reconnectAttempts) 次）" : "连接中"
        }

        let task = urlSession.webSocketTask(with: url)
        webSocket = task
        task.resume()

        // The relay handshake is sent from handleSocketOpened() once the upgrade
        // actually completes — claiming "就绪" here would mask a rejected connection.
        receive(on: task)
        schedulePing(on: task)
        return true
    }

    /// The relay accepted the WebSocket upgrade: report ready and run the
    /// handshake — session.start, then resume audio if transmitting.
    private func handleSocketOpened(_ task: URLSessionWebSocketTask) {
        assert(Thread.isMainThread)
        guard task === webSocket else { return }
        reconnectAttempts = 0
        update {
            $0.connection = .relay
            $0.statusText = "就绪"
            // Only turns appended from here on belong to this relay session
            // and are eligible for turn.feedback.
            $0.feedbackFloorId = self.transcriptTurn
        }
        let current = state.value
        task.send(.string(buildSessionStart(
            voiceGender: current.voiceGender,
            voicePersonality: current.voicePersonality,
            rideMode: current.rideContext.mode,
            scenario: current.rideContext.scenario,
            lat: location?.latitude,
            lon: location?.longitude,
            testerId: testerId.isEmpty ? "ios-native" : testerId,
            testerRegion: TimeZone.current.identifier,
            testingCampaignId: testingCampaignId,
            testingTestCaseId: testingTestCaseId,
            testingRunId: testingRunId,
            testingAssignmentId: testingAssignmentId,
            appVersion: nativeAppVersion(),
            gitCommit: nativeGitCommit(),
            deviceLabel: nativeDeviceLabel(),
            browserLanguage: Locale.current.identifier,
            networkType: "ios-native",
            memory: current.sessionMemory
        ))) { _ in }
        // The guided tour lives in the provider instance, so a fresh session
        // must be told about it again (mirrors the web client's open handler).
        if current.guidedDemo { task.send(.string(buildGuidedDemo(enabled: true))) { _ in } }
        if transmitting { task.send(.string(audioStartEvent)) { _ in } }
        // Mic frames wait for session.started, not merely the relay handshake.
        socketOpen = false
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.webSocket else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    let event = parseAgentEvent(text)
                    DispatchQueue.main.async { [weak self] in
                        guard let self, task === self.webSocket else { return }
                        if case .unhandled = event, !text.contains("\"type\"") {
                            self.update { $0.statusText = "收到异常代理消息" }
                        } else {
                            self.handleEvent(event)
                        }
                    }
                case .data(let data):
                    self.player.play(data)
                @unknown default:
                    break
                }
                self.receive(on: task)
            case .failure:
                DispatchQueue.main.async { [weak self] in
                    guard let self, task === self.webSocket else { return }
                    self.handleSocketClosed(task)
                }
            }
        }
    }

    private func schedulePing(on task: URLSessionWebSocketTask) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, task === self.webSocket else { return }
            task.sendPing { _ in }
            self.schedulePing(on: task)
        }
    }

    private func handleSocketClosed(_ task: URLSessionWebSocketTask) {
        assert(Thread.isMainThread)
        // Ignore a socket already superseded by a newer one (e.g. a restart).
        if let current = webSocket, task !== current { return }
        socketOpen = false
        webSocket = nil

        if intentionalClose {
            if state.value.handsFree { return } // restartSession() will reconnect
            update {
                $0.connection = .offline
                $0.statusText = "离线"
            }
            return
        }

        // The relay closed an idle session to free its upstream slot. End
        // hands-free entirely (mirrors the web client's stopMic on 4001):
        // leaving it half-alive kept the mic capturing, the audio route
        // claimed, and the orb pulsing "listening" with no session behind it.
        if task.closeCode.rawValue == Self.idleCloseCode {
            reconnectAttempts = 0
            stop()
            update { $0.statusText = "会话闲置已断开，请重新开启免提" }
            return
        }

        // The relay answered but refused the WebSocket upgrade. Retrying can't
        // fix either case: 401 means the relay requires a login token (accounts
        // are active on the shared relay — see the web HUD's 复制令牌 button),
        // anything else is a configuration problem (e.g. wrong path → HTTP 400).
        if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 {
            reconnectAttempts = 0
            // End hands-free entirely, like the idle-close branch: a rejected
            // upgrade left a zombie session (mic capturing, audio route
            // claimed, no reconnect), the token field hidden behind the
            // read-only 连接 view, and the next helmet tap STOPPING the
            // zombie instead of retrying with the fresh login.
            stop()
            update {
                $0.connection = .degraded
                $0.authRequired = status == 401
                $0.statusText = status == 401
                    ? "需要登录：在设置的「账号」里登录（或粘贴认证令牌）"
                    : "中继拒绝连接（HTTP \(status)），请检查中继地址"
            }
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        reconnectAttempts += 1
        if reconnectAttempts > Self.maxReconnectAttempts {
            reconnectAttempts = 0
            stop()
            update {
                $0.connection = .degraded
                $0.statusText = "语音中继连接失败，请重新开启免提"
            }
            return
        }
        let delayMs = min(8_000, 1_000 * (1 << (reconnectAttempts - 1)))
        update {
            $0.connection = .offline
            $0.statusText = "连接已断开，\(delayMs / 1000) 秒后自动重连…"
        }
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: work)
    }

    // MARK: - event handling

    private func handleEvent(_ event: AgentEvent) {
        switch event {
        case let .sessionStarted(provider, mode, capabilities):
            socketOpen = true
            update {
                $0.provider = provider
                $0.isLive = mode != "mock"
                $0.capabilities = capabilities
                $0.connection = .ready
                $0.statusText = mode == "mock" ? "模拟路线已启用" : "豆包实时语音在线"
            }

        case let .connection(connState, detail):
            update {
                $0.connection = mapConnectionState(connState, previous: $0.connection)
                $0.statusText = detail
            }

        case let .status(connState, detail):
            if connState == "hearing" { stopAgentSpeech() }
            update {
                let connection: ConnectionState
                switch connState {
                case "connecting": connection = .provider
                case "ready": connection = .ready
                case "closed": connection = .offline
                default: connection = $0.connection
                }
                $0.statusText = detail
                $0.connection = connection
                if self.transmitting {
                    $0.turnState = mapTurnState(connState, previous: $0.turnState)
                }
            }

        case let .transcript(turnId, deliveryId, speaker, text, final, useBrowserSpeech):
            // Barge-in: the rider talking always silences the agent.
            if speaker == .rider {
                stopAgentSpeech()
            }
            pushTranscript(
                speaker: speaker, text: text, final: final,
                turnId: turnId, deliveryId: deliveryId
            )
            let shouldSpeak = useBrowserSpeech ?? final
            if speaker == .agent && shouldSpeak && spokenDeliveryIds.insert(deliveryId).inserted {
                spokenDeliveryOrder.append(deliveryId)
                if spokenDeliveryOrder.count > 512 {
                    let oldest = spokenDeliveryOrder.removeFirst()
                    spokenDeliveryIds.remove(oldest)
                }
                speak(text)
            }

        case let .metric(latencyMs):
            update { $0.latencyMs = latencyMs }

        case let .weatherUpdate(weather):
            // rideContext.hazardLevel is owned by the server's ride.context events
            // (already fused with weather there), and fusedHazard folds the current
            // weather in at read time. Mutating hazardLevel here would only ever
            // raise it (combineHazardLevels takes the max), so an improving weather
            // reading could leave the HUD stuck high between ride.context events.
            update { $0.weather = weather }

        case let .rideContextUpdate(rideContext):
            update { $0.rideContext = rideContext }

        case let .sessionMemoryUpdate(memory):
            update { $0.sessionMemory = memory }

        case let .telemetryUpdate(telemetry):
            update { $0.telemetry = telemetry }

        case let .hazardAlert(alert):
            handleHazardAlert(alert)

        case let .error(message):
            update { $0.statusText = message }

        case .unhandled:
            break
        }
    }

    /// URLSession has no public buffered-byte counter. Bound concurrent sends
    /// so slow links shed stale 20 ms frames instead of growing without limit.
    private func sendMicFrame(_ frame: Data) {
        micSendLock.lock()
        guard micSendsInFlight < Self.maxMicSendsInFlight else {
            micSendLock.unlock()
            return
        }
        micSendsInFlight += 1
        micSendLock.unlock()

        guard let task = webSocket else {
            micSendLock.lock()
            micSendsInFlight = max(0, micSendsInFlight - 1)
            micSendLock.unlock()
            return
        }
        task.send(.data(frame)) { [weak self] _ in
            guard let self else { return }
            self.micSendLock.lock()
            self.micSendsInFlight = max(0, self.micSendsInFlight - 1)
            self.micSendLock.unlock()
        }
    }

    /// Upserts partial/final transcript events by their relay-issued turn id.
    private func pushTranscript(
        speaker: Speaker, text: String, final: Bool,
        turnId: String, deliveryId: String
    ) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let now = Date()
        let language = detectLanguage(clean)

        update {
            var items = $0.transcript
            if let existingIndex = items.firstIndex(where: { $0.turnId == turnId }) {
                var updated = items[existingIndex]
                updated.at = now
                updated.text = clean
                updated.final = final
                updated.language = language
                updated.deliveryId = deliveryId
                items[existingIndex] = updated
                $0.transcript = items
                return
            }

            // New turn: finalize any dangling in-progress entry, then append.
            if let last = items.last, !last.final {
                items[items.count - 1].final = true
            }
            self.transcriptTurn += 1
            items.append(TranscriptItem(
                id: self.transcriptTurn, turnId: turnId, deliveryId: deliveryId,
                at: now, speaker: speaker,
                text: clean, final: final, language: language
            ))
            $0.transcript = items
        }
    }

    // MARK: - ADAS hazard alerts

    /// A proactive ADAS alert: cut any in-progress agent speech so the warning is
    /// heard immediately, surface the banner, speak it, then auto-clear it.
    private func handleHazardAlert(_ alert: HazardAlert) {
        if alert.interrupt { stopAgentSpeech() }
        hazardAlertGeneration += 1
        let generation = hazardAlertGeneration
        update {
            $0.hazardAlert = alert
            $0.turnState = .speaking
            $0.statusText = "⚠️ \(alert.label)"
        }
        speak("\(alert.message) \(alert.advice)")
        // Dismiss after the reaction window unless a newer alert has replaced it.
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(alert.ttcSeconds) + 2) { [weak self] in
            guard let self, self.hazardAlertGeneration == generation else { return }
            self.update { $0.hazardAlert = nil }
        }
    }

    // MARK: - speech output

    /// Barge-in: silence whatever the agent is currently saying.
    private func stopAgentSpeech() {
        synthesizer.stopSpeaking(at: .immediate)
        player.stopPlayback()
        if transmitting {
            update {
                $0.turnState = .listening
                $0.statusText = "已打断 Max，继续听你说"
            }
        }
    }

    private func speak(_ text: String) {
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(
            language: detectLanguage(text) == "zh" ? "zh-CN" : "en-US"
        )
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }

    // MARK: - state plumbing

    /// Applies a mutation on the main thread and publishes only if it changed.
    private func update(_ transform: @escaping (inout State) -> Void) {
        let apply = { [weak self] in
            guard let self else { return }
            var copy = self.state
            transform(&copy)
            if copy != self.state {
                if copy.transcript != self.state.transcript { self.storeTranscript(copy.transcript) }
                self.state = copy
            }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }
}

// Reads like the Kotlin `_state.value`; `state` is already the current snapshot.
extension AgentSession.State {
    var value: AgentSession.State { self }
}

// MARK: - WebSocket lifecycle

extension AgentSession: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.handleSocketOpened(webSocketTask)
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self, webSocketTask === self.webSocket else { return }
            self.handleSocketClosed(webSocketTask)
        }
    }
}

// MARK: - URLSession delegate (self-signed TLS opt-in)

extension AgentSession: URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        #if DEBUG
        guard allowSelfSigned,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // Demo relay support: the Lightsail test relay uses a self-signed
        // certificate. Keep this gated behind the explicit settings toggle.
        completionHandler(.useCredential, URLCredential(trust: trust))
        #else
        completionHandler(.performDefaultHandling, nil)
        #endif
    }
}

// MARK: - best-effort one-shot location for the weather context

/// Last-known location is good enough — the server falls back to its demo
/// location when this is nil. Mirrors resolveLocation in AgentSession.kt.
private final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: ((CLLocationCoordinate2D?) -> Void)?
    private var finished = false

    override init() {
        super.init()
        manager.delegate = self
    }

    func resolve(_ completion: @escaping (CLLocationCoordinate2D?) -> Void) {
        self.completion = completion
        self.finished = false

        let status = manager.authorizationStatus
        switch status {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            requestCurrentLocation()
        case .denied, .restricted:
            finish(nil)
        @unknown default:
            finish(nil)
        }
        // Never block the session on a slow fix.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.finish(self?.manager.location?.coordinate)
        }
    }

    private func requestCurrentLocation() {
        if let cached = manager.location?.coordinate {
            finish(cached)
            return
        }
        manager.requestLocation()
    }

    private func finish(_ coordinate: CLLocationCoordinate2D?) {
        guard !finished else { return }
        finished = true
        let block = completion
        completion = nil
        DispatchQueue.main.async { block?(coordinate) }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(locations.last?.coordinate)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(nil)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            requestCurrentLocation()
        } else if status == .denied || status == .restricted {
            finish(nil)
        }
    }
}
