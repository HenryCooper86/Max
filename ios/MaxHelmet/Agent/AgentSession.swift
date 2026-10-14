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
        /// Live guidance, or nil when not navigating. Cleared on session start.
        var guidance: GuidanceState? = nil
        /// True while a video is recording; drives the HUD indicator.
        var recording = false
        /// When the current recording began, for the elapsed timer.
        var recordingStartedAt: Double? = nil
        /// Bumped by a `gallery.open` command so the UI presents the gallery.
        var galleryRequestToken = 0
        /// False until the first ride.context event. Without this, the default
        /// speedKmh of 0 reads as "stopped" and defeats the SMS speed gate.
        var hasRideContext = false
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
        /// Crash-detection UI phase, owned entirely by CrashController.onUIChange.
        var crashPhase: CrashUIPhase = .hidden
        /// Human-readable coordinates for the active incident, or nil.
        var crashLocationText: String?

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
    /// Past the normal give-up point, an active incident with an un-acked
    /// crash.alert keeps retrying at this slower, indefinite cadence instead
    /// of giving up — the alert queues and survives reconnect; the network
    /// is delivery-only, and an unconscious rider can't re-toggle hands-free.
    static let crashOutageRetryDelayS: TimeInterval = 30

    /// Process-wide owner of the single session, mirroring AgentSessionHolder in
    /// android/.../AgentSession.kt.
    static let shared = AgentSession()

    @Published private(set) var state = State()

    #if DEBUG
    func installAMapDeviceValidationGuidance(_ guidance: GuidanceState) {
        update { $0.guidance = guidance }
    }

    /// XCTest-only synthetic capture source. Transport, event parsing, published
    /// HUD state and PCM playback use the same paths as a rider session.
    private var syntheticAudioQA = false
    private var qaReceivedPCMBytes = 0
    private var qaSpeechAttempts = 0
    private var qaSpeechStarts = 0
    private var qaNextHazardSpeechGeneration: Int?
    private var qaHazardUtterances: [ObjectIdentifier: (utterance: AVSpeechUtterance, generation: Int)] = [:]
    private var qaStartedHazardGenerations = Set<Int>()
    var syntheticAudioQAHazardSpeechStarts: Set<Int> { qaStartedHazardGenerations }
    var syntheticAudioQASpeech: (receivedPCMBytes: Int, attempts: Int, starts: Int, isSpeaking: Bool) {
        (qaReceivedPCMBytes, qaSpeechAttempts, qaSpeechStarts, synthesizer.isSpeaking)
    }
    var syntheticAudioQAEvent: ((String) -> Void)?
    var syntheticAudioQAHazardInterrupt: ((_ pendingBefore: Int, _ pendingAfter: Int, _ interruptionsBefore: Int, _ interruptionsAfter: Int, _ hazardGeneration: Int) -> Void)?
    var syntheticAudioQACaptureRunning: Bool { mic.syntheticAudioQARunning }
    var syntheticAudioQAOutputRunning: Bool { voiceEngine.isRunning }
    var syntheticAudioQAPlayback: (scheduledBytes: Int, playedBackBytes: Int, interruptedAudio: Int, pendingBytes: Int, discardedBytes: Int, playerArmed: Bool, nodePlaying: Bool) {
        player.syntheticAudioQASnapshot
    }

    func prepareSyntheticAudioQA() throws {
        precondition(!state.handsFree)
        syntheticAudioQA = true
        let outputSession = AVAudioSession.sharedInstance()
        try outputSession.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try outputSession.setActive(true)
        player.prepare()
        voiceEngine.prepare()
        try voiceEngine.start()
        player.flushPending()
    }

    func finishSyntheticAudioQA() {
        stop()
        player.release()
        voiceEngine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
        syntheticAudioQAEvent = nil
        syntheticAudioQAHazardInterrupt = nil
        qaHazardUtterances.removeAll()
        qaNextHazardSpeechGeneration = nil
        syntheticAudioQA = false
    }

    @discardableResult
    func sendSyntheticAudioQAFrame(_ frame: Data) -> Bool {
        guard syntheticAudioQA, frame.count == MicStreamer.frameBytes,
              let target = micSendTarget() else { return false }
        sendMicFrame(frame, on: target)
        return true
    }

    /// Drops the actual live WebSocket; the production receive/delegate close
    /// callbacks must observe the outage and reconnect without test intervention.
    func dropSyntheticAudioQATransport() {
        precondition(syntheticAudioQA)
        webSocket?.cancel(with: .goingAway, reason: nil)
    }
    #endif

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
    /// Plain mirror of `state.rideContext.speedKmh` (nil until `hasRideContext`),
    /// read by CrashController's motion feed on CoreMotion's background queue
    /// at ~100 Hz — same reasoning as `micMuted` above: never touch `@Published`
    /// state off-main.
    private var latestSpeedKmh: Double?
    /// Serializes the transport-gate fields (`webSocket`, `transmitting`,
    /// `micMuted`, `socketOpen`, `latestSpeedKmh`): the main thread writes them,
    /// but the audio-render thread (mic callbacks, `sendMicFrame`), the
    /// CoreMotion queue (`SystemMotionFeed`'s speed provider), the URLSession
    /// delegate queue (`receive`), and the ping queue read them. The key hazard is
    /// the `webSocket` reference — an off-main read otherwise races ARC
    /// retain/release against a main-thread reassignment (ThreadSanitizer-flagged;
    /// rare use-after-free / over-release). All writes go through
    /// `withTransportLock`; off-main reads go through the gate helpers below.
    private let transportLock = NSLock()

    private var transcriptTurn = 0
    private var transcriptOwnerId: String?
    /// Relay-issued speech deliveries already handed to device TTS.
    private var spokenDeliveryIds = Set<String>()
    private var spokenDeliveryOrder: [String] = []
    /// Bumped on each hazard alert so a stale auto-clear can't dismiss a newer one.
    private var hazardAlertGeneration = 0
    private var location: CLLocationCoordinate2D?
    private var lastLocationFixAt: TimeInterval = -.infinity
    private var lastLocationSentAt: TimeInterval = -.infinity

    /// One AVAudioEngine shared by mic capture and agent playback. iOS only
    /// cancels echo across a single engine (see MicStreamer/PcmPlayer), so this
    /// is what stops the built-in speaker from feeding the agent's own voice back
    /// into the mic. Mirrors the web's single shared AudioContext.
    private let voiceEngine = AVAudioEngine()
    private lazy var player = PcmPlayer(engine: voiceEngine)
    /// The one capture store shared by the camera handler (writes) and the
    /// gallery UI (reads).
    let captureStore = CaptureStore()
    /// Supplied by MainViewModel (Task 12); safe defaults until then.
    var crashSettingsProvider: () -> CrashSettings = {
        CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false)
    }
    private let audioRouter = AudioRouter()
    @MainActor lazy var music = MusicPlaybackModel()
    private lazy var mic = MicStreamer(
        engine: voiceEngine,
        onFrame: { [weak self] frame in
            guard let self, let task = self.micSendTarget() else { return }
            self.sendMicFrame(frame, on: task)
        },
        onLevel: { [weak self] level in
            guard let self else { return }
            let active = self.captureActive()
            self.update { $0.voiceLevel = active ? level : 0 }
        }
    )

    private let synthesizer = AVSpeechSynthesizer()
    private let locationProvider = LocationProvider()

    /// One-shot location resolver for crash escalation, separate from the
    /// session-start `locationProvider` so a stale ride-start fix never
    /// substitutes for the rider's actual position at the moment of impact.
    private lazy var crashLocationProvider = LocationProvider()
    /// `CrashController` is `@MainActor` (Task 10 spec); `AgentSession` predates
    /// Swift concurrency isolation and is not itself an actor, so constructing
    /// and driving it from here is a synchronous call into main-actor-isolated
    /// code from a nonisolated type. Every touch point below (`init()`,
    /// `start()`, `stop()`, and `handleEvent()`'s cases) already runs on the
    /// main thread in practice — `handleEvent` is always invoked from inside a
    /// `DispatchQueue.main.async` — so `onCrash` asserts that isolation rather
    /// than restructuring the class. This is the one deviation Step 5 forced;
    /// see the task report.
    private(set) lazy var crashController: CrashController = MainActor.assumeIsolated {
        CrashController(
            motion: SystemMotionFeed(speedProvider: { [weak self] in self?.latestSpeedKmhGate() }),
            locate: { [weak self] completion in self?.crashLocationProvider.resolve(completion) ?? completion(nil) },
            speak: { [weak self] line in self?.speak(line) },
            interruptPlayback: { [weak self] in self?.stopAgentSpeech() },
            siren: SirenPlayer(
                play: { [weak self] pcm in self?.player.play(pcm) },
                stop: { [weak self] in self?.player.stopPlayback() }
            ),
            send: { [weak self] json in self?.webSocket?.send(.string(json)) { _ in } },
            settings: { [weak self] in self?.crashSettingsProvider() ?? CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false) }
        )
    }

    /// Runs `body` against `crashController` while asserting the main-actor
    /// isolation its every call site already guarantees at runtime (see the
    /// comment on `crashController` above).
    private func onCrash<T>(_ body: @MainActor (CrashController) -> T) -> T {
        MainActor.assumeIsolated { body(crashController) }
    }

    /// Relay-backed nav search, shared by the `.navigation` route (as the
    /// origin of `nav.request`) and `handleEvent`'s `.navRoute`/`.navError`
    /// cases (which forward the relay's answer back into it). The send
    /// closure mirrors `crashController`'s: write straight to the live
    /// socket, dropping the send if there isn't one.
    private lazy var relayNavigationSearch = RelayNavigationSearch(
        send: { [weak self] json in self?.webSocket?.send(.string(json)) { _ in } }
    )

    @MainActor let hudCast = HUDCastClient()
    @MainActor private let deviceCommands = DeviceCommandSession()
    @MainActor private lazy var cameraController = CameraController(
        session: AVFoundationCaptureSession(), store: captureStore,
        onRecordingChange: { [weak self] recording in
            self?.update {
                $0.recording = recording
                $0.recordingStartedAt = recording ? Date().timeIntervalSince1970 : nil
            }
        },
        onOpenGallery: { [weak self] in self?.update { $0.galleryRequestToken += 1 } },
        onAutoStopped: { [weak self] in self?.speak("录像已停止并保存。") }
    )

    func stopCameraForSession() {
        Task { @MainActor in await cameraController.stopForSession() }
    }

    private func invalidateDeviceCommands() {
        MainActor.assumeIsolated { deviceCommands.invalidate() }
    }

    /// Held as its own typed property (rather than reached for only through
    /// `deviceRouter`'s handler dictionary) so `stop()` can call its
    /// `teardown()` directly — `DeviceActionHandler` has no such method, and
    /// the dictionary's values are erased to that protocol.
    @MainActor private lazy var navigationController = NavigationController(
        search: relayNavigationSearch,
        stream: SystemLocationStream(),
        onGuidance: { [weak self] guidance in
            self?.hudCast.update(guidance)
            self?.update { $0.guidance = guidance }
        },
        speak: { [weak self] line in self?.update { $0.statusText = line } },
        interruptPlayback: { [weak self] in self?.player.stopPlayback() },
        now: { ProcessInfo.processInfo.systemUptime },
        sendRelayPrompt: { [weak self] json in self?.webSocket?.send(.string(json)) { _ in } }
    )

    /// Routes relay-issued device commands to one handler each. Built lazily so
    /// `player` (the volume handler's gain target) is available. The message
    /// presenter is main-actor isolated, so it is created on demand inside its
    /// own handler rather than here.
    @MainActor private lazy var deviceRouter = DeviceActionRouter(
        handlers: [
            .torch: TorchController(),
            .volume: PlaybackVolumeController(gain: player),
            .music: MusicController(player: music),
            .sms: MessageComposer(
                presenter: MainActorMessagePresenter(),
                speedProvider: { [weak self] in
                    guard let self, self.state.value.hasRideContext else { return nil }
                    return Double(self.state.value.rideContext.speedKmh)
                },
                resolver: SystemContactResolver()
            ),
            .call: CallDialer(),
            .navigation: navigationController,
            .camera: cameraController,
            .galleryDescribe: GalleryDescribeController(
                store: captureStore,
                send: { [weak self] json in
                    guard !Task.isCancelled else { return }
                    self?.webSocket?.send(.string(json)) { _ in }
                }
            )
        ],
        isDeviceUnlocked: { UIApplication.shared.isProtectedDataAvailable }
    )

    override init() {
        super.init()
        #if DEBUG
        synthesizer.delegate = self
        #endif
        urlSession = makeSession()
        // The legacy cache was device-global and cannot be assigned safely to
        // whichever account logs in first after an upgrade.
        UserDefaults.standard.removeObject(forKey: Self.legacyTranscriptStoreKey)
        onCrash { controller in
            controller.onUIChange = { [weak self] phase in self?.update { $0.crashPhase = phase } }
            controller.onLocationText = { [weak self] text in self?.update { $0.crashLocationText = text } }
            controller.onIncidentResolved = { [weak self] in
                guard let self, !self.state.value.handsFree else { return }
                // stop() skipped this teardown while the incident was active
                // (see stop()'s hasActiveIncident branch) so the siren could
                // keep sounding through a dead session. The incident has now
                // resolved and the session is still dead, so finish what
                // stop() deferred — otherwise the engine, the AVAudioSession,
                // the mic tap, and CrashController's 0.5 s tick timer would
                // all keep running forever with no session behind them.
                self.mic.stop()
                self.player.release()
                self.audioRouter.stopVoiceRouting()
                self.onCrash { $0.disarm() }
            }
        }
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
        withTransportLock {
            transmitting = true
            micMuted = false
            // A stale ride's speed must not outlive it (mirrors hasRideContext
            // below) — otherwise CrashController's speed gate could see a
            // leftover fast reading before the first ride.context of the new
            // session arrives.
            latestSpeedKmh = nil
        }
        spokenDeliveryIds.removeAll(keepingCapacity: true)
        spokenDeliveryOrder.removeAll(keepingCapacity: true)

        #if DEBUG
        let bluetoothRouted = syntheticAudioQA ? false : audioRouter.startVoiceRouting()
        #else
        let bluetoothRouted = audioRouter.startVoiceRouting()
        #endif
        update {
            $0.handsFree = true
            $0.turnState = .listening
            $0.micMuted = false
            $0.bluetoothRouted = bluetoothRouted
            $0.authRequired = false
            // A stale route or ride context must not outlive its ride.
            $0.guidance = nil
            $0.hasRideContext = false
        }
        #if DEBUG
        if syntheticAudioQA {
            // No location, motion, microphone permission or capture occurs.
            if !connect() {
                failHandsFreeStart(generation: generation, message: "中继地址无效")
            }
            return
        }
        #endif
        onCrash { $0.arm() }

        lastLocationSentAt = -.infinity
        locationProvider.onUpdate = { [weak self] coordinate in
            guard let self, self.lifecycle.accepts(generation) else { return }
            self.location = coordinate
            let now = ProcessInfo.processInfo.systemUptime
            self.lastLocationFixAt = now
            guard self.state.value.connection == .ready, now - self.lastLocationSentAt >= 10 else { return }
            self.lastLocationSentAt = now
            let event: [String: Any] = ["type": "location.update", "lat": coordinate.latitude, "lon": coordinate.longitude]
            if let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) {
                self.webSocket?.send(.string(json)) { _ in }
            }
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
        invalidateDeviceCommands()
        stopCameraForSession()
        locationProvider.stop()
        location = nil
        withTransportLock {
            transmitting = false
            micMuted = false
        }
        intentionalClose = true
        reconnectWorkItem?.cancel()
        restartWorkItem?.cancel()
        webSocket?.send(.string(audioStopEvent)) { _ in }
        webSocket?.cancel(with: .normalClosure, reason: nil)
        withTransportLock {
            socketOpen = false
            webSocket = nil
        }
        // A dead socket delivers no route: resolve any suspended nav.request
        // now rather than leaving NavigationController's perform() — and the
        // device slot it holds — suspended until its own 7 s watchdog fires.
        relayNavigationSearch.failPending()
        // The session is ending: resolve any pending first-fix wait too, and
        // silently — without this, an in-flight `awaitFirstFix` (a nav
        // command with no fix yet, stopped hands-free before 1.5s/8s) would
        // still speak 正在定位… or fail route.unavailable into a session
        // nobody is listening to anymore. Mirrors Android's
        // `navController.teardown()` call right beside its own
        // `navSearch.failPending()` in `stop()`.
        //
        // `teardown()` is synchronous and `@MainActor`-isolated (unlike
        // `perform()`, which is `async` and so needs no isolation proof at
        // its call site — Swift just hops actors). `stop()` is one of the
        // touch points documented above `crashController` as already always
        // running on the main thread, so this asserts that isolation the
        // same way `onCrash` does rather than restructuring the class.
        MainActor.assumeIsolated {
            hudCast.stop()
            music.stopPlayback()
            navigationController.teardown()
        }
        synthesizer.stopSpeaking(at: .immediate)
        // An incident past check-in owns the shared engine until it resolves:
        // the siren renders through the same AVAudioEngine as agent speech
        // (see SirenPlayer's play/stop closures below), and both
        // `player.release()` and `audioRouter.stopVoiceRouting()` (which
        // deactivates the whole AVAudioSession) would silence it along with
        // everything else. `mic.stop()` would too — it calls `engine.stop()`,
        // halting every node on the engine — so this uses `pauseCapture()`
        // instead, which removes the tap (capture genuinely stops) without
        // touching the engine. Consulted before any of that teardown runs.
        let hasActiveIncident = onCrash { $0.hasActiveIncident }
        if hasActiveIncident {
            mic.pauseCapture()
        } else {
            #if DEBUG
            if syntheticAudioQA { voiceEngine.stop() } else { mic.stop() }
            #else
            mic.stop()
            #endif
            player.release()
            audioRouter.stopVoiceRouting()
        }
        // Not disarm(): an incident past check-in outlives the session — its
        // countdowns, siren, and UI keep running. onUIChange is the only
        // writer of crashPhase, so the teardown update below leaves it alone.
        onCrash { $0.sessionEnded() }
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
        let muted = !micMuted
        withTransportLock { micMuted = muted }
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

    @MainActor func confirmNavigation(id: UUID, accepted: Bool) {
        navigationController.confirmDestination(id: id, accepted: accepted)
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
        #if DEBUG
        if syntheticAudioQA { return "\(device.model) \(device.systemName) \(device.systemVersion) Simulator / XCTest synthetic audio" }
        #endif
        return "\(device.model) \(device.systemName) \(device.systemVersion)"
    }

    private func nativeBrowserLanguage() -> String {
        #if DEBUG
        if syntheticAudioQA { return "zh-CN" }
        #endif
        return Locale.current.identifier
    }

    private func nativeNetworkType() -> String {
        #if DEBUG
        if syntheticAudioQA {
            switch testingTestCaseId {
            case "wind-noise-robustness": return "ios-native synthetic field wind"
            case "degraded-network-recovery": return "ios-native synthetic degraded outage"
            default: return "ios-native synthetic"
            }
        }
        #endif
        return "ios-native"
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
        invalidateDeviceCommands()
        let socket = webSocket
        withTransportLock {
            webSocket = nil
            socketOpen = false
        }
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
        withTransportLock { socketOpen = false }
        update {
            $0.connection = .connecting
            $0.statusText = self.reconnectAttempts > 0 ? "重新连接中…（第 \(self.reconnectAttempts) 次）" : "连接中"
        }

        let task = urlSession.webSocketTask(with: url)
        withTransportLock { webSocket = task }
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
            lat: ProcessInfo.processInfo.systemUptime - lastLocationFixAt <= 15 ? location?.latitude : nil,
            lon: ProcessInfo.processInfo.systemUptime - lastLocationFixAt <= 15 ? location?.longitude : nil,
            testerId: testerId.isEmpty ? "ios-native" : testerId,
            testerRegion: TimeZone.current.identifier,
            testingCampaignId: testingCampaignId,
            testingTestCaseId: testingTestCaseId,
            testingRunId: testingRunId,
            testingAssignmentId: testingAssignmentId,
            appVersion: nativeAppVersion(),
            gitCommit: nativeGitCommit(),
            deviceLabel: nativeDeviceLabel(),
            browserLanguage: nativeBrowserLanguage(),
            networkType: nativeNetworkType(),
            memory: current.sessionMemory
        ))) { _ in }
        // The guided tour lives in the provider instance, so a fresh session
        // must be told about it again (mirrors the web client's open handler).
        if current.guidedDemo { task.send(.string(buildGuidedDemo(enabled: true))) { _ in } }
        if transmitting { task.send(.string(audioStartEvent)) { _ in } }
        // Mic frames wait for session.started, not merely the relay handshake.
        withTransportLock { socketOpen = false }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.isCurrentSocket(task) else { return }
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
                            #if DEBUG
                            self.syntheticAudioQAEvent?(text)
                            #endif
                            self.handleEvent(event)
                        }
                    }
                case .data(let data):
                    #if DEBUG
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.syntheticAudioQA else { return }
                        self.qaReceivedPCMBytes += data.count
                    }
                    #endif
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
            guard let self, self.isCurrentSocket(task) else { return }
            task.sendPing { _ in }
            self.schedulePing(on: task)
        }
    }

    private func handleSocketClosed(_ task: URLSessionWebSocketTask) {
        assert(Thread.isMainThread)
        // Ignore a socket already superseded by a newer one (e.g. a restart).
        if let current = webSocket, task !== current { return }
        invalidateDeviceCommands()
        stopCameraForSession()
        withTransportLock {
            socketOpen = false
            webSocket = nil
        }
        // This socket is gone — whatever nav.request it might have carried
        // will never get an answer on it (even a reconnect starts a fresh
        // relay session that doesn't know the old commandId). Resolve any
        // suspended request now rather than waiting out its own timeout.
        relayNavigationSearch.failPending()

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
            // The alert queues and survives reconnect — the network is
            // delivery-only. ANY active incident (check-in, alarm, or
            // escalated) must keep the session retrying, not only once a
            // crash.alert is already pending: the give-up threshold (~31 s of
            // backoff) lands well before escalation (~45 s: 15 s check-in +
            // 30 s alarm) can even build one. Vetoing on "has an incident"
            // rather than "has a pending alert" is what actually covers the
            // scenario this exists for — an unconscious rider can't
            // re-toggle hands-free, so keep retrying at a slow, indefinite
            // cadence instead of giving up. reconnectAttempts is deliberately
            // left over the threshold (not reset) so every subsequent
            // failure re-checks this condition — once the incident resolves
            // (ack/cancel/disarm), the very next failure falls through to the
            // normal give-up path below.
            if onCrash({ $0.hasActiveIncident }) {
                update {
                    $0.connection = .offline
                    $0.statusText = "网络中断 — 求助信息将在恢复后自动发送"
                }
                let work = DispatchWorkItem { [weak self] in self?.connect() }
                reconnectWorkItem = work
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.crashOutageRetryDelayS, execute: work)
                return
            }
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
            withTransportLock { socketOpen = true }
            update {
                $0.provider = provider
                $0.isLive = mode != "mock"
                $0.capabilities = capabilities
                $0.connection = .ready
                $0.statusText = mode == "mock" ? "模拟路线已启用" : "豆包实时语音在线"
            }
            onCrash { $0.socketBecameReady() }

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
                onCrash { $0.riderTranscript(text) }
                if final { Task { @MainActor [weak self] in self?.navigationController.handleConfirmationReply(text) } }
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
            withTransportLock { latestSpeedKmh = Double(rideContext.speedKmh) }
            update {
                $0.rideContext = rideContext
                $0.hasRideContext = true
            }

        case let .sessionMemoryUpdate(memory):
            update { $0.sessionMemory = memory }

        case let .telemetryUpdate(telemetry):
            update { $0.telemetry = telemetry }

        case let .hazardAlert(alert):
            handleHazardAlert(alert)

        case let .deviceCommand(command):
            #if DEBUG
            // Synthetic QA cannot operate real device actions, including calls
            // or message composition. Report a real command-result failure.
            if syntheticAudioQA {
                let json = buildDeviceResult(commandId: command.commandId, result: .failed("device.synthetic-qa-disabled"))
                webSocket?.send(.string(json)) { _ in }
                return
            }
            #endif
            guard let source = webSocket, state.handsFree else { return }
            MainActor.assumeIsolated {
                deviceCommands.submit(command, perform: { [weak self] command in
                    guard let self, source === self.webSocket, self.state.handsFree else {
                        return .failed("device.cancelled")
                    }
                    return await self.deviceRouter.handle(command)
                }, send: { [weak self] json in
                    guard let self, source === self.webSocket, self.state.handsFree else { return }
                    source.send(.string(json)) { _ in }
                })
            }

        case let .error(message):
            update { $0.statusText = message }

        case let .crashAck(incidentId, status, detail):
            onCrash { $0.handleAck(incidentId: incidentId, status: status, detail: detail) }

        case .crashSimulate:
            #if DEBUG
            if syntheticAudioQA { return }
            #endif
            onCrash { $0.handleSimulate() }

        case let .navRoute(data):
            relayNavigationSearch.handleNavRoute(data)

        case let .navError(commandId, code):
            relayNavigationSearch.handleNavError(commandId: commandId, code: code)

        case .unhandled:
            break
        }
    }

    /// Runs `body` while holding the transport lock. Every write to `webSocket`,
    /// `transmitting`, `micMuted`, or `socketOpen` goes through here so the
    /// off-main gate helpers observe a consistent value (and, for `webSocket`, a
    /// safely retained reference). Bodies are leaf field assignments — never take
    /// the lock recursively.
    private func withTransportLock(_ body: () -> Void) {
        transportLock.lock()
        defer { transportLock.unlock() }
        body()
    }

    /// Audio-thread mic gate: the socket to send this frame on — retained under
    /// the lock so a concurrent main-thread teardown can't over-release it — or
    /// nil to stay silent (not transmitting / muted / provider not yet ready).
    private func micSendTarget() -> URLSessionWebSocketTask? {
        transportLock.lock()
        defer { transportLock.unlock() }
        return (transmitting && !micMuted && socketOpen) ? webSocket : nil
    }

    /// Audio-thread visualizer gate: whether capture is actively feeding frames.
    private func captureActive() -> Bool {
        transportLock.lock()
        defer { transportLock.unlock() }
        return transmitting && !micMuted
    }

    /// CoreMotion-queue gate (~100 Hz): the most recent ride speed, or nil when
    /// unknown/no ride context yet. CrashController's `SystemMotionFeed` calls
    /// this synchronously from its background delivery queue — never read
    /// `state` (a `@Published` property) from there.
    private func latestSpeedKmhGate() -> Double? {
        transportLock.lock()
        defer { transportLock.unlock() }
        return latestSpeedKmh
    }

    /// Off-main identity check (URLSession delegate / ping queues) against the
    /// socket currently owned by the session.
    private func isCurrentSocket(_ task: URLSessionWebSocketTask) -> Bool {
        transportLock.lock()
        defer { transportLock.unlock() }
        return task === webSocket
    }

    /// URLSession has no public buffered-byte counter. Bound concurrent sends
    /// so slow links shed stale 20 ms frames instead of growing without limit.
    /// The target socket is captured on the audio thread via `micSendTarget()`.
    private func sendMicFrame(_ frame: Data, on task: URLSessionWebSocketTask) {
        micSendLock.lock()
        guard micSendsInFlight < Self.maxMicSendsInFlight else {
            micSendLock.unlock()
            return
        }
        micSendsInFlight += 1
        micSendLock.unlock()

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
        #if DEBUG
        let qaBefore = syntheticAudioQA ? player.syntheticAudioQASnapshot : nil
        #endif
        if alert.interrupt { stopAgentSpeech() }
        #if DEBUG
        let qaAfter = syntheticAudioQA ? player.syntheticAudioQASnapshot : nil
        #endif
        hazardAlertGeneration += 1
        let generation = hazardAlertGeneration
        #if DEBUG
        if syntheticAudioQA, alert.interrupt, let qaBefore, let qaAfter {
            // Synchronous around this exact hazard's stop; another main-thread
            // hearing/rider event cannot be mistaken for this interruption.
            syntheticAudioQAHazardInterrupt?(qaBefore.pendingBytes, qaAfter.pendingBytes, qaBefore.interruptedAudio, qaAfter.interruptedAudio, generation)
        }
        #endif
        update {
            $0.hazardAlert = alert
            $0.turnState = .speaking
            $0.statusText = "⚠️ \(alert.label)"
        }
        #if DEBUG
        if syntheticAudioQA { qaNextHazardSpeechGeneration = generation }
        #endif
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
        #if DEBUG
        if syntheticAudioQA { qaSpeechAttempts += 1 }
        #endif
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(
            language: detectLanguage(text) == "zh" ? "zh-CN" : "en-US"
        )
        #if DEBUG
        if syntheticAudioQA, let generation = qaNextHazardSpeechGeneration {
            qaHazardUtterances[ObjectIdentifier(utterance)] = (utterance, generation)
            qaNextHazardSpeechGeneration = nil
        }
        #endif
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
#if DEBUG
extension AgentSession: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.syntheticAudioQA else { return }
            self.qaSpeechStarts += 1
            if let entry = self.qaHazardUtterances.removeValue(forKey: ObjectIdentifier(utterance)) {
                self.qaStartedHazardGenerations.insert(entry.generation)
            }
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in self?.qaHazardUtterances.removeValue(forKey: ObjectIdentifier(utterance)) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in self?.qaHazardUtterances.removeValue(forKey: ObjectIdentifier(utterance)) }
    }
}
#endif

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

// MARK: - session location

/// The startup callback is bounded, but fresh fixes continue throughout the
/// hands-free session. A slow first fix must not become a permanently missing location.
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    private var completion: ((CLLocationCoordinate2D?) -> Void)?
    private var generation = 0
    private var tracking = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
    }

    func resolve(_ completion: @escaping (CLLocationCoordinate2D?) -> Void) {
        generation += 1
        let owner = generation
        self.completion = completion
        tracking = true
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways: requestCurrentLocation()
        default: finish(nil)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, self.generation == owner else { return }
            self.finish(nil)
        }
    }

    func stop() {
        generation += 1
        tracking = false
        completion = nil
        onUpdate = nil
        manager.stopUpdatingLocation()
    }

    static func isFresh(_ location: CLLocation, now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(location.timestamp)
        return age >= -5 && age <= 15 && location.horizontalAccuracy.isFinite
            && location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 100
            && CLLocationCoordinate2DIsValid(location.coordinate)
    }

    private func requestCurrentLocation() {
        guard tracking else { return }
        manager.startUpdatingLocation()
        if let cached = manager.location, Self.isFresh(cached) { accept(cached) }
    }

    private func accept(_ location: CLLocation) {
        guard tracking, Self.isFresh(location) else { return }
        onUpdate?(location.coordinate)
        finish(location.coordinate)
    }

    private func finish(_ coordinate: CLLocationCoordinate2D?) {
        let callback = completion
        completion = nil
        callback?(coordinate)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let fix = locations.last(where: { Self.isFresh($0) }) { accept(fix) }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(nil) }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard tracking else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: requestCurrentLocation()
        case .denied, .restricted: manager.stopUpdatingLocation(); finish(nil)
        default: break
        }
    }
}
