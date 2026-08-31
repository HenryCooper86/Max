import XCTest
@testable import MaxHelmet

/// The guidance card is the tallest thing the alert stack can hold, and the
/// viewport that holds it is a fixed-height scroll region: anything past the
/// cap is clipped, not shrunk. On device this cut the route map in half in
/// portrait and down to a sliver in landscape.
///
/// While a route is active the viewport asks for the whole card. When
/// navigation ends the HUD returns to its ordinary proportions, so the map
/// costs the helmet nothing outside navigation.
final class GuidanceAlertViewportTests: XCTestCase {
    // Outer safe-area rectangles. Production applies `contentPadding` *outside*
    // the layout's GeometryReader, so the allocation sees the padded size —
    // measuring against the unpadded one overstates the budget by 20-28 points.
    private let phone15Portrait = CGSize(width: 390, height: 751)
    private let phone15Landscape = CGSize(width: 734, height: 342)
    private let phoneSEPortrait = CGSize(width: 375, height: 647)
    private let phoneSELandscape = CGSize(width: 667, height: 355)

    /// Restated from the card's own geometry rather than read back from the
    /// layout constant, so this cannot pass by agreeing with itself:
    /// 44 top bar + 8 stack spacing + the card's 232 (14+14 padding,
    /// 74 summary, 10 spacing, 120 map).
    private let wholeCardRequirement: CGFloat = 44 + 8 + 232
    private let designedMapHeight: CGFloat = 120

    private var supportedScreens: [(String, HudLayout, CGSize)] {
        [
            ("15 portrait", .portrait, phone15Portrait),
            ("SE portrait", .portrait, phoneSEPortrait),
            ("15 landscape", .landscape, phone15Landscape),
            ("SE landscape", .landscape, phoneSELandscape),
        ]
    }

    /// The proposal the allocation actually receives in production.
    private func available(_ size: CGSize, _ layout: HudLayout) -> CGSize {
        let padding = HudMetrics.contentPadding(for: layout)
        return CGSize(
            width: size.width - padding.leading - padding.trailing,
            height: size.height - padding.top - padding.bottom
        )
    }

    private func allocation(_ layout: HudLayout, _ size: CGSize, guidance: Bool, hazard: Bool = false) -> HudDeterministicAllocation {
        hudDeterministicAllocation(
            layout: layout,
            available: available(size, layout),
            inputs: hudLayoutInputs(
                hazardVisible: hazard,
                crashCheckInVisible: false,
                guidanceVisible: guidance,
                recordingVisible: false,
                captionsRequested: true,
                handsFreeActive: true
            )
        )
    }

    /// The card's own geometry: 14+14 padding and a 74-point summary block,
    /// plus 10-point spacing and the map when one is shown.
    private func cardHeight(mapHeight: CGFloat) -> CGFloat {
        let chrome: CGFloat = 14 + 14 + 74
        return mapHeight > 0 ? chrome + 10 + mapHeight : chrome
    }

    func testNavigatingPortraitFitsTheWholeGuidanceCard() {
        let portrait = allocation(.portrait, phone15Portrait, guidance: true)

        XCTAssertGreaterThanOrEqual(portrait.alertViewportHeight, wholeCardRequirement)
    }

    func testPortraitKeepsTheDesignedMapOnEverySupportedPhone() {
        for size in [phone15Portrait, phoneSEPortrait] {
            let portrait = allocation(.portrait, size, guidance: true)

            XCTAssertEqual(
                guidanceMapHeight(forAlertViewport: portrait.alertViewportHeight, layout: .portrait),
                designedMapHeight
            )
        }
    }

    // Stacking the map in landscape leaves it under the readable floor, so
    // landscape arranges the card side by side — see GuidanceCardLandscapeTests.

    func testEndingNavigationRestoresTheOrdinaryAlertViewport() {
        let portrait = allocation(.portrait, phone15Portrait, guidance: false)

        XCTAssertEqual(portrait.alertViewportHeight, HudMetrics.topBarHeight)
    }

    func testANonGuidanceAlertKeepsTheOrdinaryPortraitViewport() {
        let portrait = allocation(.portrait, phone15Portrait, guidance: false, hazard: true)

        XCTAssertEqual(portrait.alertViewportHeight, HudMetrics.portraitAlertViewportCap)
    }

    /// The property that actually failed on device: whatever map height the
    /// stacked card is granted, the card fits the viewport holding it.
    func testTheStackedGuidanceCardNeverClips() {
        for (name, size) in [("15 portrait", phone15Portrait), ("SE portrait", phoneSEPortrait)] {
            let allocated = allocation(.portrait, size, guidance: true)
            let map = guidanceMapHeight(forAlertViewport: allocated.alertViewportHeight, layout: .portrait)

            XCTAssertLessThanOrEqual(
                44 + 8 + cardHeight(mapHeight: map),
                allocated.alertViewportHeight,
                name
            )
        }
    }

    /// The map must never cost the rider the sole session control.
    func testNavigatingNeverPushesTheHelmetBelowItsAccessibleFloor() {
        for (name, layout, size) in supportedScreens {
            let allocated = allocation(layout, size, guidance: true)

            XCTAssertGreaterThanOrEqual(
                allocated.helmetDiameter,
                HudMetrics.helmetMinDiameter,
                name
            )
            XCTAssertLessThanOrEqual(
                allocated.occupiedHeight(for: layout),
                available(size, layout).height,
                name
            )
        }
    }
}
