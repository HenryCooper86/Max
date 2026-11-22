import AVFoundation
import CoreLocation
import XCTest
@testable import MaxHelmet

private func gpsFix(kmh: Double, at time: Date, speedAccuracy: Double = 1) -> CLLocation {
    CLLocation(
        coordinate: CLLocationCoordinate2D(latitude: 31.23, longitude: 121.47),
        altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5,
        course: 90, courseAccuracy: 5,
        speed: kmh < 0 ? -1 : kmh / 3.6, speedAccuracy: speedAccuracy,
        timestamp: time
    )
}

// MARK: - A. a stale GPS speed must not veto crash confirmation

final class CrashSpeedFeedTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 5_000)

    func testAFixWithoutUsableSpeedRecordsUnknownInsteadOfKeepingTheOldValue() {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.record(gpsFix(kmh: 50, at: t0))
        now = t0.addingTimeInterval(1)
        tracker.record(gpsFix(kmh: -1, at: now))
        XCTAssertNil(tracker.currentSpeedKmh, "the newest fix says the speed is unknown")
        tracker.record(gpsFix(kmh: 50, at: now))
        tracker.record(gpsFix(kmh: 50, at: now, speedAccuracy: 3.5))
        XCTAssertNil(tracker.crashSpeedKmh)
    }

    func testTheCrashFeedForgetsGpsSpeedAfterTwoSecondsOthersAfterFive() {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.record(gpsFix(kmh: 50, at: t0))
        now = t0.addingTimeInterval(2.5)
        XCTAssertNil(tracker.crashSpeedKmh)
        XCTAssertEqual(tracker.currentSpeedKmh!, 50, accuracy: 0.001)
        now = t0.addingTimeInterval(5.5)
        XCTAssertNil(tracker.currentSpeedKmh)
        XCTAssertEqual(RideSpeedTracker.crashGpsFreshness, 2)
        XCTAssertEqual(RideSpeedTracker.gpsFreshness, 5)
    }

    func testSpeedAccuracyLimitIsThreeMetresPerSecond() {
        XCTAssertNotNil(gpsSpeedKmh(from: gpsFix(kmh: 30, at: t0, speedAccuracy: 3.0)))
        XCTAssertNil(gpsSpeedKmh(from: gpsFix(kmh: 30, at: t0, speedAccuracy: 3.01)))
    }

    private enum AfterImpact { case noFixes, invalidFixes, validFixesToZero, keepRiding }

    /// Synthetic: 1 Hz GPS at 50 km/h, a 60 ms 9 g impact at t = 2 s with no
    /// tumble, then either the phone lies still (three GPS behaviours) or the
    /// rider simply rides on after a pothole. Speed reaches the engine only
    /// through the crash feed, exactly as SystemMotionFeed reads it.
    private func run(_ after: AfterImpact) -> (effects: [CrashEffect], checkInAt: Double?) {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.sessionStarted(mock: false)
        var state = CrashState.armed
        var effects: [CrashEffect] = []
        var checkInAt: Double?
        var nextFix = 0.0
        for i in 0..<1_000 {
            let t = Double(i) / 100
            now = t0.addingTimeInterval(t)
            let impact = t >= 2.0 && t < 2.06
            let afterImpact = t >= 2.06
            if t >= nextFix {
                nextFix += 1
                if !afterImpact || after == .keepRiding {
                    tracker.record(gpsFix(kmh: 50, at: now))
                } else {
                    switch after {
                    case .noFixes: break
                    case .invalidFixes: tracker.record(gpsFix(kmh: -1, at: now))
                    case .validFixesToZero: tracker.record(gpsFix(kmh: t < 4 ? 12 : 0, at: now))
                    case .keepRiding: break
                    }
                }
            }
            let still = afterImpact && after != .keepRiding
            let accel = impact ? 9.0 : (still ? 0.01 + 0.01 * Double(i % 3) / 2 : 0.2 + 0.25 * Double(i % 7) / 6)
            let sample = CrashSample(t: t, accelG: accel, rotationRadS: still ? 0.02 : 0.3, speedKmh: tracker.crashSpeedKmh)
            for update in [CrashEngine.step(sample: sample, state: state)] {
                state = update.state
                if update.effects.contains(.speakCheckIn), checkInAt == nil { checkInAt = t }
                effects += update.effects
            }
            let tick = CrashEngine.tick(now: t, state: state)
            state = tick.state
            effects += tick.effects
        }
        return (effects, checkInAt)
    }

    func testImpactThenNoFurtherFixesReachesCheckInWithinTheConfirmWindow() {
        let result = run(.noFixes)
        XCTAssertEqual(result.effects.first, .speakCheckIn)
        XCTAssertLessThan(try XCTUnwrap(result.checkInAt), 2.02 + CrashTuning.standard.confirmWindowS)
    }

    func testImpactThenFixesWithoutSpeedReachesCheckIn() {
        let result = run(.invalidFixes)
        XCTAssertEqual(result.effects.first, .speakCheckIn)
        XCTAssertLessThan(try XCTUnwrap(result.checkInAt), 2.02 + CrashTuning.standard.confirmWindowS)
    }

    func testImpactThenSpeedFallingToZeroReachesCheckIn() {
        let result = run(.validFixesToZero)
        XCTAssertEqual(result.effects.first, .speakCheckIn)
        XCTAssertLessThan(try XCTUnwrap(result.checkInAt), 2.02 + CrashTuning.standard.confirmWindowS)
    }

    func testRidingOnAtSpeedAfterAPotholeStillDoesNotTrigger() {
        XCTAssertEqual(run(.keepRiding).effects, [])
    }
}

// MARK: - B. the relay's speed is trusted only in a mock session

final class RelaySpeedTrustTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 9_000)

    func testInALiveSessionTheEchoedSpeedIsIgnoredSoATunnelStaysUnknown() async {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.sessionStarted(mock: false)
        // Stopped at a light: GPS says 0 and the relay echoes 0 back.
        tracker.record(gpsFix(kmh: 0, at: t0))
        tracker.recordRelay(speedKmh: 0)
        // Into a tunnel at speed: no more fixes.
        now = t0.addingTimeInterval(RideSpeedTracker.gpsFreshness + 1)
        XCTAssertNil(tracker.currentSpeedKmh, "the echo of an old GPS reading is not a speed")

        struct Presenter: MessagePresenting { func present(number: String, body: String) async -> Bool { true } }
        struct Resolver: ContactResolving {
            func isAuthorized() async -> Bool { true }
            func number(matching name: String) async -> String? { "13800000000" }
        }
        let sms = await MessageComposer(presenter: Presenter(), speedProvider: { tracker.currentSpeedKmh }, resolver: Resolver())
            .perform(.smsCompose(name: "妈妈", body: "到了"))
        XCTAssertEqual(sms, .denied("unsafe.speed"))
        XCTAssertFalse(typedInputLockedForSpeed(tracker.currentSpeedKmh), "unknown speed: typing follows the allow-when-unknown rule")
    }

    func testAMockSessionStillSeesTheScenarioSpeed() {
        let tracker = RideSpeedTracker(now: { self.t0 })
        tracker.sessionStarted(mock: true)
        tracker.recordRelay(speedKmh: 58)
        XCTAssertEqual(tracker.currentSpeedKmh, 58)
        XCTAssertNil(tracker.crashSpeedKmh, "crash detection uses the phone's GPS only, in every mode")
    }

    func testRelaySpeedIsIgnoredUntilTheModeIsKnownAndClearedWhenItIsLearned() {
        let tracker = RideSpeedTracker(now: { self.t0 })
        tracker.recordRelay(speedKmh: 40)
        XCTAssertNil(tracker.currentSpeedKmh, "before session.started the mode is unknown")
        tracker.sessionStarted(mock: true)
        XCTAssertNil(tracker.currentSpeedKmh, "learning the mode starts from a clean slate")
        tracker.recordRelay(speedKmh: 40)
        XCTAssertEqual(tracker.currentSpeedKmh, 40)
        tracker.sessionStarted(mock: false)
        XCTAssertNil(tracker.currentSpeedKmh)
        tracker.recordRelay(speedKmh: 40)
        XCTAssertNil(tracker.currentSpeedKmh)
    }

    func testResetForgetsTheMode() {
        let tracker = RideSpeedTracker(now: { self.t0 })
        tracker.sessionStarted(mock: true)
        tracker.reset()
        tracker.recordRelay(speedKmh: 40)
        XCTAssertNil(tracker.currentSpeedKmh)
    }
}

// MARK: - D. media-services reset outside a session

@MainActor
final class MediaServicesResetTests: XCTestCase {
    func testTheDecisionDependsOnWhetherAudioIsRunning() {
        XCTAssertEqual(mediaServicesResetAction(sessionAudioActive: true), .rebuildNow)
        XCTAssertEqual(mediaServicesResetAction(sessionAudioActive: false), .rebuildOnNextStart)
    }

    func testTheLifetimeObserverSeesResetsWithoutASession() {
        let center = NotificationCenter()
        let observer = MediaServicesResetObserver(center: center)
        var resets = 0
        observer.onReset = { resets += 1 }
        center.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(resets, 1)
    }

    #if DEBUG
    func testARebuildWithNothingRunningMarksTheEngineAndClearsASuspendedState() {
        let session = AgentSession()
        session.suspendAudio()
        XCTAssertTrue(session.debugAudioSuspended)
        XCTAssertTrue(session.rebuildAudio())
        XCTAssertFalse(session.debugAudioSuspended, "a suspended state must not survive a rebuild")
        XCTAssertTrue(session.debugEngineRebuildPending)
    }
    #endif
}

// MARK: - E. heat arriving while a recording is starting

private final class SlowStartSession: CaptureSessioning, @unchecked Sendable {
    var started: [URL] = []
    var stopped = 0
    var onStart: (() -> Void)?
    func authorization() -> CameraAuthorization { .authorized }
    func requestAccess() async -> Bool { true }
    func capturePhoto() async throws -> Data { Data([1]) }
    func startRecording(to url: URL) async throws { started.append(url); onStart?() }
    func stopRecording() async throws -> URL { stopped += 1; return started.last ?? URL(fileURLWithPath: "/tmp/x.mov") }
}

private final class CountingStore: CaptureStoring, @unchecked Sendable {
    var indexed = 0
    func hasSpace() -> Bool { true }
    func captures() -> [Capture] { [] }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture { Capture(id: "p", type: .photo, filename: "p", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t") }
    func indexVideo(at url: URL) throws -> Capture { indexed += 1; return Capture(id: "v", type: .video, filename: "v", createdAt: 0, durationSec: 1, exported: false, thumbnailName: "t") }
    func markExported(_ id: String) {}
    func delete(_ id: String) {}
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/x") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/t") }
}

@MainActor
final class HeatDuringRecordingStartTests: XCTestCase {
    func testHeatThatArrivesWhileTheRecordingStartsStopsItOnceItRuns() async {
        let session = SlowStartSession()
        let store = CountingStore()
        var policy = CapturePolicy.unrestricted
        session.onStart = { policy = capturePolicy(heat: .serious, lowPowerMode: false) }
        let controller = CameraController(
            session: session, store: store, onRecordingChange: { _ in }, onOpenGallery: {}, onAutoStopped: {},
            capturePolicy: { policy }
        )
        let result = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(result, .denied("device.hot"))
        XCTAssertEqual(session.stopped, 1)
        XCTAssertEqual(store.indexed, 1, "the second it did record is kept")
    }

    func testLowPowerModeArrivingDuringTheStartDoesNotStopIt() async {
        let session = SlowStartSession()
        var policy = CapturePolicy.unrestricted
        session.onStart = { policy = capturePolicy(heat: .nominal, lowPowerMode: true) }
        let controller = CameraController(
            session: session, store: CountingStore(), onRecordingChange: { _ in }, onOpenGallery: {}, onAutoStopped: {},
            capturePolicy: { policy }
        )
        let result = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(session.stopped, 0)
    }
}

// MARK: - F. cross-platform constants

final class CrossPlatformConstantTests: XCTestCase {
    func testSpeedGatesAreFiveKilometresPerHour() {
        XCTAssertEqual(MessageComposer.maximumSpeedKmh, 5.0)
        XCTAssertFalse(typedInputLockedForSpeed(4.9))
        XCTAssertTrue(typedInputLockedForSpeed(5.0))
        XCTAssertEqual(RideSpeedTracker.maximumSpeedAccuracyMps, 3.0)
    }

    func testHeatAndPowerSaveRefusalsAreDenied() {
        XCTAssertEqual(CaptureRefusal.hot.result, .denied("device.hot"))
        XCTAssertEqual(CaptureRefusal.lowPower.result, .denied("device.powerSave"))
    }

    func testTextInputLimitIsCountedInUTF16() {
        let bmp = String(repeating: "好", count: 2000)
        XCTAssertNotNil(try? prepareTextInput(bmp, textInputSupported: true, ready: true).get())
        let emoji = String(repeating: "😀", count: 1001)   // 2002 UTF-16 units
        XCTAssertEqual(prepareTextInput(emoji, textInputSupported: true, ready: true), .failure(.tooLong))
    }

    func testTheFieldClampsToTheLimitWithoutSplittingACharacter() {
        let clamped = clampToTextInputLimit(String(repeating: "😀", count: 1001))
        XCTAssertEqual(clamped.utf16.count, 2000)
        XCTAssertEqual(clamped.count, 1000)
        let odd = clampToTextInputLimit("a" + String(repeating: "😀", count: 1000))
        XCTAssertLessThanOrEqual(odd.utf16.count, 2000)
        XCTAssertEqual(odd.count, 1000, "the last emoji would straddle the limit and is dropped whole")
        XCTAssertEqual(clampToTextInputLimit("hi"), "hi")
    }

    func testSessionStartCarriesTheProtocolVersionAndAppVersion() throws {
        let json = buildSessionStart(
            voiceGender: .female, voicePersonality: .concise, rideMode: .ride,
            scenario: .commute, lat: nil, lon: nil, appVersion: "1.0.0+7"
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["protocol"] as? Int, 1)
        XCTAssertEqual(object["appVersion"] as? String, "1.0.0+7")
    }
}

// MARK: - re-review: crash speed comes from the phone only, gate speed lives longer

final class CrashGateSpeedTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 20_000)

    /// The tracker reads the time through this while the trace advances it.
    private final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    /// Feeds a 100 Hz trace through the tracker the way SystemMotionFeed does:
    /// sample speed = crash speed (2 s fresh GPS), gate speed = last usable GPS
    /// speed up to 15 s old. `fixAt` returns the GPS fix (km/h, or -1 for a fix
    /// without speed) due at a whole second, nil for no fix.
    private func run(seconds: Double, tracker: RideSpeedTracker, clock: Clock,
                     fixAt: (Double) -> Double?, accel: (Double) -> Double, rotation: (Double) -> Double) -> [CrashEffect] {
        var state = CrashState.armed
        var effects: [CrashEffect] = []
        var nextFix = 0.0
        for i in 0..<Int(seconds * 100) {
            let t = Double(i) / 100
            clock.now = t0.addingTimeInterval(t)
            if t >= nextFix {
                nextFix += 1
                if let kmh = fixAt(t) { tracker.record(gpsFix(kmh: kmh, at: clock.now)) }
            }
            let sample = CrashSample(t: t, accelG: accel(t), rotationRadS: rotation(t),
                                     speedKmh: tracker.crashSpeedKmh, gateSpeedKmh: tracker.crashGateSpeedKmh)
            let step = CrashEngine.step(sample: sample, state: state)
            state = step.state
            effects += step.effects
            let tick = CrashEngine.tick(now: t, state: state)
            state = tick.state
            effects += tick.effects
        }
        return effects
    }

    private func buzz(_ t: Double) -> Double { 0.2 + 0.25 * Double(Int(t * 100) % 7) / 6 }
    private func lying(_ t: Double) -> Double { 0.01 + 0.01 * Double(Int(t * 100) % 3) / 2 }

    func testAMockScenarioSpeedNeverReachesTheCrashFeed() {
        let clock = Clock(t0)
        let tracker = RideSpeedTracker(now: { clock.now })
        tracker.sessionStarted(mock: true)
        tracker.recordRelay(speedKmh: 58)
        XCTAssertEqual(tracker.currentSpeedKmh, 58, "SMS, typing and the HUD still see the demo speed")
        XCTAssertNil(tracker.crashSpeedKmh)
        XCTAssertNil(tracker.crashGateSpeedKmh)
        // Synthetic high-side in the demo, no GPS at all: the bike starts to
        // tumble at 1.85 s, hits at 2 s while still tumbling, then lies still.
        let effects = run(seconds: 10, tracker: tracker, clock: clock, fixAt: { _ in nil },
                          accel: { t in t >= 2 && t < 2.06 ? 9 : (t >= 2.06 ? self.lying(t) : self.buzz(t)) },
                          rotation: { t in t >= 1.85 && t < 2.4 ? 10 : (t >= 2.4 ? 0.02 : 0.3) })
        XCTAssertEqual(effects.first, .speakCheckIn, "the constant 58 km/h must not veto stillness")
    }

    func testTheRelaySpeedAndItsTrustAreForgottenWhenTheSocketCloses() {
        let tracker = RideSpeedTracker(now: { self.t0 })
        tracker.sessionStarted(mock: true)
        tracker.recordRelay(speedKmh: 58)
        tracker.relayConnectionLost()
        XCTAssertNil(tracker.currentSpeedKmh)
        tracker.recordRelay(speedKmh: 58)
        XCTAssertNil(tracker.currentSpeedKmh, "trust is learned again from the next session.started")
        tracker.sessionStarted(mock: true)
        tracker.recordRelay(speedKmh: 58)
        XCTAssertEqual(tracker.currentSpeedKmh, 58)
    }

    func testGateSpeedOutlivesSpeedlessFixesButIsReplacedByAUsableOne() {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.record(gpsFix(kmh: 60, at: t0))
        now = t0.addingTimeInterval(1)
        tracker.record(gpsFix(kmh: -1, at: now))
        XCTAssertNil(tracker.crashSpeedKmh)
        XCTAssertEqual(tracker.crashGateSpeedKmh!, 60, accuracy: 0.001)
        now = t0.addingTimeInterval(RideSpeedTracker.crashGateFreshness + 0.5)
        XCTAssertNil(tracker.crashGateSpeedKmh)
        tracker.record(gpsFix(kmh: 0, at: now))
        XCTAssertEqual(tracker.crashGateSpeedKmh, 0)
        XCTAssertEqual(RideSpeedTracker.crashGateFreshness, 15)
    }

    /// Synthetic: 60 km/h with 1 Hz GPS until t = 2 s, then a tunnel with fixes
    /// that carry no speed. An impact-only crash (no tumble) at `impactAt`,
    /// then the rider lies still.
    private func tunnelCrash(impactAt: Double) -> [CrashEffect] {
        let clock = Clock(t0)
        let tracker = RideSpeedTracker(now: { clock.now })
        tracker.sessionStarted(mock: false)
        return run(seconds: impactAt + 6, tracker: tracker, clock: clock,
                   fixAt: { t in t <= 2 ? 60 : -1 },
                   accel: { t in t >= impactAt && t < impactAt + 0.06 ? 9 : (t >= impactAt + 0.06 ? self.lying(t) : self.buzz(t)) },
                   rotation: { t in t >= impactAt ? 0.02 : 0.3 })
    }

    func testAnImpactTenSecondsIntoATunnelStillOpensTheGate() {
        XCTAssertEqual(tunnelCrash(impactAt: 12).first, .speakCheckIn)
    }

    func testAnImpactTwentySecondsIntoATunnelNeedsImpactAndTumble() {
        XCTAssertEqual(tunnelCrash(impactAt: 22), [])
    }

    func testAJoltWhileStoppedAtALightWithGpsWorkingDoesNotOpenTheGate() {
        let clock = Clock(t0)
        let tracker = RideSpeedTracker(now: { clock.now })
        tracker.sessionStarted(mock: false)
        // 60 km/h, braking to 0 by t = 6 s, waiting at the light until a 9 g jolt at 14 s.
        let effects = run(seconds: 18, tracker: tracker, clock: clock,
                          fixAt: { t in max(0, 60 - 15 * max(0, t - 2)) },
                          accel: { t in t >= 14 && t < 14.06 ? 9 : (t >= 6 ? self.lying(t) : self.buzz(t)) },
                          rotation: { _ in 0.3 })
        XCTAssertEqual(effects, [])
    }
}
