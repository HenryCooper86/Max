import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeLocationSource: RideLocationSource {
    var onFix: ((CLLocation) -> Void)?
    func emit(kmh: Double, at time: Date, speedAccuracy: Double = 1) {
        onFix?(fix(kmh: kmh, at: time, speedAccuracy: speedAccuracy))
    }
}

private func fix(kmh: Double, at time: Date, speedAccuracy: Double = 1) -> CLLocation {
    CLLocation(
        coordinate: CLLocationCoordinate2D(latitude: 31.23, longitude: 121.47),
        altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5,
        course: 90, courseAccuracy: 5,
        speed: kmh < 0 ? -1 : kmh / 3.6, speedAccuracy: speedAccuracy,
        timestamp: time
    )
}

final class RideSpeedTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    // MARK: relay field

    func testAnAbsentRelaySpeedIsUnknownNotZero() {
        let event = parseAgentEvent(#"{"type":"ride.context","mode":"ride","modeLabel":"骑行","scenario":"commute","scenarioLabel":"通勤","hazardLevel":"normal","glanceableFocus":"x"}"#)
        guard case let .rideContextUpdate(context) = event else { return XCTFail("expected ride.context, got \(event)") }
        XCTAssertNil(context.speedKmh, "live backends omit speedKmh; that is not 0 km/h")
    }

    func testAPresentRelaySpeedIsKept() {
        let event = parseAgentEvent(#"{"type":"ride.context","mode":"ride","modeLabel":"骑行","scenario":"commute","scenarioLabel":"通勤","hazardLevel":"normal","glanceableFocus":"x","speedKmh":58}"#)
        guard case let .rideContextUpdate(context) = event else { return XCTFail("expected ride.context") }
        XCTAssertEqual(context.speedKmh, 58)
    }

    func testRelaySpeedValidation() {
        XCTAssertEqual(relaySpeedKmh(NSNumber(value: 0)), 0)
        XCTAssertEqual(relaySpeedKmh(NSNumber(value: 72.5)), 72.5)
        XCTAssertNil(relaySpeedKmh(nil))
        XCTAssertNil(relaySpeedKmh(NSNull()))
        XCTAssertNil(relaySpeedKmh("60"))
        XCTAssertNil(relaySpeedKmh(NSNumber(value: true)), "a JSON true is not 1 km/h")
        XCTAssertNil(relaySpeedKmh(NSNumber(value: -3)))
        XCTAssertNil(relaySpeedKmh(NSNumber(value: 401)))
        XCTAssertNil(relaySpeedKmh(NSNumber(value: Double.nan)))
    }

    // MARK: GPS readings

    func testGpsSpeedNeedsAValidAndCertainReading() {
        XCTAssertEqual(gpsSpeedKmh(from: fix(kmh: 36, at: t0))!, 36, accuracy: 0.001)
        XCTAssertNil(gpsSpeedKmh(from: fix(kmh: -1, at: t0)), "Core Location reports -1 when it has no speed")
        XCTAssertNil(gpsSpeedKmh(from: fix(kmh: 36, at: t0, speedAccuracy: -1)))
        XCTAssertNil(gpsSpeedKmh(from: fix(kmh: 36, at: t0, speedAccuracy: 8)), "±29 km/h cannot gate anything")
    }

    // MARK: precedence

    func testFreshGpsWinsOverTheRelay() {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        let source = FakeLocationSource()
        tracker.observe(source)
        tracker.recordRelay(speedKmh: 58)
        source.emit(kmh: 0, at: t0)
        now = t0.addingTimeInterval(4)
        XCTAssertEqual(tracker.currentSpeedKmh, 0, "the bike is parked even though the demo relay says 58")
        XCTAssertEqual(tracker.freshGpsSpeedKmh, 0)
    }

    func testStaleGpsFallsBackToAMockRelayAndThenToUnknown() {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        tracker.sessionStarted(mock: true)
        let source = FakeLocationSource()
        tracker.observe(source)
        source.emit(kmh: 40, at: t0)
        tracker.recordRelay(speedKmh: 58)
        now = t0.addingTimeInterval(RideSpeedTracker.gpsFreshness + 0.5)
        XCTAssertEqual(tracker.currentSpeedKmh, 58)
        XCTAssertNil(tracker.freshGpsSpeedKmh, "a stale fix is not sent to the relay")
        tracker.recordRelay(speedKmh: nil)
        XCTAssertNil(tracker.currentSpeedKmh, "no fresh GPS and no relay field means unknown")
    }

    func testAnInvalidGpsReadingMakesTheSpeedUnknown() {
        // An old good value left in force could veto crash confirmation (the
        // pre-impact speed outliving the crash), so a speedless fix wins.
        let now = t0.addingTimeInterval(1)
        let tracker = RideSpeedTracker(now: { now })
        tracker.record(fix(kmh: 30, at: t0))
        tracker.record(fix(kmh: -1, at: t0.addingTimeInterval(1)))
        XCTAssertNil(tracker.currentSpeedKmh)
    }

    func testResetForgetsEverything() {
        let tracker = RideSpeedTracker(now: { self.t0 })
        tracker.sessionStarted(mock: true)
        tracker.record(fix(kmh: 30, at: t0))
        tracker.recordRelay(speedKmh: 20)
        tracker.reset()
        XCTAssertNil(tracker.currentSpeedKmh)
    }

    // MARK: consumers

    func testLocationUpdateCarriesSpeedOnlyWhenKnown() throws {
        let withSpeed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(buildLocationUpdate(lat: 31.2, lon: 121.4, speedKmh: 47.26).utf8)) as? [String: Any])
        XCTAssertEqual(withSpeed["type"] as? String, "location.update")
        XCTAssertEqual(withSpeed["speedKmh"] as? Double, 47.3)
        let without = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(buildLocationUpdate(lat: 31.2, lon: 121.4, speedKmh: nil).utf8)) as? [String: Any])
        XCTAssertNil(without["speedKmh"], "omitted, never sent as 0 or null")
        let absurd = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(buildLocationUpdate(lat: 31.2, lon: 121.4, speedKmh: 900).utf8)) as? [String: Any])
        XCTAssertNil(absurd["speedKmh"])
    }

    func testSmsIsRefusedWhenSpeedIsUnknownOrMoving() async {
        struct Presenter: MessagePresenting { func present(number: String, body: String) async -> Bool { true } }
        final class Resolver: ContactResolving, @unchecked Sendable {
            func isAuthorized() async -> Bool { true }
            func number(matching name: String) async -> String? { "13800000000" }
        }
        func compose(_ speed: Double?) async -> DeviceActionResult {
            await MessageComposer(presenter: Presenter(), speedProvider: { speed }, resolver: Resolver())
                .perform(.smsCompose(name: "妈妈", body: "到了"))
        }
        let unknown = await compose(nil)
        XCTAssertEqual(unknown, .denied("unsafe.speed"))
        let moving = await compose(30)
        XCTAssertEqual(moving, .denied("unsafe.speed"))
        let parked = await compose(0)
        XCTAssertEqual(parked, .ok)
    }

    func testTypingLocksOnlyWhileKnownToBeMoving() {
        XCTAssertTrue(typedInputLockedForSpeed(20))
        XCTAssertTrue(typedInputLockedForSpeed(MessageComposer.maximumSpeedKmh))
        XCTAssertFalse(typedInputLockedForSpeed(0))
        XCTAssertFalse(typedInputLockedForSpeed(nil), "no GPS indoors must not disable typing")
        XCTAssertEqual(prepareTextInput("hi", textInputSupported: true, ready: true, speedKmh: 30), .failure(.moving))
        XCTAssertNotNil(try? prepareTextInput("hi", textInputSupported: true, ready: true, speedKmh: nil).get())
    }

    // MARK: crash detection fed by GPS alone

    /// Synthetic high-side at 50 km/h on a live backend that sends no speed:
    /// one 60 ms impact with no tumble, then the phone lies still. Speed comes
    /// only from the phone's GPS through the tracker.
    private func runImpactThenStillness(gps: Bool) -> [CrashEffect] {
        var now = t0
        let tracker = RideSpeedTracker(now: { now })
        let source = FakeLocationSource()
        tracker.observe(source)
        tracker.recordRelay(speedKmh: nil)
        var state = CrashState.armed
        var effects: [CrashEffect] = []
        var lastFix = -1.0
        for i in 0..<600 {
            let t = Double(i) / 100
            now = t0.addingTimeInterval(t)
            let crashed = t >= 2.0
            // GPS fixes at 1 Hz: riding at 50 km/h, then stopped after the crash.
            if gps, t - lastFix >= 1 {
                source.emit(kmh: crashed ? 0 : 50, at: now)
                lastFix = t
            }
            let accel: Double = (t >= 2.0 && t < 2.06) ? 9.0 : (crashed ? 0.01 : 0.3)
            let sample = CrashSample(t: t, accelG: accel, rotationRadS: crashed ? 0.02 : 0.3, speedKmh: tracker.crashSpeedKmh)
            let update = CrashEngine.step(sample: sample, state: state)
            state = update.state
            effects += update.effects
        }
        return effects
    }

    func testTheCrashEngineGetsARealSpeedFromAGpsOnlyFeed() {
        XCTAssertEqual(runImpactThenStillness(gps: true), [.speakCheckIn])
    }

    func testWithoutAnySpeedTheSameCrashNeedsBothSignals() {
        // Documents why GPS matters: unknown speed keeps the engine on its
        // strict below-the-gate path, which this impact-only crash does not meet.
        XCTAssertEqual(runImpactThenStillness(gps: false), [])
    }
}
