import CoreLocation
import MapKit
import XCTest
@testable import MaxHelmet

final class RouteSearchTests: XCTestCase {

    func testMapsAnMKRouteIntoANavigationRoute() {
        // MKRoute can't be constructed in a test, so we verify the mapping helper
        // against a hand-built polyline + steps stand-in via the pure entry point.
        let dest = CLLocationCoordinate2D(latitude: 39.9087, longitude: 116.3975)
        let polyline = [
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
            CLLocationCoordinate2D(latitude: 39.91, longitude: 116.40)
        ]
        let steps = [ManeuverStep(instruction: "右转", coordinate: dest, distanceMeters: 500)]
        let route = makeNavigationRoute(
            name: "天安门", destination: dest, polyline: polyline, steps: steps,
            totalDistanceMeters: 1200, totalEtaSeconds: 300
        )
        XCTAssertEqual(route.destinationName, "天安门")
        XCTAssertEqual(route.steps.count, 1)
        XCTAssertEqual(route.polyline.count, 2)
        XCTAssertEqual(route.totalDistanceMeters, 1200)
    }
}
