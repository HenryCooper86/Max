import Foundation
import AVFoundation
import CoreLocation
import Combine

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

        /// 态势摘要 fusion: ride hazard + weather risk (fusedHazard in src/main.tsx).
        var fusedHazard: HazardLevel {
            combineHazardLevels(rideContext.hazardLevel, weather?.riskLevel ?? .normal)
        }
    }

    /// Mirrors MAX_RECONNECT_ATTEMPTS in src/main.tsx.
    static let maxReconnectAttempts = 6
    /// Repeated agent lines inside this window are dropped (src/main.tsx).
    private static let agentDedupeWindowMs: TimeInterval = 8.0

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
    private var reconnectAttempts = 0
    private var reconnectWorkItem: DispatchWorkItem?

    private var intentionalClose = false
    private var transmitting = false
    /// Plain mirror of `state.micMuted`, read off the audio thread alongside
    /// `transmitting` so the mic callback never touches `@Published` state.
    private var micMuted = false

    private var transcriptTurn = 0
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
            guard let self, self.transmitting, !self.micMuted else { return }
            self.webSocket?.send(.data(frame)) { _ in }
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
        let restored = Self.loadStoredTranscript()
        if !restored.isEmpty {
            transcriptTurn = restored.map(\.id).max() ?? 0
            state.transcript = restored
        }
    }

    // MARK: - public API

    /// Activates hands-free: route audio, resolve location, open the relay, and
    /// start the mic. `authToken`, when non-empty, is appended to the /agent URL
    /// as ?token=… (relays without a configured token ignore it).
    /// `allowSelfSignedTls` opts into trusting the test server's self-signed
    /// certificate for wss:// URLs.
    func start(url: String, authToken: String = "", allowSelfSignedTls: Bool) {
        guard !state.value.handsFree else { return }
        relayURL = url
        self.authToken = authToken
        reconnectWorkItem?.cancel()

        let trustedSelfSigned = allowSelfSignedTls
        if trustedSelfSigned != allowSelfSigned {
            allowSelfSigned = trustedSelfSigned
            urlSession = makeSession()
        }

        intentionalClose = false
        reconnectAttempts = 0
        transmitting = true
        micMuted = false

        let bluetoothRouted = audioRouter.startVoiceRouting()
        update {
            $0.handsFree = true
            $0.turnState = .listening
            $0.micMuted = false
            $0.bluetoothRouted = bluetoothRouted
        }

        locationProvider.resolve { [weak self] coordinate in
            guard let self else { return }
            self.location = coordinate
            self.connect()
            self.requestMicAndStart()
        }
    }

    /// Requests microphone permission (the iOS analogue of the Android RECORD_AUDIO
    /// runtime grant) and starts capture only once granted.
    private func requestMicAndStart() {
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.update { $0.statusText = "请在设置中允许麦克风权限" }
                return
            }
            DispatchQueue.main.async {
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
                    self.update { $0.statusText = "麦克风不可用，请检查录音权限" }
                }
            }
        }
    }

    /// Deactivates hands-free: stop the mic, restore routing, close the relay.
    func stop() {
        guard state.value.handsFree else { return }
        transmitting = false
        micMuted = false
        intentionalClose = true
        reconnectWorkItem?.cancel()
        webSocket?.send(.string(audioStopEvent)) { _ in }
        webSocket?.cancel(with: .normalClosure, reason: nil)
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

    /// Empties the conversation log and its persisted copy (设置 → 诊断 → 清空).
    func clearTranscript() {
        update { $0.transcript = [] }
        UserDefaults.standard.removeObject(forKey: Self.transcriptStoreKey)
    }

    // MARK: - transcript persistence

    /// The most recent final turns survive app restarts, stored as JSON in
    /// UserDefaults and refreshed on every transcript change (see update()).
    private static let transcriptStoreKey = "transcript_log"
    private static let transcriptStoreLimit = 200

    private static func loadStoredTranscript() -> [TranscriptItem] {
        guard let data = UserDefaults.standard.data(forKey: transcriptStoreKey),
              var items = try? JSONDecoder().decode([TranscriptItem].self, from: data) else {
            return []
        }
        // Only final turns are stored, but normalize anyway: a restored turn can
        // never resume streaming, so it always counts as final.
        for index in items.indices { items[index].final = true }
        return items
    }

    private static func storeTranscript(_ items: [TranscriptItem]) {
        let finals = Array(items.filter(\.final).suffix(transcriptStoreLimit))
        guard let data = try? JSONEncoder().encode(finals) else { return }
        UserDefaults.standard.set(data, forKey: transcriptStoreKey)
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

    private func restartSession() {
        let socket = webSocket
        webSocket = nil
        intentionalClose = true
        socket?.cancel(with: .normalClosure, reason: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            self.intentionalClose = false
            self.reconnectAttempts = 0
            self.connect()
        }
    }

    /// The relay endpoint with the optional shared auth token appended as a
    /// `token` query parameter (URL-encoded, preserving any existing query).
    private func relayEndpointURL() -> URL? {
        guard var components = URLComponents(string: relayURL) else { return nil }
        if !authToken.isEmpty {
            var items = components.queryItems ?? []
            items.append(URLQueryItem(name: "token", value: authToken))
            components.queryItems = items
        }
        return components.url
    }

    private func connect() {
        guard !intentionalClose, let url = relayEndpointURL() else { return }
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
        }
        let current = state.value
        task.send(.string(buildSessionStart(
            voiceGender: current.voiceGender,
            voicePersonality: current.voicePersonality,
            rideMode: current.rideContext.mode,
            scenario: current.rideContext.scenario,
            lat: location?.latitude,
            lon: location?.longitude
        ))) { _ in }
        if transmitting { task.send(.string(audioStartEvent)) { _ in } }
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
        webSocket = nil

        if intentionalClose {
            if state.value.handsFree { return } // restartSession() will reconnect
            update {
                $0.connection = .offline
                $0.statusText = "离线"
            }
            return
        }

        // The relay answered but refused the WebSocket upgrade (e.g. a wrong path
        // → HTTP 400). That's a configuration problem; retrying can't fix it.
        if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 {
            reconnectAttempts = 0
            update {
                $0.connection = .degraded
                $0.statusText = "中继拒绝连接（HTTP \(status)），请检查中继地址"
            }
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        reconnectAttempts += 1
        if reconnectAttempts > Self.maxReconnectAttempts {
            reconnectAttempts = 0
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

        case let .transcript(speaker, text, final, useBrowserSpeech):
            // Barge-in: the rider talking always silences the agent.
            if speaker == .rider { stopAgentSpeech() }
            pushTranscript(speaker: speaker, text: text, final: final)
            let shouldSpeak = useBrowserSpeech ?? final
            if speaker == .agent && shouldSpeak { speak(text) }

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

    /// Port of pushTranscript in src/main.tsx, including the dedupe rules.
    private func pushTranscript(speaker: Speaker, text: String, final: Bool) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let now = Date()
        let language = detectLanguage(clean)

        update {
            var items = $0.transcript
            let last = items.last

            // Repeated agent line within the dedupe window → drop it.
            if speaker == .agent, let last, last.speaker == .agent,
               normalizeTranscriptText(last.text) == normalizeTranscriptText(clean),
               now.timeIntervalSince(last.at) < Self.agentDedupeWindowMs {
                return
            }

            // Same speaker still mid-turn → update that entry in place.
            if let last, last.speaker == speaker, !last.final {
                var updated = last
                updated.at = now
                updated.text = clean
                updated.final = final
                updated.language = language
                items[items.count - 1] = updated
                $0.transcript = items
                return
            }

            // New turn: finalize any dangling in-progress entry, then append.
            if let last, !last.final {
                items[items.count - 1].final = true
            }
            self.transcriptTurn += 1
            items.append(TranscriptItem(
                id: self.transcriptTurn, at: now, speaker: speaker,
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
                if copy.transcript != self.state.transcript { Self.storeTranscript(copy.transcript) }
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
        guard allowSelfSigned,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // Demo relay support: the Lightsail test relay uses a self-signed
        // certificate. Keep this gated behind the explicit settings toggle.
        completionHandler(.useCredential, URLCredential(trust: trust))
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
