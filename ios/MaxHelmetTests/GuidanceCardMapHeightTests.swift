import CoreLocation
import SwiftUI
import XCTest
@testable import MaxHelmet

/// The card must actually honour the map height the HUD grants it. Without
/// this the allocation can be correct while the card still renders its fixed
/// 120-point map and overruns the viewport, which is exactly what shipped.
final class GuidanceCardMapHeightTests: XCTestCase {
    private let guidance = GuidanceState(
        destinationName: "上海外滩验证路线",
        polyline: [
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
            CLLocationCoordinate2D(latitude: 31.2320, longitude: 121.4753),
        ],
        currentLocation: CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
        maneuverInstruction: "沿中山东一路向北",
        distanceToManeuverMeters: 180,
        remainingDistanceMeters: 1_400,
        remainingSeconds: 360,
        offRoute: false
    )

    private func height(mapHeight: CGFloat) -> CGFloat {
        let controller = UIHostingController(
            rootView: GuidanceCard(guidance: guidance, mapHeight: mapHeight)
        )
        return controller.sizeThatFits(
            in: CGSize(width: 358, height: CGFloat.greatestFiniteMagnitude)
        ).height
    }

    func testDroppingTheMapShortensTheCardByTheMapAndItsSpacing() {
        let withMap = height(mapHeight: 120)
        let withoutMap = height(mapHeight: 0)

        XCTAssertEqual(withMap - withoutMap, 130, accuracy: 1)
    }

    func testAShorterGrantProducesAShorterCard() {
        XCTAssertEqual(height(mapHeight: 120) - height(mapHeight: 64), 56, accuracy: 1)
    }

    /// The nominal height the HUD allocation reserves must not undershoot what
    /// the card actually renders at default Dynamic Type.
    func testTheReservedNominalHeightCoversTheRenderedCard() {
        XCTAssertLessThanOrEqual(height(mapHeight: 120), guidanceCardNominalHeight)
    }
}
