import CoreLocation
import XCTest
@testable import MaxHelmet

final class GuidanceEngineTests: XCTestCase {

    // A straight north-bound route with one right turn ~1 km north.
    private func route() -> NavigationRoute {
        let turn = CLLocationCoordinate2D(latitude: 39.9090, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40),
            polyline: [
                CLLocationCoordinate2D(latitude: 39.9000, longitude: 116.40),
                turn,
                CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
            ],
            steps: [
                ManeuverStep(instruction: "右转", coordinate: turn, distanceMeters: 1000),
                ManeuverStep(instruction: "到达终点", coordinate: CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40), distanceMeters: 1000)
            ],
            totalDistanceMeters: 2000,
            totalEtaSeconds: 400
        )
    }

    private func fresh() -> GuidanceProgress {
        GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    }

    // ~0.001 deg latitude ≈ 111 m; return a point `metersNorthOf` short of the turn.
    private func lat(_ metersNorthOf: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: 39.9090 - metersNorthOf / 111_000, longitude: 116.40)
    }

    func testNoPromptWhenFarFromManeuver() {
        let update = GuidanceEngine.step(location: lat(800), route: route(), progress: fresh())
        XCTAssertNil(update.spokenPrompt)
        XCTAssertFalse(update.offRoute)
        XCTAssertFalse(update.progress.arrived)
    }

    func testFarPromptFiresOnceWhenCrossing400() {
        let first = GuidanceEngine.step(location: lat(390), route: route(), progress: fresh())
        XCTAssertEqual(first.spokenPrompt, "前方400米，右转")
        XCTAssertTrue(first.progress.firedThresholds.contains(.far))

        let second = GuidanceEngine.step(location: lat(380), route: route(), progress: first.progress)
        XCTAssertNil(second.spokenPrompt, "far must not re-fire")
    }

    func testNearAndNowPromptsFire() {
        var progress = fresh()
        progress.firedThresholds = [.far]
        let near = GuidanceEngine.step(location: lat(140), route: route(), progress: progress)
        XCTAssertEqual(near.spokenPrompt, "150米后，右转")

        let now = GuidanceEngine.step(location: lat(30), route: route(), progress: near.progress)
        XCTAssertEqual(now.spokenPrompt, "现在，右转")
    }

    func testAdvancesPastAManeuver() {
        // At the turn coordinate, index advances to the next maneuver.
        let update = GuidanceEngine.step(location: lat(0), route: route(), progress: fresh())
        XCTAssertEqual(update.progress.maneuverIndex, 1)
        XCTAssertEqual(update.progress.firedThresholds, [])
    }

    func testDetectsOffRoute() {
        // ~120 m east of the route line.
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4014)
        let update = GuidanceEngine.step(location: off, route: route(), progress: fresh())
        XCTAssertTrue(update.offRoute)
    }

    func testDetectsArrival() {
        let atDest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        let update = GuidanceEngine.step(location: atDest, route: route(), progress: GuidanceProgress(maneuverIndex: 1, firedThresholds: [], arrived: false))
        XCTAssertTrue(update.progress.arrived)
        XCTAssertEqual(update.spokenPrompt, "已到达目的地。")
    }

    func testRemainingEtaScalesWithDistance() {
        let far = GuidanceEngine.step(location: lat(900), route: route(), progress: fresh())
        let near = GuidanceEngine.step(location: lat(100), route: route(), progress: fresh())
        XCTAssertGreaterThan(far.remainingSeconds, near.remainingSeconds)
    }
}
