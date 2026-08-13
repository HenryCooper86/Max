import CoreLocation
import XCTest
@testable import MaxHelmet

final class GuidanceCardAccessibilityTests: XCTestCase {
    func testNavigationSummaryIncludesManeuverDistanceAndETAWithoutMapControl() {
        let guidance = GuidanceState(
            destinationName: "人民广场",
            polyline: [
                .init(latitude: 31.2304, longitude: 121.4737),
                .init(latitude: 31.2314, longitude: 121.4750)
            ],
            currentLocation: nil,
            maneuverInstruction: "右转",
            distanceToManeuverMeters: 120,
            remainingDistanceMeters: 1200,
            remainingSeconds: 300,
            offRoute: false
        )

        XCTAssertEqual(
            guidanceCardAccessibilitySummary(guidance),
            "导航 人民广场，右转，120 米，5 分钟 · 1.2 公里"
        )
    }
}
