import XCTest
@testable import MaxHelmet

/// The HUD is deliberately allocated from safe-area dimensions and fixed
/// control regions. Intrinsic alert/readout text belongs inside scroll views,
/// never in the arithmetic that protects the sole session Button.
final class AgentScreenLayoutTests: XCTestCase {
    // Usable space after safe areas for the smallest supported phone and the
    // regular reference phone in each orientation.
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

    // MARK: - deterministic safe-area allocation

    func testAllVisibleAlertSourcesUseTheSameBoundedPortraitAllocation() {
        let inputs = hudLayoutInputs(
            hazardVisible: true,
            crashCheckInVisible: true,
            guidanceVisible: true,
            recordingVisible: true,
            captionsRequested: true,
            handsFreeActive: true
        )
        let expected = HudDeterministicAllocation(
            alertViewportHeight: 220,
            helmetDiameter: 300,
            utilityViewportHeight: 207,
            captionsVisible: true
        )

        let allocation = hudDeterministicAllocation(
            layout: .portrait,
            available: phone15Portrait,
            inputs: inputs
        )
        XCTAssertEqual(allocation, expected)
    }

    func testPortraitSEAllAlertsDropsCaptionsBeforeTheHelmetOrControls() {
        let allocation = hudDeterministicAllocation(
            layout: .portrait,
            available: phoneSEPortrait,
            inputs: HudLayoutInputs(alertsVisible: true, captionsRequested: true, handsFreeActive: true)
        )

        // 220 alert viewport + 300 helmet + 103 utility viewport + 24 points
        // of stack gaps exactly fills the 647-point safe height. Captions need
        // 96 points beyond the 52-point active mute/control minimum, so they
        // yield on the smallest portrait instead of hiding either control.
        XCTAssertEqual(allocation.alertViewportHeight, 220)
        XCTAssertEqual(allocation.helmetDiameter, 300)
        XCTAssertEqual(allocation.utilityViewportHeight, 103)
        XCTAssertFalse(allocation.captionsVisible)
        XCTAssertLessThanOrEqual(allocation.occupiedHeight(for: .portrait), phoneSEPortrait.height)
    }

    func testLandscapeUsesFixedAlertViewportAndPreservesHelmetFloorForAllAlertHeights() {
        let inputs = HudLayoutInputs(alertsVisible: true, captionsRequested: true, handsFreeActive: true)

        for (name, size, expectedHelmet, expectedUtility) in [
            ("iPhone 15", phone15Landscape, CGFloat(174), CGFloat(174)),
            ("iPhone SE", phoneSELandscape, CGFloat(187), CGFloat(187)),
        ] {
            for conceptualAlertContentHeight in [CGFloat(0), 232, 320, 500] {
                let allocation = hudDeterministicAllocation(layout: .landscape, available: size, inputs: inputs)

                XCTAssertEqual(allocation.alertViewportHeight, 160, "\(name), content=\(conceptualAlertContentHeight)")
                XCTAssertEqual(allocation.helmetDiameter, expectedHelmet, "\(name), content=\(conceptualAlertContentHeight)")
                XCTAssertEqual(allocation.utilityViewportHeight, expectedUtility, "\(name), content=\(conceptualAlertContentHeight)")
                XCTAssertTrue(allocation.captionsVisible)
                XCTAssertGreaterThanOrEqual(allocation.helmetDiameter, HudMetrics.helmetMinDiameter)
                XCTAssertLessThanOrEqual(allocation.occupiedHeight(for: .landscape), size.height)
            }
        }
    }

    func testLandscapeHelmetStaysWithinItsWidthColumnOnBothSupportedPhones() {
        for size in [phone15Landscape, phoneSELandscape] {
            for alertsVisible in [false, true] {
                let allocation = hudDeterministicAllocation(
                    layout: .landscape,
                    available: size,
                    inputs: HudLayoutInputs(
                        alertsVisible: alertsVisible,
                        captionsRequested: true,
                        handsFreeActive: true
                    )
                )
                XCTAssertLessThanOrEqual(
                    allocation.helmetDiameter,
                    size.width * 0.42 + 0.01,
                    "helmet exceeded the 0.42 landscape column at \(size), alerts=\(alertsVisible)"
                )
            }
        }
    }

    func testNarrowLandscapePrioritizesTheAccessibleHelmetFloorOverTheWidthCap() {
        let allocation = hudDeterministicAllocation(
            layout: .landscape,
            available: CGSize(width: 200, height: 355),
            inputs: HudLayoutInputs(alertsVisible: false, captionsRequested: true, handsFreeActive: true)
        )

        // 200 × 0.42 is only 84 points, but the physical HUD can still fit a
        // 116-point helmet. The semantic session control takes precedence over
        // the usual landscape width proportion on a constrained future device.
        XCTAssertEqual(allocation.helmetDiameter, 116)
        XCTAssertLessThanOrEqual(allocation.occupiedHeight(for: .landscape), 355)
    }

    func testEveryAlertStateAndActiveMuteCombinationFitsSupportedPhones() {
        let fixtures: [(HudLayout, CGSize)] = [
            (.portrait, phone15Portrait),
            (.portrait, phoneSEPortrait),
            (.landscape, phone15Landscape),
            (.landscape, phoneSELandscape),
        ]

        for (layout, size) in fixtures {
            for captionsRequested in [false, true] {
                for hazard in [false, true] {
                    for crash in [false, true] {
                        for guidance in [false, true] {
                            for recording in [false, true] {
                                for handsFreeActive in [false, true] {
                                    let inputs = hudLayoutInputs(
                                        hazardVisible: hazard,
                                        crashCheckInVisible: crash,
                                        guidanceVisible: guidance,
                                        recordingVisible: recording,
                                        captionsRequested: captionsRequested,
                                        handsFreeActive: handsFreeActive
                                    )
                                    let allocation = hudDeterministicAllocation(
                                        layout: layout,
                                        available: size,
                                        inputs: inputs
                                    )
                                    XCTAssertGreaterThanOrEqual(allocation.helmetDiameter, 116)
                                    XCTAssertGreaterThanOrEqual(allocation.utilityViewportHeight, 0)
                                    XCTAssertLessThanOrEqual(allocation.occupiedHeight(for: layout), size.height + 0.01)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    func testRenderingPolicyUsesBoundedScrollableRegionsWithoutMeasurementState() {
        for layout in [HudLayout.portrait, .landscape] {
            let inputs = HudLayoutInputs(alertsVisible: true, captionsRequested: true, handsFreeActive: true)
            let allocation = hudDeterministicAllocation(
                layout: layout,
                available: layout == .portrait ? phoneSEPortrait : phoneSELandscape,
                inputs: inputs
            )
            let policy = hudRenderingPolicy(layout: layout, inputs: inputs, allocation: allocation)

            XCTAssertTrue(policy.alertViewportScrolls, "ordered safety alerts must remain reachable")
            XCTAssertTrue(policy.utilityViewportScrolls, "readout, captions, mute, and controls share one scroll owner")
            XCTAssertTrue(policy.alertChildrenRemainAccessible, "guidance map/enable control remains reachable by VoiceOver")
            XCTAssertFalse(policy.requiresRuntimeMeasurement, "first-frame layout must not depend on preferences")
            XCTAssertGreaterThan(policy.alertViewportHeightCap, 0)
            XCTAssertGreaterThanOrEqual(policy.helmetButtonDiameter, 116)
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
