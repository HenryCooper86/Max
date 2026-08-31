import CoreLocation
import SwiftUI
import XCTest
@testable import MaxHelmet

/// Landscape stacks badly: the card wants 284 points of height but the helmet
/// floor caps the viewport near 198, so a stacked map is either clipped or
/// dropped. The viewport is ~700 points wide and the card used barely a third
/// of it, so landscape puts the map beside the summary instead of beneath it.
final class GuidanceCardLandscapeTests: XCTestCase {
    private let phone15Landscape = CGSize(width: 734, height: 342)
    private let phoneSELandscape = CGSize(width: 667, height: 355)
    private let phone15Portrait = CGSize(width: 390, height: 751)

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

    private func available(_ size: CGSize, _ layout: HudLayout) -> CGSize {
        let padding = HudMetrics.contentPadding(for: layout)
        return CGSize(
            width: size.width - padding.leading - padding.trailing,
            height: size.height - padding.top - padding.bottom
        )
    }

    private func viewport(_ layout: HudLayout, _ size: CGSize) -> CGFloat {
        hudDeterministicAllocation(
            layout: layout,
            available: available(size, layout),
            inputs: hudLayoutInputs(
                hazardVisible: false,
                crashCheckInVisible: false,
                guidanceVisible: true,
                recordingVisible: false,
                captionsRequested: true,
                handsFreeActive: true
            )
        ).alertViewportHeight
    }

    func testLandscapePutsTheMapBesideTheSummary() {
        XCTAssertEqual(guidanceCardArrangement(for: .landscape), .sideBySide)
    }

    func testPortraitKeepsTheStackedCard() {
        XCTAssertEqual(guidanceCardArrangement(for: .portrait), .stacked)
    }

    /// Side by side, the map no longer competes with the summary for height,
    /// so landscape recovers a usable map instead of dropping it.
    func testLandscapeRecoversAUsableMap() {
        for (name, size) in [("15", phone15Landscape), ("SE", phoneSELandscape)] {
            let map = guidanceMapHeight(forAlertViewport: viewport(.landscape, size), layout: .landscape)

            XCTAssertGreaterThanOrEqual(map, 96, name)
        }
    }

    func testPortraitMapHeightIsUnchanged() {
        XCTAssertEqual(
            guidanceMapHeight(forAlertViewport: viewport(.portrait, phone15Portrait), layout: .portrait),
            120
        )
    }

    /// The whole point: the landscape card must fit the viewport holding it.
    func testTheLandscapeCardFitsItsViewport() {
        for (name, size) in [("15", phone15Landscape), ("SE", phoneSELandscape)] {
            let viewportHeight = viewport(.landscape, size)
            let map = guidanceMapHeight(forAlertViewport: viewportHeight, layout: .landscape)
            let controller = UIHostingController(
                rootView: GuidanceCard(guidance: guidance, mapHeight: map, arrangement: .sideBySide)
            )
            let rendered = controller.sizeThatFits(
                in: CGSize(width: available(size, .landscape).width, height: CGFloat.greatestFiniteMagnitude)
            ).height

            XCTAssertLessThanOrEqual(
                44 + HudMetrics.alertStackSpacing + rendered,
                viewportHeight,
                name
            )
        }
    }

    /// A side-by-side card that stays 420 points wide would waste the ~700-point
    /// viewport it was introduced to use.
    func testTheLandscapeCardUsesTheWideViewport() {
        let width = available(phone15Landscape, .landscape).width
        let controller = UIHostingController(
            rootView: GuidanceCard(guidance: guidance, mapHeight: 118, arrangement: .sideBySide)
        )
        let rendered = controller.sizeThatFits(
            in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        )

        XCTAssertGreaterThan(rendered.width, 420)
    }
}
