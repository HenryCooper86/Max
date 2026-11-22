import XCTest
@testable import MaxHelmet

@MainActor
private final class FakeThermalSource: ThermalStateSource {
    var heat: DeviceHeat = .nominal
    var lowPowerMode = false
    var onChange: (@MainActor () -> Void)?
    var stops = 0
    func start(_ onChange: @escaping @MainActor () -> Void) { self.onChange = onChange }
    func stop() { onChange = nil; stops += 1 }
    func set(_ heat: DeviceHeat, lowPower: Bool? = nil) {
        self.heat = heat
        if let lowPower { lowPowerMode = lowPower }
        onChange?()
    }
}

final class CapturePolicyTests: XCTestCase {
    func testHeatMapsFromTheSystemThermalState() {
        XCTAssertEqual(DeviceHeat(.nominal), .nominal)
        XCTAssertEqual(DeviceHeat(.fair), .fair)
        XCTAssertEqual(DeviceHeat(.serious), .serious)
        XCTAssertEqual(DeviceHeat(.critical), .critical)
    }

    func testCoolPhoneAllowsEverything() {
        XCTAssertEqual(capturePolicy(heat: .nominal, lowPowerMode: false), .unrestricted)
        XCTAssertEqual(capturePolicy(heat: .fair, lowPowerMode: false), .unrestricted)
    }

    func testLowPowerModeOnlyRefusesNewVideo() {
        let policy = capturePolicy(heat: .nominal, lowPowerMode: true)
        XCTAssertEqual(policy.videoRecording, .lowPower)
        XCTAssertNil(policy.photo)
        XCTAssertNil(policy.visionFrames)
        XCTAssertFalse(policy.shedNonEssential)
    }

    func testSeriousHeatStopsVideoAndVisionButKeepsPhotos() {
        let policy = capturePolicy(heat: .serious, lowPowerMode: false)
        XCTAssertEqual(policy.videoRecording, .hot)
        XCTAssertEqual(policy.visionFrames, .hot)
        XCTAssertNil(policy.photo)
        XCTAssertFalse(policy.shedNonEssential)
    }

    func testCriticalHeatShedsAllCameraWork() {
        let policy = capturePolicy(heat: .critical, lowPowerMode: true)
        XCTAssertEqual(policy.videoRecording, .hot, "heat is the reason the rider needs to hear")
        XCTAssertEqual(policy.photo, .hot)
        XCTAssertEqual(policy.visionFrames, .hot)
        XCTAssertTrue(policy.shedNonEssential)
    }

    func testRefusalReasonsAreStableWireCodes() {
        XCTAssertEqual(CaptureRefusal.hot.reason, "device.hot")
        XCTAssertEqual(CaptureRefusal.lowPower.reason, "device.powerSave")
    }
}

@MainActor
final class ThermalGovernorTests: XCTestCase {
    private var source: FakeThermalSource!
    private var now: TimeInterval = 0
    private var announcements: [ThermalAnnouncement] = []
    private var policies: [CapturePolicy] = []
    private var governor: ThermalGovernor!

    override func setUp() async throws {
        source = FakeThermalSource()
        now = 0
        announcements = []
        policies = []
        governor = ThermalGovernor(source: source, now: { [unowned self] in self.now })
        governor.onAnnouncement = { [unowned self] in self.announcements.append($0) }
        governor.onPolicyChange = { [unowned self] in self.policies.append($0) }
    }

    func testStartingAlreadyHotAppliesThePolicyAndTellsTheRider() {
        source.heat = .serious
        governor.start()
        XCTAssertEqual(governor.policy.videoRecording, .hot)
        XCTAssertEqual(announcements, [.hot])
    }

    func testHeatingUpAnnouncesOnceAndCoolingDownRestoresEligibility() {
        governor.start()
        XCTAssertEqual(governor.policy, .unrestricted)
        XCTAssertEqual(announcements, [])

        source.set(.fair)
        XCTAssertEqual(announcements, [], "fair is normal operation")
        source.set(.serious)
        source.set(.serious)
        XCTAssertEqual(announcements, [.hot])
        XCTAssertEqual(policies.last?.videoRecording, .hot)

        source.set(.critical)
        XCTAssertEqual(announcements, [.hot, .critical])
        XCTAssertTrue(governor.policy.shedNonEssential)
        source.set(.serious)
        source.set(.critical)
        XCTAssertEqual(announcements, [.hot, .critical], "no chatter while it hovers")

        source.set(.fair)
        XCTAssertEqual(announcements, [.hot, .critical, .cooled])
        XCTAssertEqual(governor.policy, .unrestricted)
    }

    func testFlappingAroundSeriousDoesNotRepeatTheWarningWithinTheQuietPeriod() {
        governor.start()
        source.set(.serious)
        source.set(.fair)
        now += 60
        source.set(.serious)
        XCTAssertEqual(announcements, [.hot, .cooled])
        source.set(.fair)
        now += ThermalGovernor.quietPeriod
        source.set(.serious)
        XCTAssertEqual(announcements, [.hot, .cooled, .hot])
    }

    func testLowPowerModeIsMentionedOnceAndOnlyLimitsVideo() {
        governor.start()
        source.set(.nominal, lowPower: true)
        source.set(.nominal, lowPower: true)
        XCTAssertEqual(announcements, [.lowPower])
        XCTAssertEqual(governor.policy.videoRecording, .lowPower)
        source.set(.nominal, lowPower: false)
        XCTAssertEqual(governor.policy, .unrestricted)
        XCTAssertEqual(announcements, [.lowPower])
    }

    func testThePolicyIsReadableOffTheMainThread() async {
        governor.start()
        source.set(.critical)
        let box = governor.snapshot
        let photo = await Task.detached { box.value.photo }.value
        XCTAssertEqual(photo, .hot)
    }

    func testStopStopsObserving() {
        governor.start()
        governor.stop()
        XCTAssertEqual(source.stops, 1)
        XCTAssertNil(source.onChange)
    }

    func testAnnouncementsAreLocalised() {
        for announcement in [ThermalAnnouncement.hot, .critical, .cooled, .lowPower] {
            let zh = Loc.string(announcement.messageKey, .zh)
            let en = Loc.string(announcement.messageKey, .en)
            XCTAssertNotEqual(zh, announcement.messageKey)
            XCTAssertNotEqual(en, announcement.messageKey)
            XCTAssertNil(en.range(of: "\\p{Han}", options: .regularExpression))
        }
        XCTAssertTrue(ThermalAnnouncement.hot.spoken)
        XCTAssertTrue(ThermalAnnouncement.critical.spoken)
        XCTAssertFalse(ThermalAnnouncement.cooled.spoken, "cooling down is good news for the status line, not an interruption")
        XCTAssertFalse(ThermalAnnouncement.lowPower.spoken)
    }
}
