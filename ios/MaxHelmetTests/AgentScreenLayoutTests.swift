import XCTest
@testable import MaxHelmet

/// The HUD must reserve one semantic helmet Button at every supported size.
/// Alerts can grow (notably at accessibility text sizes), so their content is
/// measured separately from the finite viewport the layout gives them.
final class AgentScreenLayoutTests: XCTestCase {
    // Usable space after safe areas, for the phones this ships on.
    private let phone15Portrait = CGSize(width: 390, height: 751)
    private let phone15Landscape = CGSize(width: 734, height: 342)
    private let phoneSEPortrait = CGSize(width: 375, height: 647)
    private let phoneSELandscape = CGSize(width: 667, height: 355)

    func testRemovingTheDockReclaimsItsPortraitAndLandscapeReservations() {
        XCTAssertEqual(HudMetrics.portraitChrome, 218)
        XCTAssertEqual(HudMetrics.landscapeChrome, 118)
    }

    func testCompactVerticalSpaceSelectsLandscape() {
        XCTAssertEqual(hudLayout(verticalSizeClassIsCompact: true), .landscape)
        XCTAssertEqual(hudLayout(verticalSizeClassIsCompact: false), .portrait)
    }

    func testUnconstrainedAllocationKeepsTheHelmetAtItsDesignSize() {
        let portrait = hudAllocation(
            layout: .portrait,
            available: phone15Portrait,
            alertContentHeight: 0,
            captionsRequested: false
        )
        let landscape = hudAllocation(
            layout: .landscape,
            available: phone15Landscape,
            alertContentHeight: 0,
            captionsRequested: false
        )

        XCTAssertEqual(portrait.helmetDiameter, 300)
        XCTAssertEqual(landscape.helmetDiameter, 298)
        XCTAssertEqual(portrait.alertViewportHeight, 0)
        XCTAssertEqual(landscape.alertViewportHeight, 0)
    }

    // MARK: - alerts receive a viewport, never the helmet's button space

    func testAllAlertsKeepTheHelmetAccessibleAndInsideEverySupportedSafeArea() {
        let fixtures: [(HudLayout, CGSize, CGFloat)] = [
            (.portrait, phone15Portrait, 218),
            (.portrait, phoneSEPortrait, 218),
            (.landscape, phone15Landscape, 44),
            (.landscape, phoneSELandscape, 44),
        ]

        for (layout, size, fixedChrome) in fixtures {
            let allocation = hudAllocation(
                layout: layout,
                available: size,
                alertContentHeight: 500,
                captionsRequested: true
            )

            // All four alerts are present and their guidance text has expanded
            // beyond a regular card. The viewport, not that content height,
            // gives the 116pt helmet button its non-negotiable space.
            XCTAssertGreaterThanOrEqual(
                allocation.helmetDiameter,
                116,
                "the sole stop/cancel target disappeared at \(layout) \(size)"
            )
            XCTAssertEqual(
                helmetCanvasDiameter(allocation.helmetDiameter),
                allocation.helmetDiameter,
                "layout sent an invalid canvas diameter at \(layout) \(size)"
            )
            XCTAssertLessThanOrEqual(
                fixedChrome + allocation.alertViewportHeight + allocation.helmetDiameter,
                size.height + 0.5,
                "alert viewport overlaps the helmet at \(layout) \(size)"
            )
            XCTAssertNil(allocation.captionsHeight, "captions yield before the helmet at \(layout) \(size)")
            XCTAssertTrue(allocation.alertsAreScrollable, "expanded alerts remain reachable at \(layout) \(size)")
        }
    }

    func testLandscapeAlertViewportIsIndependentOfGrowingGuidanceContent() {
        let allocations = [CGFloat(232), 320, 500].map {
            hudAllocation(
                layout: .landscape,
                available: phone15Landscape,
                alertContentHeight: $0,
                captionsRequested: true
            )
        }

        // 342pt safe height - 44pt top strip - 116pt helmet leaves a 182pt
        // viewport. A regular, wrapped, or accessibility-sized guidance card
        // must scroll inside that same region rather than consume the button.
        for allocation in allocations {
            XCTAssertEqual(allocation.alertViewportHeight, 182)
            XCTAssertEqual(allocation.helmetDiameter, 116)
            XCTAssertNil(allocation.captionsHeight)
            XCTAssertTrue(allocation.alertsAreScrollable)
        }
    }

    func testCaptionsUseOnlySpaceLeftAfterTheAlertViewportAndHelmetTarget() {
        let allocation = hudAllocation(
            layout: .portrait,
            available: phone15Portrait,
            alertContentHeight: 232,
            captionsRequested: true
        )

        // 751 - 218 fixed portrait chrome - 232 alert viewport - 116 helmet
        // target leaves 185pt for captions. This is below the 218pt caption
        // design maximum, so it proves captions yield to both higher-priority
        // regions rather than shrinking the helmet.
        XCTAssertEqual(allocation.alertViewportHeight, 232)
        XCTAssertEqual(allocation.captionsHeight, 185)
        XCTAssertEqual(allocation.helmetDiameter, 116)
        XCTAssertFalse(allocation.alertsAreScrollable)
    }

    func testCaptionsDisappearBeforeAllAlertsCanShrinkTheHelmet() {
        let allocation = hudAllocation(
            layout: .portrait,
            available: phoneSEPortrait,
            alertContentHeight: 500,
            captionsRequested: true
        )

        // The SE portrait viewport is 647 - 218 - 116 = 313pt. Its 500pt
        // content scrolls, captions disappear, and the helmet remains 116pt.
        XCTAssertEqual(allocation.alertViewportHeight, 313)
        XCTAssertNil(allocation.captionsHeight)
        XCTAssertEqual(allocation.helmetDiameter, 116)
        XCTAssertTrue(allocation.alertsAreScrollable)
    }

    func testEveryAlertCombinationFitsSupportedPhonesAndKeepsTheSoleToggleReachable() {
        let fixtures: [(HudLayout, CGSize, CGFloat, CGFloat)] = [
            (.portrait, phone15Portrait, 218, 0),
            (.portrait, phoneSEPortrait, 218, 0),
            (.landscape, phone15Landscape, 44, 74),
            (.landscape, phoneSELandscape, 44, 74),
        ]

        for (layout, size, fixedChrome, readoutColumn) in fixtures {
            for captionsRequested in [false, true] {
                for hazard in [false, true] {
                    for crash in [false, true] {
                        for guidance in [false, true] {
                            for recording in [false, true] {
                                // Hand-measured regular alert content: hazard 100,
                                // crash check-in 100, guidance 232, recording 46.
                                // Separate tests above exercise wrapped guidance
                                // at 320 and 500 points.
                                let content: CGFloat =
                                    (hazard ? 100 : 0)
                                    + (crash ? 100 : 0)
                                    + (guidance ? 232 : 0)
                                    + (recording ? 46 : 0)
                                let allocation = hudAllocation(
                                    layout: layout,
                                    available: size,
                                    alertContentHeight: content,
                                    captionsRequested: captionsRequested
                                )

                                XCTAssertGreaterThanOrEqual(allocation.helmetDiameter, 116)
                                switch layout {
                                case .portrait:
                                    XCTAssertLessThanOrEqual(
                                        fixedChrome + allocation.alertViewportHeight
                                            + allocation.helmetDiameter + (allocation.captionsHeight ?? 0),
                                        size.height + 0.5
                                    )
                                case .landscape:
                                    XCTAssertLessThanOrEqual(
                                        fixedChrome + allocation.alertViewportHeight
                                            + max(allocation.helmetDiameter, readoutColumn + (allocation.captionsHeight ?? 0)),
                                        size.height + 0.5
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    func testCanvasGuardRejectsImpossibleHelmetSizesInsteadOfDrawingThem() {
        XCTAssertEqual(helmetCanvasDiameter(116), 116)
        XCTAssertNil(helmetCanvasDiameter(115))
        XCTAssertNil(helmetCanvasDiameter(-1))
        XCTAssertNil(helmetCanvasDiameter(.infinity))
    }

    // MARK: - crash countdown arithmetic (uptime clock, never wall-clock)

    func testCrashCountdownShowsTheFullWindowAtTheStart() {
        XCTAssertEqual(crashCountdownSeconds(windowS: 30, sinceT: 1000, now: 1000), 30)
    }

    func testCrashCountdownCountsDownAsTimeElapses() {
        XCTAssertEqual(crashCountdownSeconds(windowS: 30, sinceT: 1000, now: 1012), 18)
    }

    func testCrashCountdownClampsToZeroPastExpiry() {
        XCTAssertEqual(crashCountdownSeconds(windowS: 15, sinceT: 1000, now: 1015), 0)
        XCTAssertEqual(crashCountdownSeconds(windowS: 15, sinceT: 1000, now: 9999), 0)
    }
}
