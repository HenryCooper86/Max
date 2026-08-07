import CoreLocation
import XCTest
@testable import MaxHelmet

/// Swift port of tests/guidance.test.ts's table — same coordinate literals, so
/// this file (and shared/guidance.ts's `step`) can be diffed against each
/// other directly. See GuidanceEngine.swift's port-contract comment for the
/// six rules this table exercises.
final class GuidanceEngineTests: XCTestCase {

    // Straight north-bound route along lon 121.47: 31.23 → 31.24 (~1109 m),
    // one right turn at 31.235 (555 m in), arriving at 31.24 (1109 m in).
    private func route() -> NavigationRoute {
        NavigationRoute(
            destinationName: "测试终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 31.24, longitude: 121.47),
            polyline: [
                CLLocationCoordinate2D(latitude: 31.23, longitude: 121.47),
                CLLocationCoordinate2D(latitude: 31.235, longitude: 121.47),
                CLLocationCoordinate2D(latitude: 31.24, longitude: 121.47)
            ],
            steps: [
                ManeuverStep(instruction: "右转", coordinate: CLLocationCoordinate2D(latitude: 31.235, longitude: 121.47), alongRouteMeters: 555),
                ManeuverStep(instruction: "到达终点", coordinate: CLLocationCoordinate2D(latitude: 31.24, longitude: 121.47), alongRouteMeters: 1109)
            ],
            totalDistanceMeters: 1109,
            totalEtaSeconds: 240
        )
    }

    private func fresh() -> GuidanceProgress {
        GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    }

    private func step(_ lat: Double, _ progress: GuidanceProgress) -> GuidanceUpdate {
        GuidanceEngine.step(
            position: CLLocationCoordinate2D(latitude: lat, longitude: 121.47),
            route: route(),
            progress: progress
        )
    }

    private func assertMatchesFarNearTemplate(_ prompt: String?, file: StaticString = #filePath, line: UInt = #line) {
        guard let prompt else {
            XCTFail("expected a spoken prompt", file: file, line: line)
            return
        }
        XCTAssertNotNil(
            prompt.range(of: #"^前方\d+米，右转$"#, options: .regularExpression),
            "\"\(prompt)\" does not match the far/near template",
            file: file, line: line
        )
    }

    func testHaversineMeasuresAcrossTheTestRoute() {
        let a = CLLocationCoordinate2D(latitude: 31.23, longitude: 121.47)
        let b = CLLocationCoordinate2D(latitude: 31.24, longitude: 121.47)
        // vitest's toBeCloseTo(1109, -1): |actual - 1109| < 5.
        XCTAssertEqual(Geo.haversineMeters(a, b), 1109, accuracy: 5)
    }

    func testReportsDistanceToTheFirstManeuverFromTheStart() {
        let u = step(31.23, fresh())
        XCTAssertGreaterThan(u.distanceToManeuverMeters, 540)
        XCTAssertLessThan(u.distanceToManeuverMeters, 570)
        XCTAssertFalse(u.offRoute)
        XCTAssertNil(u.spokenPrompt) // 555 m > far threshold
        XCTAssertEqual(u.currentInstruction, "右转")
    }

    func testFiresFarOnceThenNearOnceThenNowOnce() {
        var progress = fresh()
        func at(_ lat: Double) -> GuidanceUpdate {
            let u = step(lat, progress)
            progress = u.progress
            return u
        }

        let far = at(31.232) // ~333 m → far
        assertMatchesFarNearTemplate(far.spokenPrompt)
        XCTAssertEqual(far.firedThreshold, .far)

        let farAlreadyFired = at(31.2325)
        XCTAssertNil(farAlreadyFired.spokenPrompt)
        XCTAssertNil(farAlreadyFired.firedThreshold)

        let near = at(31.234) // ~111 m → near
        assertMatchesFarNearTemplate(near.spokenPrompt)
        XCTAssertEqual(near.firedThreshold, .near)

        let now = at(31.2348) // ~22 m → now
        XCTAssertEqual(now.spokenPrompt, "右转")
        XCTAssertEqual(now.firedThreshold, .now)

        let after = at(31.2349)
        XCTAssertNil(after.spokenPrompt)
        XCTAssertNil(after.firedThreshold)
    }

    func testNowPromptFiresBeforeAdvancementOnTheSameTick() {
        // ~22 m along-route from a fresh start: crosses "now" and the 30 m
        // reached radius in the same fix. The prompt for the maneuver just
        // completed must still be reported alongside the post-advance progress.
        let u = step(31.2348, fresh())
        XCTAssertEqual(u.spokenPrompt, "右转")
        XCTAssertEqual(u.firedThreshold, .now)
        XCTAssertEqual(u.progress.maneuverIndex, 1)
    }

    func testAdvancesPastTheManeuverAndClearsThresholds() {
        var progress = fresh()
        for lat in [31.232, 31.234, 31.2348, 31.2355] {
            progress = step(lat, progress).progress
        }
        XCTAssertEqual(progress.maneuverIndex, 1)
        let u = step(31.2355, progress)
        XCTAssertEqual(u.currentInstruction, "到达终点")
    }

    func testFlagsOffRouteBeyond50MCrossTrack() {
        // 0.001° lon at lat 31.23 ≈ 95 m east of the line.
        let u = GuidanceEngine.step(
            position: CLLocationCoordinate2D(latitude: 31.232, longitude: 121.471),
            route: route(), progress: fresh()
        )
        XCTAssertTrue(u.offRoute)
        XCTAssertNil(u.spokenPrompt) // no prompts while off-route
        XCTAssertNil(u.firedThreshold)
    }

    func testOffRouteNeverAdvancesTheManeuver() {
        // Along-route projection lands past the first maneuver's 555 m, but
        // ~95 m cross-track keeps this fix off-route: progression must freeze.
        let u = GuidanceEngine.step(
            position: CLLocationCoordinate2D(latitude: 31.236, longitude: 121.471),
            route: route(), progress: fresh()
        )
        XCTAssertTrue(u.offRoute)
        XCTAssertEqual(u.progress.maneuverIndex, 0)
        XCTAssertEqual(u.progress.firedThresholds, [])
    }

    func testArrivesWithin30MOfDestinationAndStaysSticky() {
        var progress = fresh()
        for lat in [31.232, 31.234, 31.2348, 31.2355, 31.2398] {
            progress = step(lat, progress).progress
        }
        XCTAssertTrue(progress.arrived)

        // Sticky: a later far-away fix must not un-arrive the rider (rule 4).
        let farAway = step(31.20, progress)
        XCTAssertTrue(farAway.arrived)
        XCTAssertTrue(farAway.progress.arrived)
    }

    func testScalesRemainingTimeFromRemainingDistance() {
        let u = step(31.235, fresh())
        XCTAssertGreaterThan(u.remainingMeters, 520)
        XCTAssertLessThan(u.remainingMeters, 590)
        XCTAssertGreaterThan(u.remainingSeconds, 110)
        XCTAssertLessThan(u.remainingSeconds, 130)
    }
}
