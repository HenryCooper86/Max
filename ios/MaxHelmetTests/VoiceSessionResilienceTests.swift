import AVFoundation
import XCTest
@testable import MaxHelmet

// MARK: - fakes

@MainActor
private final class FakeAudioEvents: AudioSessionEventSource {
    var handler: (@MainActor (AudioSessionEvent) -> Void)?
    var stops = 0
    func start(_ handler: @escaping @MainActor (AudioSessionEvent) -> Void) { self.handler = handler }
    func stop() { handler = nil; stops += 1 }
    func send(_ event: AudioSessionEvent) { handler?(event) }
}

@MainActor
private final class FakeNetwork: NetworkPathSource {
    var handler: (@MainActor (NetworkPathSnapshot) -> Void)?
    var stops = 0
    func start(_ handler: @escaping @MainActor (NetworkPathSnapshot) -> Void) { self.handler = handler }
    func stop() { handler = nil; stops += 1 }
    func send(_ satisfied: Bool, _ interface: NetworkInterface? = .wifi) {
        handler?(NetworkPathSnapshot(satisfied: satisfied, interface: interface))
    }
}

/// A manual clock: work runs only when the test advances past its deadline.
@MainActor
private final class ManualScheduler: ResilienceScheduling {
    private final class Entry: ResilienceTimer {
        let deadline: TimeInterval
        let work: @MainActor () -> Void
        var cancelled = false
        init(deadline: TimeInterval, work: @escaping @MainActor () -> Void) { self.deadline = deadline; self.work = work }
        func cancel() { cancelled = true }
    }
    private(set) var now: TimeInterval = 0
    private var entries: [Entry] = []
    var pending: Int { entries.filter { !$0.cancelled }.count }

    func schedule(after delay: TimeInterval, _ work: @escaping @MainActor () -> Void) -> ResilienceTimer {
        let entry = Entry(deadline: now + delay, work: work)
        entries.append(entry)
        return entry
    }

    func advance(by seconds: TimeInterval) {
        let target = now + seconds
        while let next = entries.filter({ !$0.cancelled && $0.deadline <= target }).min(by: { $0.deadline < $1.deadline }) {
            now = next.deadline
            next.cancelled = true
            next.work()
        }
        now = target
        entries.removeAll { $0.cancelled }
    }
}

@MainActor
private final class FakeCalls: CallStateSource {
    var callInProgress = false
}

@MainActor
private final class RecordingActions: VoiceResilienceActions {
    var log: [String] = []
    var resumeResults: [Bool] = []
    var rerouteResults: [Bool] = []
    var rebuildResults: [Bool] = []
    var statuses: [VoiceAudioStatus] = []

    func suspendAudio() { log.append("suspend") }
    func resumeAudio() -> Bool { log.append("resume"); return resumeResults.isEmpty ? true : resumeResults.removeFirst() }
    func rerouteAudio() -> Bool { log.append("reroute"); return rerouteResults.isEmpty ? true : rerouteResults.removeFirst() }
    func rebuildAudio() -> Bool { log.append("rebuild"); return rebuildResults.isEmpty ? true : rebuildResults.removeFirst() }
    func networkBecameUnavailable() { log.append("offline") }
    func networkBecameAvailable(interfaceChanged: Bool) { log.append(interfaceChanged ? "online:changed" : "online") }
    func voiceAudioStatusChanged(_ status: VoiceAudioStatus) { statuses.append(status) }
}

@MainActor
final class VoiceSessionResilienceTests: XCTestCase {
    private var audio: FakeAudioEvents!
    private var network: FakeNetwork!
    private var clock: ManualScheduler!
    private var actions: RecordingActions!
    private var calls: FakeCalls!
    private var resilience: VoiceSessionResilience!

    override func setUp() async throws {
        audio = FakeAudioEvents()
        network = FakeNetwork()
        clock = ManualScheduler()
        actions = RecordingActions()
        calls = FakeCalls()
        resilience = VoiceSessionResilience(audioEvents: audio, network: network, scheduler: clock, calls: calls)
        resilience.actions = actions
        resilience.activate()
    }

    // MARK: interruptions

    func testInterruptionPausesOnceAndReportsIt() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionBegan(appWasSuspended: false))
        XCTAssertEqual(actions.log, ["suspend"])
        XCTAssertEqual(resilience.audioStatus, .interrupted)
        XCTAssertEqual(actions.statuses, [.interrupted])
    }

    func testInterruptionEndingWithShouldResumeResumesAtOnce() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: true))
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
        XCTAssertEqual(actions.statuses, [.interrupted, .recovering, .live])
    }

    func testAPhoneCallEndingWithoutShouldResumeStillRecoversAfterAGrace() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: false))
        XCTAssertEqual(actions.log, ["suspend"], "give the call's audio a moment to let go first")
        clock.advance(by: VoiceSessionResilience.resumeGraceWithoutShouldResume)
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testAFailedResumeRetriesWithBackoffThenReportsFailure() {
        actions.resumeResults = Array(repeating: false, count: 10)
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: true))
        XCTAssertEqual(actions.log.filter { $0 == "resume" }.count, 1)
        for delay in VoiceSessionResilience.retryDelays { clock.advance(by: delay) }
        XCTAssertEqual(actions.log.filter { $0 == "resume" }.count, 1 + VoiceSessionResilience.retryDelays.count)
        XCTAssertEqual(resilience.audioStatus, .failed)
        let afterBackoff = actions.log.filter { $0 == "resume" }.count
        clock.advance(by: VoiceSessionResilience.slowRetryInterval * 4)
        XCTAssertEqual(actions.log.filter { $0 == "resume" }.count, afterBackoff + 4, "a riding session never gives up; it keeps a slow schedule")
    }

    func testReturningToTheAppRecoversWhenTheEndOfAnInterruptionNeverArrived() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.appBecameActive)
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testReturningToTheAppRetriesAfterAGiveUp() {
        actions.resumeResults = Array(repeating: false, count: 1 + VoiceSessionResilience.retryDelays.count)
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: true))
        for delay in VoiceSessionResilience.retryDelays { clock.advance(by: delay) }
        XCTAssertEqual(resilience.audioStatus, .failed)
        audio.send(.appBecameActive)
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testReturningToTheAppWhileLiveDoesNothing() {
        audio.send(.appBecameActive)
        XCTAssertEqual(actions.log, [])
    }

    // MARK: interruptions that never end

    func testAnInterruptionWithoutAnEndIsRetriedOnASlowSchedule() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        clock.advance(by: VoiceSessionResilience.slowRetryInterval - 0.1)
        XCTAssertEqual(actions.log, ["suspend"])
        clock.advance(by: 0.1)
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
        clock.advance(by: VoiceSessionResilience.slowRetryInterval * 3)
        XCTAssertEqual(actions.log, ["suspend", "resume"], "the schedule stops once audio is back")
    }

    func testTheSlowScheduleWaitsOutAPhoneCall() {
        calls.callInProgress = true
        audio.send(.interruptionBegan(appWasSuspended: false))
        clock.advance(by: VoiceSessionResilience.slowRetryInterval * 3)
        XCTAssertEqual(actions.log, ["suspend"], "no attempt while a call holds the audio")
        XCTAssertEqual(resilience.audioStatus, .interrupted)
        calls.callInProgress = false
        clock.advance(by: VoiceSessionResilience.slowRetryInterval)
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testAFailedSlowAttemptKeepsTheInterruptedStatusAndTriesAgain() {
        actions.resumeResults = [false, true]
        audio.send(.interruptionBegan(appWasSuspended: false))
        clock.advance(by: VoiceSessionResilience.slowRetryInterval)
        XCTAssertEqual(resilience.audioStatus, .interrupted)
        clock.advance(by: VoiceSessionResilience.slowRetryInterval)
        XCTAssertEqual(actions.log, ["suspend", "resume", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testAnEndedInterruptionIsNotResumedDuringACall() {
        calls.callInProgress = true
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: true))
        XCTAssertEqual(actions.log, ["suspend"])
        calls.callInProgress = false
        clock.advance(by: VoiceSessionResilience.slowRetryInterval)
        XCTAssertEqual(actions.log.last, "resume")
    }

    func testABeganDeliveredForASuspendedAppIsResumedAtOnce() {
        audio.send(.interruptionBegan(appWasSuspended: true))
        XCTAssertEqual(actions.log, ["suspend", "resume"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testARouteChangeStartsAnAttemptAfterRecoveryFailed() {
        actions.resumeResults = Array(repeating: false, count: 1 + VoiceSessionResilience.retryDelays.count)
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: true))
        for delay in VoiceSessionResilience.retryDelays { clock.advance(by: delay) }
        XCTAssertEqual(resilience.audioStatus, .failed)
        let before = actions.log.count
        audio.send(.routeChanged(.deviceAdded))
        clock.advance(by: VoiceSessionResilience.routeDebounce)
        XCTAssertEqual(actions.log.count, before + 1)
        XCTAssertEqual(actions.log.last, "resume", "a failed session retries the full resume when a headset appears")
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testDeactivateStopsTheSlowSchedule() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        resilience.deactivate()
        clock.advance(by: VoiceSessionResilience.slowRetryInterval * 4)
        XCTAssertEqual(actions.log, ["suspend"])
        XCTAssertEqual(clock.pending, 0)
    }

    // MARK: route changes

    func testARouteChangeBurstIsDebouncedIntoOneReroute() {
        audio.send(.routeChanged(.deviceAdded))
        clock.advance(by: 0.05)
        audio.send(.routeChanged(.categoryChanged))
        clock.advance(by: 0.05)
        audio.send(.routeChanged(.deviceRemoved))
        XCTAssertEqual(actions.log, [])
        clock.advance(by: VoiceSessionResilience.routeDebounce)
        XCTAssertEqual(actions.log, ["reroute"])
        clock.advance(by: 10)
        XCTAssertEqual(actions.log, ["reroute"])
    }

    func testRouteChangesDuringAnInterruptionWaitForTheResume() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.routeChanged(.deviceRemoved))
        clock.advance(by: 5)
        XCTAssertEqual(actions.log, ["suspend"])
    }

    func testAFailedRerouteIsRetried() {
        actions.rerouteResults = [false, true]
        audio.send(.routeChanged(.deviceAdded))
        clock.advance(by: VoiceSessionResilience.routeDebounce)
        XCTAssertEqual(actions.log, ["reroute"])
        XCTAssertEqual(resilience.audioStatus, .recovering)
        clock.advance(by: VoiceSessionResilience.retryDelays[0])
        XCTAssertEqual(actions.log, ["reroute", "reroute"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    // MARK: media services reset

    func testMediaServicesResetRebuildsImmediatelyAndSupersedesAPendingReroute() {
        audio.send(.routeChanged(.deviceAdded))
        audio.send(.mediaServicesReset)
        XCTAssertEqual(actions.log, ["rebuild"])
        clock.advance(by: 5)
        XCTAssertEqual(actions.log, ["rebuild"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    func testMediaServicesResetDuringAnInterruptionStillRebuilds() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.mediaServicesReset)
        XCTAssertEqual(actions.log, ["suspend", "rebuild"])
        XCTAssertEqual(resilience.audioStatus, .live)
    }

    // MARK: network path

    func testLosingAndRegainingTheNetworkIsReportedOncePerTransition() {
        network.send(true)
        XCTAssertEqual(actions.log, [], "the first satisfied path is the starting point, not a change")
        network.send(false, nil)
        network.send(false, nil)
        XCTAssertEqual(actions.log, ["offline"])
        XCTAssertFalse(resilience.networkAvailable)
        network.send(true, .cellular)
        network.send(true, .cellular)
        XCTAssertEqual(actions.log, ["offline", "online"])
        XCTAssertTrue(resilience.networkAvailable)
    }

    func testStartingOfflineIsReported() {
        network.send(false, nil)
        XCTAssertEqual(actions.log, ["offline"])
    }

    func testAHandoverBetweenInterfacesIsReported() {
        network.send(true, .wifi)
        network.send(true, .cellular)
        XCTAssertEqual(actions.log, ["online:changed"])
    }

    // MARK: lifecycle

    func testDeactivateStopsListeningAndCancelsPendingWork() {
        audio.send(.routeChanged(.deviceAdded))
        audio.send(.interruptionBegan(appWasSuspended: false))
        audio.send(.interruptionEnded(shouldResume: false))
        resilience.deactivate()
        clock.advance(by: 60)
        XCTAssertEqual(actions.log, ["suspend"])
        XCTAssertEqual(audio.stops, 1)
        XCTAssertEqual(network.stops, 1)
        XCTAssertNil(audio.handler)
        XCTAssertEqual(clock.pending, 0)
    }

    func testReactivationStartsFresh() {
        audio.send(.interruptionBegan(appWasSuspended: false))
        resilience.deactivate()
        resilience.activate()
        XCTAssertEqual(resilience.audioStatus, .live)
        XCTAssertTrue(resilience.networkAvailable)
        audio.send(.interruptionBegan(appWasSuspended: false))
        XCTAssertEqual(actions.log, ["suspend", "suspend"])
    }
}

// MARK: - notification parsing

@MainActor
final class AudioSessionNotificationParsingTests: XCTestCase {
    private func note(_ name: Notification.Name, _ info: [AnyHashable: Any] = [:]) -> Notification {
        Notification(name: name, object: nil, userInfo: info)
    }

    func testInterruptionNotifications() {
        let began = note(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        XCTAssertEqual(audioSessionEvent(from: began), .interruptionBegan(appWasSuspended: false))

        let suspended = note(AVAudioSession.interruptionNotification, [
            AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue,
            AVAudioSessionInterruptionReasonKey: AVAudioSession.InterruptionReason.appWasSuspended.rawValue,
        ])
        XCTAssertEqual(audioSessionEvent(from: suspended), .interruptionBegan(appWasSuspended: true))

        let resume = note(AVAudioSession.interruptionNotification, [
            AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
            AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue,
        ])
        XCTAssertEqual(audioSessionEvent(from: resume), .interruptionEnded(shouldResume: true))

        let noOption = note(AVAudioSession.interruptionNotification, [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        XCTAssertEqual(audioSessionEvent(from: noOption), .interruptionEnded(shouldResume: false))

        XCTAssertNil(audioSessionEvent(from: note(AVAudioSession.interruptionNotification)), "malformed")
    }

    func testRouteChangeReasons() {
        func reason(_ r: AVAudioSession.RouteChangeReason) -> AudioSessionEvent? {
            audioSessionEvent(from: note(AVAudioSession.routeChangeNotification, [AVAudioSessionRouteChangeReasonKey: r.rawValue]))
        }
        XCTAssertEqual(reason(.newDeviceAvailable), .routeChanged(.deviceAdded))
        XCTAssertEqual(reason(.oldDeviceUnavailable), .routeChanged(.deviceRemoved))
        XCTAssertEqual(reason(.categoryChange), .routeChanged(.categoryChanged))
        XCTAssertEqual(reason(.routeConfigurationChange), .routeChanged(.other))
        XCTAssertEqual(reason(.wakeFromSleep), .routeChanged(.other))
        XCTAssertEqual(reason(.noSuitableRouteForCategory), .routeChanged(.other))
        XCTAssertNil(reason(.unknown))
    }

    func testMediaServicesResetAndAppActivation() {
        XCTAssertEqual(audioSessionEvent(from: note(AVAudioSession.mediaServicesWereResetNotification)), .mediaServicesReset)
        XCTAssertEqual(audioSessionEvent(from: note(UIApplication.didBecomeActiveNotification)), .appBecameActive)
        XCTAssertNil(audioSessionEvent(from: note(.AVAudioEngineConfigurationChange)), "the engine's own observer handles that one")
    }

    func testTheSystemSourceDeliversPostedNotificationsOnMain() {
        let center = NotificationCenter()
        let source = SystemAudioSessionEvents(center: center)
        let delivered = expectation(description: "event")
        source.start { event in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(event, .mediaServicesReset)
            delivered.fulfill()
        }
        DispatchQueue.global().async {
            center.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        }
        wait(for: [delivered], timeout: 2)
        source.stop()
    }
}

// MARK: - reconnect budget

final class ReconnectPolicyTests: XCTestCase {
    func testOnlineDropsBackOffThenGiveUp() {
        var policy = ReconnectPolicy()
        let delays = (1...ReconnectPolicy.maxAttempts).map { _ in policy.socketDropped(hasActiveIncident: false) }
        XCTAssertEqual(delays, [
            .retry(afterMs: 1_000), .retry(afterMs: 2_000), .retry(afterMs: 4_000),
            .retry(afterMs: 8_000), .retry(afterMs: 8_000), .retry(afterMs: 8_000),
        ])
        XCTAssertEqual(policy.socketDropped(hasActiveIncident: false), .giveUp)
        XCTAssertEqual(policy.attempts, 0)
    }

    func testDropsWhileOfflineDoNotSpendTheBudget() {
        var policy = ReconnectPolicy()
        _ = policy.networkChanged(available: false)
        for _ in 0..<20 { XCTAssertEqual(policy.socketDropped(hasActiveIncident: false), .waitForNetwork) }
        XCTAssertEqual(policy.attempts, 0)
        XCTAssertTrue(policy.networkChanged(available: true))
        XCTAssertEqual(policy.socketDropped(hasActiveIncident: false), .retry(afterMs: 1_000))
    }

    func testRegainingTheNetworkResetsTheBudgetAndAsksForAnImmediateReconnect() {
        var policy = ReconnectPolicy()
        for _ in 0..<5 { _ = policy.socketDropped(hasActiveIncident: false) }
        XCTAssertEqual(policy.attempts, 5)
        XCTAssertFalse(policy.networkChanged(available: true), "already online: nothing changed")
        _ = policy.networkChanged(available: false)
        XCTAssertTrue(policy.networkChanged(available: true))
        XCTAssertEqual(policy.attempts, 0)
    }

    func testAnActiveCrashIncidentNeverGivesUp() {
        var policy = ReconnectPolicy()
        for _ in 0..<ReconnectPolicy.maxAttempts { _ = policy.socketDropped(hasActiveIncident: true) }
        XCTAssertEqual(policy.socketDropped(hasActiveIncident: true), .crashOutageRetry)
        XCTAssertEqual(policy.socketDropped(hasActiveIncident: true), .crashOutageRetry)
        XCTAssertEqual(policy.socketDropped(hasActiveIncident: false), .giveUp, "once the incident resolves the normal give-up applies")
    }

    func testAnOpenSocketResetsTheBudget() {
        var policy = ReconnectPolicy()
        _ = policy.socketDropped(hasActiveIncident: false)
        policy.connected()
        XCTAssertEqual(policy.attempts, 0)
    }
}

// MARK: - audio session activation

private final class FakeVoiceAudioSession: VoiceAudioSessionControlling {
    var category: AVAudioSession.Category = .soloAmbient
    var mode: AVAudioSession.Mode = .default
    var categoryOptions: AVAudioSession.CategoryOptions = []
    var bluetoothRouteActive = false
    var setCategoryCalls = 0
    var activations: [Bool] = []
    var failActivation = false

    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws {
        setCategoryCalls += 1
        self.category = category
        self.mode = mode
        categoryOptions = options
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        if active && failActivation { throw NSError(domain: "test", code: 561_017_449) }
        activations.append(active)
    }
}

final class AudioRouterTests: XCTestCase {
    func testStartingConfiguresVoiceChatAndActivates() {
        let session = FakeVoiceAudioSession()
        let router = AudioRouter(session: session)
        router.startVoiceRouting()
        XCTAssertEqual(session.category, .playAndRecord)
        XCTAssertEqual(session.mode, .voiceChat)
        XCTAssertEqual(session.categoryOptions, AudioRouter.voiceOptions)
        XCTAssertEqual(session.activations, [true])
    }

    func testReassertingAnIntactSessionDoesNotResetTheCategory() {
        // Setting the category posts a categoryChange route notification;
        // re-setting it on every route change would feed itself.
        let session = FakeVoiceAudioSession()
        let router = AudioRouter(session: session)
        router.startVoiceRouting()
        XCTAssertTrue(router.reassertVoiceRouting())
        XCTAssertEqual(session.setCategoryCalls, 1)
        XCTAssertEqual(session.activations, [true, true])
    }

    func testReassertingRestoresACategorySomethingElseChanged() {
        let session = FakeVoiceAudioSession()
        let router = AudioRouter(session: session)
        router.startVoiceRouting()
        session.category = .playback
        XCTAssertTrue(router.reassertVoiceRouting())
        XCTAssertEqual(session.category, .playAndRecord)
        XCTAssertEqual(session.setCategoryCalls, 2)
    }

    func testReassertingReportsAnActivationThatIsStillRefused() {
        let session = FakeVoiceAudioSession()
        let router = AudioRouter(session: session)
        router.startVoiceRouting()
        session.failActivation = true
        XCTAssertFalse(router.reassertVoiceRouting())
        session.failActivation = false
        XCTAssertTrue(router.reassertVoiceRouting())
    }

    func testStopDeactivatesOnlyWhatItActivated() {
        let session = FakeVoiceAudioSession()
        let router = AudioRouter(session: session)
        router.stopVoiceRouting()
        XCTAssertEqual(session.activations, [])
        router.startVoiceRouting()
        router.stopVoiceRouting()
        XCTAssertEqual(session.activations, [true, false])
    }
}

// MARK: - playback across an engine stop

#if DEBUG
final class PcmPlayerEngineStopTests: XCTestCase {
    /// An interruption or route change stops the shared engine underneath the
    /// player. A barge-in arriving then must not start the node on the stopped
    /// engine, and once the engine is back the next utterance must actually
    /// play: before the fix the player still believed it was armed and queued
    /// every later reply into a silent node.
    func testBargeInWhileTheEngineIsStoppedAndPlaybackAfterRestart() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try audio.setActive(true)
        defer { try? audio.setActive(false) }
        let engine = AVAudioEngine()
        let player = PcmPlayer(engine: engine)
        player.prepare()
        engine.prepare()
        do { try engine.start() } catch { throw XCTSkip("this simulator has no audio output: \(error)") }
        defer { player.release(); engine.stop() }

        player.play(Data(repeating: 0, count: 48_000))
        _ = player.syntheticAudioQASnapshot   // drains the player's queue
        XCTAssertTrue(player.syntheticAudioQASnapshot.nodePlaying)

        engine.stop()
        player.stopPlayback()
        XCTAssertFalse(player.syntheticAudioQASnapshot.nodePlaying)

        try engine.start()
        player.play(Data(repeating: 0, count: 48_000))
        XCTAssertTrue(player.syntheticAudioQASnapshot.nodePlaying, "the node must be re-armed once the engine runs again")
    }
}
#endif

// MARK: - what the rider sees

final class AudioInterruptionPresentationTests: XCTestCase {
    func testTheHeadlineSaysWhenAudioIsPausedByAnInterruption() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.audioInterrupted = true
        XCTAssertEqual(readoutHeadline(state, name: "Max"), L("main.audioPaused"))
        XCTAssertEqual(L("main.audioPaused", in: .en), "Paused for a call or Siri")
        state.audioInterrupted = false
        XCTAssertNotEqual(readoutHeadline(state, name: "Max"), L("main.audioPaused"))
    }

    func testRecoveryStatusLinesAreTranslated() {
        for key in ["st.audioInterrupted", "st.audioResumed", "st.audioResumeFailed", "st.networkWaiting", "main.audioPaused"] {
            XCTAssertNotEqual(Loc.string(key, .zh), key)
            XCTAssertNil(Loc.string(key, .en).range(of: "\\p{Han}", options: .regularExpression), key)
        }
    }
}
