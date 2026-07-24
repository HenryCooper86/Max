import CoreLocation
import XCTest
@testable import MaxHelmet

final class NavigationRouteTests: XCTestCase {

    func testCoordinatesEqualityTolerance() {
        let a = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.4)
        let b = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.4)
        let c = CLLocationCoordinate2D(latitude: 39.9, longitude: 116.5)
        XCTAssertTrue(coordinatesEqual(a, b))
        XCTAssertFalse(coordinatesEqual(a, c))
    }

    func testRouteAndStepAreEquatable() {
        let step = ManeuverStep(instruction: "右转", coordinate: .init(latitude: 39.9, longitude: 116.4), distanceMeters: 200)
        let route = NavigationRoute(
            destinationName: "天安门",
            destinationCoordinate: .init(latitude: 39.9087, longitude: 116.3975),
            polyline: [.init(latitude: 39.90, longitude: 116.40), .init(latitude: 39.91, longitude: 116.40)],
            steps: [step],
            totalDistanceMeters: 1200,
            totalEtaSeconds: 300
        )
        XCTAssertEqual(route, route)
        XCTAssertEqual(step, step)
    }
}
