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
        var statusText = L("conn.offline")
        var provider = ""
        var isLive = false
        /// Provider capabilities advertised by session.started (mirror of
        /// ProviderCapabilities in shared/agent.ts). Defaults match the web's
        /// DEFAULT_CAPABILITIES (all off) until the relay reports the real set.
        var capabilities = ProviderCapabilities()
        /// The camera is on and the assistant is being sent what it shows.
        var liveVideo = false
        /// Live video comes from the back camera, not the front one.
        var liveVideoBackCamera = false
        var turnState: TurnState = .idle
        /// Mic muted mid-session: the relay stays open and Max can keep speaking,
        /// but rider audio frames are withheld (ChatGPT-style mute).
        var micMuted = false
        var voiceGender: VoiceGender = .female
        var voicePersonality: VoicePersonality = .concise
        var voiceLevel: Float = 0
        /// Voice backend id the rider picked (relay `/health.voice.providers`),
        /// sent as `voiceProvider` in session.start. Nil = relay default.
        var voiceProvider: String? = UserDefaults.standard.string(forKey: "voice_provider")
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
        /// False until the first ride.context event.
        var hasRideContext = false
        /// The ride speed the safety gates use (fresh GPS, else a relay value
        /// that was actually sent), nil when unknown. Refreshed on every fix.
        var speedKmh: Double? = nil
        /// Guided demo ride: the mock provider auto-tours the scenario catalog.
        var guidedDemo = false
        /// The relay refused the credentials — HTTP 401 on the upgrade, or close
        /// code 1008 once connected — so a login (or token) is required. The UI
        /// opens the account settings when this flips on.
        var authRequired = false
        /// Transcript ids above this floor belong to the CURRENT relay session
        /// and may be flagged via turn.feedback (the relay matches inside its
        /// live session transcript, so a restored/previous-session turn could
        /// tag the wrong turn). Int.max = nothing flaggable (offline).
        var feedbackFloorId = Int.max
        /// Crash-detection UI phase, owned entirely by CrashController.onUIChange.
        var crashPhase: CrashUIPhase = .hidden
        /// A call, Siri or another app took the audio; capture and playback are
        /// paused while the relay session stays open.
        var audioInterrupted = false
        /// Recovery after an interruption or route change gave up; the rider
        /// has to restart hands-free.
        var audioRecoveryFailed = false
        /// The relay dropped while the phone had no network at all; reconnect
        /// waits for the network instead of spending its retry budget.
        var networkWaiting = false
        /// A relay-side tool (a lookup) is running for the current turn.
        var toolActivityBusy = false
        /// A short-lived line for the HUD (device heat, Low Power Mode).
        var transientNotice: String? = nil
        /// The phone is critically hot: decorative animation stops too.
        var thermalShedding = false
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
    static let maxReconnectAttempts = ReconnectPolicy.maxAttempts
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

    /// Local ordering regression uses the identical transport dispatcher without
    /// opening a relay or enabling microphone/location capture.
    func deliverSyntheticAudioQAMessage(_ message: URLSessionWebSocketTask.Message) {
        precondition(syntheticAudioQA)
        dispatchReceivedMessage(message, accepts: { [weak self] in self?.syntheticAudioQA == true })
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
    private var reconnectPolicy = ReconnectPolicy()
    private var reconnectWorkItem: DispatchWorkItem?
    /// True once the microphone actually started for this session; recovery
    /// restarts capture only if there was capture to restart.
    private var captureStarted = false
    /// Agent audio that arrives while a call holds the audio is stale by the
    /// time it ends; drop it rather than queue it for later.
    private var audioSuspended = false
    private var toolActivity = ToolActivityTracker()
    private var transientNoticeGeneration = 0
    /// A media-services reset happened while no audio was running; the engine
    /// object is dead and is replaced before audio next starts.
    private var engineRebuildPending = false
    @MainActor private lazy var mediaResetObserver = MediaServicesResetObserver()
    /// The socket session.start (and any audio.start) went out on. Pausing
    /// and resuming the microphone sends audio.stop/audio.start only on it.
    private weak var handshakeSocket: URLSessionWebSocketTask?
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
    /// The relay's limits on pictures, counted per connection. Main thread.
    fileprivate var imageLimiter = ImageInputLimiter()
    /// Live video: pacing and when it stops (VideoInput.swift), the camera, and
    /// the once-a-second tick. Frames are not pictures and use none of the
    /// imageLimiter's budget. Main thread.
    fileprivate var liveVideoState = LiveVideoState()
    let videoCamera = VideoCamera()
    fileprivate var videoTimer: Timer?
    fileprivate var videoEncoding = false
    private let micSendLock = NSLock()
    private var micSendsInFlight = 0
    private static let maxMicSendsInFlight = 4
    /// Plain mirror of `state.micMuted`, read off the audio thread alongside
    /// `transmitting` so the mic callback never touches `@Published` state.
    private var micMuted = false
    /// Ride speed from the phone's GPS (primary) and the relay (only when it
    /// sent one). Read by CrashController's motion feed on CoreMotion's
    /// background queue at ~100 Hz, so it carries its own lock — never touch
    /// `@Published` state off-main.
    private let rideSpeed = RideSpeedTracker()
    /// Serializes the transport-gate fields (`webSocket`, `transmitting`,
    /// `micMuted`, `socketOpen`): the main thread writes them,
    /// but the audio-render thread (mic callbacks, `sendMicFrame`), the URLSession
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
    private var voiceEngine = AVAudioEngine()
    private lazy var player = PcmPlayer(engine: voiceEngine)
    /// The one capture store shared by the camera handler (writes) and the
    /// gallery UI (reads).
    let captureStore = CaptureStore()
    /// Supplied by MainViewModel (Task 12); safe defaults until then.
    var crashSettingsProvider: () -> CrashSettings = {
        CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false)
    }
    private let audioRouter = AudioRouter()
    @MainActor private lazy var resilience: VoiceSessionResilience = {
        let resilience = VoiceSessionResilience(
            audioEvents: SystemAudioSessionEvents(),
            network: SystemNetworkPathMonitor(),
            scheduler: MainQueueResilienceScheduler(),
            calls: SystemCallState()
        )
        resilience.actions = self
        return resilience
    }()
    /// Watches heat and Low Power Mode for the whole app lifetime: camera work
    /// can be asked for by voice only during a session, but a recording
    /// started then must still stop if the phone heats up.
    @MainActor private(set) lazy var thermalGovernor: ThermalGovernor = {
        let governor = ThermalGovernor(source: SystemThermalStateSource())
        governor.onAnnouncement = { [weak self] in self?.announceThermal($0) }
        governor.onPolicyChange = { [weak self] in self?.applyCapturePolicy($0) }
        return governor
    }()
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
            motion: SystemMotionFeed(
                speedProvider: { [weak self] in self?.rideSpeed.crashSpeedKmh },
                gateSpeedProvider: { [weak self] in self?.rideSpeed.crashGateSpeedKmh }
            ),
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
        onAutoStopped: { [weak self] in self?.speak(L("st.recordingSaved")) },
        capturePolicy: { [weak self] in self?.thermalGovernor.policy ?? .unrestricted }
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
            .torch: TorchController(device: torchDevice),
            .volume: PlaybackVolumeController(gain: player),
            .music: MusicController(player: music),
            .sms: MessageComposer(
                presenter: MainActorMessagePresenter(),
                // Unknown speed is refused by the composer itself.
                speedProvider: { [weak self] in self?.rideSpeed.currentSpeedKmh },
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
                },
                capturePolicy: { [snapshot = thermalGovernor.snapshot] in snapshot.value }
            )
        ],
        isDeviceUnlocked: { UIApplication.shared.isProtectedDataAvailable },
        loadRefusal: { [snapshot = thermalGovernor.snapshot] action in loadRefusal(for: action, policy: snapshot.value) }
    )
    private let torchDevice = SystemTorchDevice()

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
                MainActor.assumeIsolated { self.resilience.deactivate() }
                self.onCrash { $0.disarm() }
            }
        }
        MainActor.assumeIsolated {
            thermalGovernor.start()
            mediaResetObserver.onReset = { [weak self] in
                guard let self else { return }
                // During a session the coordinator receives the same
                // notification and rebuilds; otherwise remember it.
                if mediaServicesResetAction(sessionAudioActive: self.resilience.isActive) == .rebuildOnNextStart {
                    self.engineRebuildPending = true
                }
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
        reconnectWorkItem = nil

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
        // A stale ride's speed must not outlive it — otherwise
        // CrashController's speed gate could see a leftover fast reading
        // before the first fix of the new session arrives.
        rideSpeed.reset()
        reconnectPolicy.reset()
        captureStarted = false
        audioSuspended = false
        toolActivity.reset()
        withTransportLock {
            transmitting = true
            micMuted = false
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
            $0.speedKmh = nil
            $0.audioInterrupted = false
            $0.audioRecoveryFailed = false
            $0.networkWaiting = false
            $0.toolActivityBusy = false
        }
        #if DEBUG
        if syntheticAudioQA {
            // No location, motion, microphone permission or capture occurs.
            if !connect() {
                failHandsFreeStart(generation: generation, message: L("st.badRelayURL"))
            }
            return
        }
        #endif
        onCrash { $0.arm() }
        MainActor.assumeIsolated { resilience.activate() }

        lastLocationSentAt = -.infinity
        // The session's own location stream doubles as the speed source for
        // crash detection and the SMS gate: it runs for as long as crash
        // detection is armed and location permission allows, so no second
        // high-accuracy stream is started.
        rideSpeed.observe(locationProvider)
        locationProvider.onUpdate = { [weak self] coordinate in
            guard let self, self.lifecycle.accepts(generation) else { return }
            self.location = coordinate
            let now = ProcessInfo.processInfo.systemUptime
            self.lastLocationFixAt = now
            self.publishRideSpeed()
            guard self.state.value.connection == .ready, now - self.lastLocationSentAt >= 10 else { return }
            self.lastLocationSentAt = now
            let json = buildLocationUpdate(
                lat: coordinate.latitude, lon: coordinate.longitude,
                speedKmh: self.rideSpeed.freshGpsSpeedKmh
            )
            self.webSocket?.send(.string(json)) { _ in }
        }
        locationProvider.resolve { [weak self] coordinate in
            guard let self else { return }
            guard self.lifecycle.accepts(generation) else { return }
            self.location = coordinate
            guard self.connect() else {
                self.failHandsFreeStart(generation: generation, message: L("st.badRelayURLSettings"))
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
                    self.failHandsFreeStart(generation: generation, message: L("st.micPermission"))
                    return
                }
                do {
                    // Attach the playback node first so it renders through the
                    // shared engine before the mic starts it — the engine's output
                    // is the echo-cancellation reference signal.
                    if self.engineRebuildPending { self.replaceVoiceEngine() }
                    self.player.prepare()
                    try self.mic.start()
                    self.captureStarted = true
                    // Any agent audio that arrived while the permission dialog was
                    // up (e.g. the opening greeting) was buffered — play it now
                    // that the shared engine is running.
                    self.player.flushPending()
                } catch {
                    self.failHandsFreeStart(generation: generation, message: L("st.micUnavailable"))
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
        // Before the socket goes: the relay is told the video is over.
        MainActor.assumeIsolated { stopLiveVideo() }
        locationProvider.stop()
        location = nil
        withTransportLock {
            transmitting = false
            micMuted = false
        }
        intentionalClose = true
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
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
        captureStarted = false
        audioSuspended = false
        toolActivity.reset()
        if hasActiveIncident {
            mic.pauseCapture()
        } else {
            // An open incident keeps listening so its siren comes back after a
            // call; onIncidentResolved deactivates it.
            MainActor.assumeIsolated { resilience.deactivate() }
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
            $0.statusText = L("conn.offline")
            $0.turnState = .idle
            $0.voiceLevel = 0
            $0.micMuted = false
            $0.bluetoothRouted = false
            $0.hazardAlert = nil
            $0.feedbackFloorId = Int.max
            $0.audioInterrupted = false
            $0.audioRecoveryFailed = false
            $0.networkWaiting = false
            $0.toolActivityBusy = false
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
                $0.statusText = L("st.demoTour")
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
            $0.statusText = gender == .male ? L("st.voiceMale") : L("st.voiceFemale")
        }
        restartIfConnected()
    }

    static let voiceProviderDefaultsKey = "voice_provider"

    /// Switches the relay's voice backend. Like the voice gender, it is fixed at
    /// session.start, so a live session reconnects to pick it up.
    func setVoiceProvider(_ id: String) {
        guard !id.isEmpty, state.value.voiceProvider != id else { return }
        UserDefaults.standard.set(id, forKey: Self.voiceProviderDefaultsKey)
        update { $0.voiceProvider = id }
        restartIfConnected()
    }

    func setVoicePersonality(_ personality: VoicePersonality) {
        guard state.value.voicePersonality != personality else { return }
        update {
            $0.voicePersonality = personality
            $0.statusText = L("st.persona", ("p", personality.label))
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

    /// The app language changed: a live session restarts so the assistant
    /// speaks the new language (same as changing the voice).
    func languageChanged() { restartIfConnected() }

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
        let value = (Bundle.main.infoDictionary?["MaxGitCommit"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("$(") else { return "unknown" }
        let isGitCommit = value.range(of: "^[0-9a-fA-F]{7,40}$", options: .regularExpression) != nil
        return isGitCommit ? String(value.prefix(12)).lowercased() : String(value.prefix(80))
    }

    private func restartSession() {
        invalidateDeviceCommands()
        MainActor.assumeIsolated { stopLiveVideo() }
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
            self.reconnectPolicy.connected()
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
        rideSpeed.relayConnectionLost()
        update {
            $0.connection = .connecting
            $0.statusText = self.reconnectPolicy.attempts > 0 ? L("st.reconnecting", ("n", String(self.reconnectPolicy.attempts))) : L("conn.connecting")
            $0.networkWaiting = false
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
        reconnectPolicy.connected()
        update {
            $0.connection = .relay
            $0.statusText = L("st.ready")
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
            memory: current.sessionMemory,
            voiceProvider: current.voiceProvider,
            language: VisorTheme.shared.language.rawValue
        ))) { _ in }
        // The guided tour lives in the provider instance, so a fresh session
        // must be told about it again (mirrors the web client's open handler).
        if current.guidedDemo { task.send(.string(buildGuidedDemo(enabled: true))) { _ in } }
        if transmitting { task.send(.string(audioStartEvent)) { _ in } }
        handshakeSocket = task
        toolActivity.reset()
        update { $0.toolActivityBusy = false }
        // Mic frames wait for session.started, not merely the relay handshake.
        withTransportLock { socketOpen = false }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.isCurrentSocket(task) else { return }
            switch result {
            case .success(let message):
                self.dispatchReceivedMessage(message, accepts: { [weak self] in
                    self?.isCurrentSocket(task) == true
                })
                self.receive(on: task)
            case .failure:
                DispatchQueue.main.async { [weak self] in
                    guard let self, task === self.webSocket else { return }
                    self.handleSocketClosed(task)
                }
            }
        }
    }

    private func dispatchReceivedMessage(_ message: URLSessionWebSocketTask.Message, accepts: @escaping () -> Bool) {
        switch message {
        case .string(let text):
            let event = parseAgentEvent(text)
            DispatchQueue.main.async { [weak self] in
                guard let self, accepts() else { return }
                if case .unhandled = event, !text.contains("\"type\"") {
                    self.update { $0.statusText = L("st.badAgent") }
                } else {
                    #if DEBUG
                    self.syntheticAudioQAEvent?(text)
                    #endif
                    self.handleEvent(event)
                }
            }
        case .data(let data):
            // Use the same serial main queue as preceding text events. Otherwise
            // later PCM can play before an earlier queued rider ASR event runs,
            // and that ASR event then cuts the agent's own new response.
            DispatchQueue.main.async { [weak self] in
                guard let self, accepts() else { return }
                #if DEBUG
                if self.syntheticAudioQA { self.qaReceivedPCMBytes += data.count }
                #endif
                guard !self.audioSuspended else { return }
                // Conversion/scheduling still runs on PcmPlayer's own queue.
                self.player.play(data)
            }
        @unknown default:
            break
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
        // The socket is gone, so there is no one to tell: the camera goes off.
        MainActor.assumeIsolated { stopLiveVideo() }
        rideSpeed.relayConnectionLost()
        publishRideSpeed()
        // This socket is gone — whatever nav.request it might have carried
        // will never get an answer on it (even a reconnect starts a fresh
        // relay session that doesn't know the old commandId). Resolve any
        // suspended request now rather than waiting out its own timeout.
        relayNavigationSearch.failPending()

        if intentionalClose {
            if state.value.handsFree { return } // restartSession() will reconnect
            update {
                $0.connection = .offline
                $0.statusText = L("conn.offline")
            }
            return
        }

        // The relay closed the session for good (docs/protocol.md, Close
        // codes): reconnecting with the same account would only be refused
        // again, so hands-free ends instead and the status says why. An idle
        // close ends it like the web client's stopMic on 4001: leaving the
        // session half-alive kept the mic capturing, the audio route claimed,
        // and the orb pulsing "listening" with no session behind it.
        if let close = FinalRelayClose(task.closeCode.rawValue) {
            endHandsFree(for: close)
            return
        }

        // The relay answered but refused the WebSocket upgrade. Retrying can't
        // fix either case: 401 means the relay requires a login token (accounts
        // are active on the shared relay — see the web HUD's 复制令牌 button),
        // anything else is a configuration problem (e.g. wrong path → HTTP 400).
        if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 {
            reconnectPolicy.reset()
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
                    ? L("st.authRequired")
                    : L("st.relayRefused", ("status", String(status)))
            }
            return
        }

        // Unexpected drop: reconnect with exponential backoff (mirrors src/main.tsx).
        switch reconnectPolicy.socketDropped(hasActiveIncident: onCrash({ $0.hasActiveIncident })) {
        case .waitForNetwork:
            // No network at all is not the relay's fault: keep the budget and
            // let networkBecameAvailable() reconnect the moment it returns. A
            // slow check stays scheduled in case the path monitor is wrong.
            update {
                $0.connection = .offline
                $0.networkWaiting = true
                $0.statusText = L("st.networkWaiting")
            }
            scheduleReconnect(after: .seconds(Int(Self.crashOutageRetryDelayS)))

        case .crashOutageRetry:
            // The alert queues and survives reconnect — the network is
            // delivery-only. ANY active incident (check-in, alarm, or
            // escalated) must keep the session retrying, not only once a
            // crash.alert is already pending: the give-up threshold (~31 s of
            // backoff) lands well before escalation (~45 s: 15 s check-in +
            // 30 s alarm) can even build one. An unconscious rider can't
            // re-toggle hands-free, so keep retrying at a slow, indefinite
            // cadence instead of giving up; once the incident resolves the
            // next failure falls through to the normal give-up.
            update {
                $0.connection = .offline
                $0.statusText = L("st.networkLost")
            }
            scheduleReconnect(after: .seconds(Int(Self.crashOutageRetryDelayS)))

        case .giveUp:
            stop()
            update {
                $0.connection = .degraded
                $0.statusText = L("st.relayFailed")
            }

        case let .retry(delayMs):
            update {
                $0.connection = .offline
                $0.statusText = L("st.disconnected", ("n", String(delayMs / 1000)))
            }
            scheduleReconnect(after: .milliseconds(delayMs))
        }
    }

    private func scheduleReconnect(after delay: DispatchTimeInterval) {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        let work = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Ends hands-free for a close the rider cannot reconnect past (see
    /// FinalRelayClose) and leaves its reason on the HUD.
    private func endHandsFree(for close: FinalRelayClose) {
        reconnectPolicy.reset()
        stop()
        update {
            // An idle session ended normally; the other closes are failures.
            if close != .idleEnded { $0.connection = .degraded }
            $0.statusText = close.statusText
            // Refused credentials get the HTTP 401 treatment: the UI opens
            // the account settings, and a sign-in restarts hands-free.
            $0.authRequired = close == .credentialsRejected
        }
    }

    // MARK: - event handling

    private func handleEvent(_ event: AgentEvent) {
        switch event {
        case let .sessionStarted(provider, mode, capabilities):
            withTransportLock { socketOpen = true }
            imageLimiter.reset()
            // A session that takes no video ends what is on; one that does starts its pacing afresh.
            if liveVideoState.sessionStarted(videoInput: capabilities.videoInput) {
                webSocket?.send(.string(videoStopEvent)) { _ in }
                liveVideoEnded()
            }
            // Only the mock demo's ride.context speed is a real scenario value;
            // a live relay just echoes the phone's own earlier GPS speed.
            rideSpeed.sessionStarted(mock: mode == "mock")
            publishRideSpeed()
            update {
                $0.provider = provider
                $0.isLive = mode != "mock"
                $0.capabilities = capabilities
                $0.connection = .ready
                $0.statusText = mode == "mock" ? L("st.mockRoute") : L("st.doubaoLive")
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
            rideSpeed.recordRelay(speedKmh: rideContext.speedKmh.map(Double.init))
            update {
                $0.rideContext = rideContext
                $0.hasRideContext = true
            }
            publishRideSpeed()

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

        case let .toolActivity(activity):
            let now = ProcessInfo.processInfo.systemUptime
            toolActivity.apply(activity, now: now)
            update { $0.toolActivityBusy = self.toolActivity.isBusy }
            if activity.state == .started {
                DispatchQueue.main.asyncAfter(deadline: .now() + ToolActivityTracker.staleAfter) { [weak self] in
                    guard let self else { return }
                    self.toolActivity.expire(now: ProcessInfo.processInfo.systemUptime)
                    self.update { $0.toolActivityBusy = self.toolActivity.isBusy }
                }
            }

        case let .toolCall(callId, name):
            if let reply = unexpectedToolCallReply(callId: callId, name: name) {
                webSocket?.send(.string(reply)) { _ in }
            }

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

    /// Mirrors the resolved ride speed into the HUD state (main thread only).
    private func publishRideSpeed() {
        let speed = rideSpeed.currentSpeedKmh
        update { $0.speedKmh = speed }
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
                $0.statusText = L("st.interrupted", ("name", Visor.assistantName))
            }
        }
    }

    private func speak(_ text: String) {
        #if DEBUG
        if syntheticAudioQA { qaSpeechAttempts += 1 }
        #endif
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: speechVoiceLanguage(for: text))
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

// MARK: - relay close codes

/// A relay close code that ends hands-free instead of reconnecting
/// (docs/protocol.md, Close codes; shouldReconnect in sdk/src/protocol.ts):
/// reconnecting with the same account would only be refused again. Mirrors
/// FinalRelayClose in android/.../AgentSession.kt.
enum FinalRelayClose: Equatable {
    /// 4001: the session sat idle, or the relay ended the conversation.
    case idleEnded
    /// 4003: the account's voice minutes are used up until next month.
    case minutesUsedUp
    /// 1008: the relay refused the credentials (signed out, expired or revoked).
    case credentialsRejected

    init?(_ closeCode: Int) {
        switch closeCode {
        case 4001: self = .idleEnded
        case 4003: self = .minutesUsedUp
        case 1008: self = .credentialsRejected
        default: return nil
        }
    }

    /// What the HUD says once the session has ended.
    var statusText: String {
        switch self {
        case .idleEnded: return L("st.idleEnded")
        case .minutesUsedUp: return L("st.minutesUsedUp")
        case .credentialsRejected: return L("st.signInAgain")
        }
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
        // Demo relay support: a test relay may use a self-signed
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
final class LocationProvider: NSObject, CLLocationManagerDelegate, RideLocationSource {
    private let manager = CLLocationManager()
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    /// Every accepted fix, speed included, for the ride-speed tracker.
    var onFix: ((CLLocation) -> Void)?
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
        onFix = nil
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
        onFix?(location)
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

// MARK: - interruption, route and network recovery

extension AgentSession: VoiceResilienceActions {
    /// True once handleSocketOpened has run for the current socket, which is
    /// when audio.start/audio.stop may go out on it. A socket still opening
    /// sends audio.start itself if `transmitting` is set by then.
    private var relayHandshakeSent: Bool {
        guard let webSocket, let handshakeSocket else { return false }
        return webSocket === handshakeSocket
    }

    /// A call or Siri took the audio and the system has stopped the engine.
    /// Take the tap off so nothing is captured, drop what the agent was saying,
    /// and tell the relay the microphone paused: binary frames outside
    /// audio.start/audio.stop are a protocol error. The relay session stays.
    func suspendAudio() {
        audioSuspended = true
        synthesizer.stopSpeaking(at: .immediate)
        player.stopPlayback()
        if captureStarted { mic.pauseCapture() }
        let wasTransmitting = transmitting
        withTransportLock { transmitting = false }
        if wasTransmitting && relayHandshakeSent { webSocket?.send(.string(audioStopEvent)) { _ in } }
        update {
            $0.audioInterrupted = true
            $0.audioRecoveryFailed = false
            $0.voiceLevel = 0
            $0.turnState = .idle
            $0.statusText = L("st.audioInterrupted")
        }
    }

    func resumeAudio() -> Bool {
        guard restoreAudioPath() else { return false }
        resumeTransmitting()
        return true
    }

    func rerouteAudio() -> Bool {
        restoreAudioPath()
    }

    /// After a media-services reset every audio object is dead, the shared
    /// engine included. Build a new engine, move capture and playback onto it,
    /// and start again as on a first start.
    func rebuildAudio() -> Bool {
        guard audioPathWanted.playback else {
            // Nothing to restart now; build the new engine when audio next
            // starts, and never leave a suspended state behind.
            engineRebuildPending = true
            resumeTransmitting()
            return true
        }
        replaceVoiceEngine()
        guard restoreAudioPath(forceCategory: true) else { return false }
        resumeTransmitting()
        return true
    }

    private func replaceVoiceEngine() {
        let engine = AVAudioEngine()
        voiceEngine = engine
        mic.rebind(to: engine)
        player.rebind(to: engine)
        engineRebuildPending = false
    }

    #if DEBUG
    var debugAudioSuspended: Bool { audioSuspended }
    var debugEngineRebuildPending: Bool { engineRebuildPending }
    #endif

    func networkBecameUnavailable() {
        _ = reconnectPolicy.networkChanged(available: false)
        guard lifecycle.active, webSocket == nil else { return }
        update {
            $0.networkWaiting = true
            $0.statusText = L("st.networkWaiting")
        }
    }

    func networkBecameAvailable(interfaceChanged: Bool) {
        let restored = reconnectPolicy.networkChanged(available: true)
        update { $0.networkWaiting = false }
        guard lifecycle.active, !intentionalClose else { return }
        if webSocket == nil {
            // Only a reconnect that is already waiting is brought forward; a
            // session still resolving its first location will connect itself.
            guard reconnectWorkItem != nil else { return }
            reconnectWorkItem?.cancel()
            reconnectWorkItem = nil
            reconnectPolicy.connected()
            connect()
        } else if restored || interfaceChanged {
            probeRelaySocket()
        }
    }

    func voiceAudioStatusChanged(_ status: VoiceAudioStatus) {
        switch status {
        case .failed:
            update {
                $0.audioRecoveryFailed = true
                $0.statusText = L("st.audioResumeFailed")
            }
        case .live:
            update { $0.audioRecoveryFailed = false }
        case .interrupted, .recovering:
            break
        }
    }

    private var audioPathWanted: (capture: Bool, playback: Bool) {
        let capture = lifecycle.active && captureStarted
        return (capture, capture || onCrash { $0.hasActiveIncident })
    }

    /// Re-activates the voice session and gets the shared engine running with
    /// whatever this session needs from it: capture plus playback for a live
    /// ride, playback alone for the siren of an incident that outlived it.
    @discardableResult
    private func restoreAudioPath(forceCategory: Bool = false) -> Bool {
        let wanted = audioPathWanted
        guard wanted.playback else { return true }
        guard audioRouter.reassertVoiceRouting(forceCategory: forceCategory) else { return false }
        do {
            if wanted.capture {
                if mic.isCapturing {
                    guard mic.ensureRunning() else { return false }
                } else {
                    player.prepare()
                    try mic.start()
                }
            } else if !voiceEngine.isRunning {
                player.prepare()
                voiceEngine.prepare()
                try voiceEngine.start()
            }
        } catch {
            return false
        }
        player.flushPending()
        update { $0.bluetoothRouted = self.audioRouter.hasBluetoothHeadset }
        return true
    }

    private func resumeTransmitting() {
        audioSuspended = false
        guard lifecycle.active else { return }
        let wasTransmitting = transmitting
        // audio.start goes out before frames can: the mic callback only sends
        // once `transmitting` is set below.
        if !wasTransmitting && relayHandshakeSent { webSocket?.send(.string(audioStartEvent)) { _ in } }
        withTransportLock { transmitting = true }
        update {
            $0.audioInterrupted = false
            $0.audioRecoveryFailed = false
            $0.turnState = .listening
            if !wasTransmitting { $0.statusText = L("st.audioResumed") }
        }
    }

    /// After a handover the socket may be bound to an interface that is gone,
    /// and TCP can take minutes to notice. A ping that fails, or gets no pong
    /// within a few seconds, cancels it; the receive loop then reports the
    /// drop and the normal reconnect takes over.
    private func probeRelaySocket() {
        guard let task = webSocket else { return }
        final class Answer { var received = false }
        let answer = Answer()
        task.sendPing { [weak self] error in
            DispatchQueue.main.async {
                guard let self, task === self.webSocket, !answer.received else { return }
                answer.received = true
                if error != nil { task.cancel(with: .goingAway, reason: nil) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, task === self.webSocket, !answer.received else { return }
            answer.received = true
            task.cancel(with: .goingAway, reason: nil)
        }
    }
}

// MARK: - typed turns, device heat

extension AgentSession {
    /// Sends a typed turn. The relay echoes it back as a final rider
    /// transcript, so nothing is added to the captions here.
    @discardableResult
    func sendTextInput(_ raw: String) -> Result<Void, TextInputRejection> {
        let current = state
        let ready = socketOpen && current.connection == .ready
        // Typing at speed is refused like composing an SMS; an unknown speed
        // is allowed so a phone with no GPS fix (indoors) can still type.
        switch prepareTextInput(raw, textInputSupported: current.capabilities.textInput, ready: ready, speedKmh: rideSpeed.currentSpeedKmh) {
        case let .success(json):
            // A new turn supersedes whatever the agent was still saying.
            stopAgentSpeech()
            webSocket?.send(.string(json)) { _ in }
            return .success(())
        case let .failure(reason):
            return .failure(reason)
        }
    }

    /// Shows the model a picture: a JPEG as base64, already scaled to fit
    /// (see jpegBase64ForImageInput). With `text` it is a typed turn with the
    /// picture attached; without, the model sees it with the user's next turn.
    @MainActor @discardableResult
    func sendImageInput(jpegBase64: String, text: String? = nil) -> Result<Void, ImageInputRejection> {
        let current = state
        let ready = socketOpen && current.connection == .ready
        let now = ProcessInfo.processInfo.systemUptime
        switch prepareImageInput(
            jpegBase64: jpegBase64,
            text: text,
            imageInputSupported: current.capabilities.imageInput,
            ready: ready,
            speedKmh: rideSpeed.currentSpeedKmh
        ) {
        case let .success(json):
            // A picture that cannot go is not counted, and is not said to have gone.
            guard let webSocket else { return .failure(.notReady) }
            if let refused = imageLimiter.rejection(at: now) { return .failure(refused) }
            imageLimiter.didSend(at: now)
            // With words it is a turn of the user's, which supersedes whatever the agent was still saying.
            if !(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { stopAgentSpeech() }
            webSocket.send(.string(json)) { _ in }
            return .success(())
        case let .failure(reason):
            return .failure(reason)
        }
    }

    /// Turns the camera on and sends the assistant a frame a second until
    /// `stopLiveVideo`. The assistant sees the newest frame with the user's
    /// next turn; a frame starts nothing. Says why when it could not start.
    @MainActor
    func startLiveVideo() async -> VideoStartResult {
        guard !liveVideoState.active else { return .started }
        guard liveVideoReady() else { return .notReady }
        // One camera at a time: a recording keeps it, and a photo or a recording asked for later takes it.
        guard !state.recording else { return .busy }
        cameraController.willUseCamera = { [weak self] in self?.stopLiveVideo() }
        videoCamera.onLost = { [weak self] in self?.stopLiveVideo() }
        let result = await videoCamera.start(position: .front)
        guard result == .started else { return result }
        // The session may have ended while the user was asked for the camera.
        guard liveVideoState.begin(supported: state.capabilities.videoInput, ready: liveVideoReadyNow()) else {
            videoCamera.stop()
            return .notReady
        }
        update {
            $0.liveVideo = true
            $0.liveVideoBackCamera = false
        }
        let timer = Timer(timeInterval: videoInputInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sendLiveVideoFrame() }
        }
        // In the common modes, so frames keep going while the conversation is being scrolled.
        RunLoop.main.add(timer, forMode: .common)
        videoTimer = timer
        // The first frame as soon as the camera has one, not a whole second later.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            MainActor.assumeIsolated { self?.sendLiveVideoFrame() }
        }
        return .started
    }

    /// Turns the camera off and tells the relay (`video.stop`). Also on session
    /// end, a lost connection and the app going to the background.
    @MainActor
    func stopLiveVideo() {
        guard liveVideoState.active else { return }
        if liveVideoState.end(ready: liveVideoReadyNow()) {
            webSocket?.send(.string(videoStopEvent)) { _ in }
        }
        liveVideoEnded()
    }

    /// Switches between the front and the back camera.
    @MainActor
    func switchLiveVideoCamera() async {
        guard liveVideoState.active, await videoCamera.switchCamera() else { return }
        update { $0.liveVideoBackCamera = self.videoCamera.position == .back }
    }

    private func liveVideoEnded() {
        videoTimer?.invalidate()
        videoTimer = nil
        videoCamera.stop()
        update { $0.liveVideo = false }
    }

    private func liveVideoReadyNow() -> Bool { socketOpen && state.connection == .ready }

    @MainActor private func liveVideoReady() -> Bool { state.capabilities.videoInput && liveVideoReadyNow() }

    /// Takes the newest frame, makes its JPEG off the main thread (one at a
    /// time) and sends it. A frame that cannot be made to fit is skipped; the
    /// next is a second away.
    @MainActor private func sendLiveVideoFrame() {
        guard liveVideoState.active else { return }
        videoCamera.keepLevel()
        guard !videoEncoding, let buffer = videoCamera.takeNewestFrame() else { return }
        videoEncoding = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let jpeg = jpegBase64ForVideoFrame(buffer)
            DispatchQueue.main.async {
                guard let self else { return }
                self.videoEncoding = false
                guard let jpeg else { return }
                self.sendVideoFrame(jpegBase64: jpeg)
            }
        }
    }

    @MainActor @discardableResult
    func sendVideoFrame(jpegBase64: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Result<Void, VideoInputRejection> {
        switch liveVideoState.frameEvent(
            jpegBase64: jpegBase64,
            supported: state.capabilities.videoInput,
            ready: liveVideoReadyNow(),
            now: now
        ) {
        case let .success(json):
            webSocket?.send(.string(json)) { _ in }
            return .success(())
        case let .failure(reason):
            return .failure(reason)
        }
    }

    @MainActor fileprivate func announceThermal(_ announcement: ThermalAnnouncement) {
        let line = L(announcement.messageKey)
        if announcement.spoken && state.handsFree { speak(line) }
        showTransientNotice(line)
    }

    @MainActor fileprivate func applyCapturePolicy(_ policy: CapturePolicy) {
        update { $0.thermalShedding = policy.shedNonEssential }
        shedExtrasForHeat(policy, torch: torchDevice, music: music, hudCast: hudCast)
        guard state.recording else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await self.cameraController.enforce(policy)
        }
    }

    private func showTransientNotice(_ text: String) {
        transientNoticeGeneration += 1
        let generation = transientNoticeGeneration
        update {
            $0.transientNotice = text
            $0.statusText = text
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, self.transientNoticeGeneration == generation else { return }
            self.update { $0.transientNotice = nil }
        }
    }
}
