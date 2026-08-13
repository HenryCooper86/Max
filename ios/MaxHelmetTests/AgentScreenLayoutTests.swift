import XCTest
@testable import MaxHelmet

/// The HUD was a single portrait column with a hard-coded 300×300 helmet and a
/// 190pt caption card. Info.plist allows landscape, where an iPhone leaves about
/// 390pt of height for a stack that wants ~600 — so it overflowed and its parts
/// drew over each other. These pin the arithmetic that stops that.
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

    // MARK: - the helmet always fits the space it is given

    func testPortraitHelmetKeepsItsDesignSizeWhenThereIsRoom() {
        XCTAssertEqual(helmetDiameter(layout: .portrait, available: phone15Portrait), HudMetrics.helmetMaxDiameter)
    }

    func testPortraitHelmetNeverExceedsTheSpaceLeftByTheChrome() {
        for size in [phone15Portrait, phoneSEPortrait] {
            for captions in [false, true] {
                for hazard in [false, true] {
                    let diameter = helmetDiameter(
                        layout: .portrait, available: size, captionsVisible: captions, hazardVisible: hazard
                    )
                    let chrome = portraitChromeHeight(
                        captionsVisible: captions, hazardVisible: hazard, recordingVisible: false
                    )
                    XCTAssertLessThanOrEqual(
                        diameter, max(HudMetrics.helmetMinDiameter, size.height - chrome) + 0.5,
                        "helmet outgrew its column at \(size) captions=\(captions) hazard=\(hazard)"
                    )
                }
            }
        }
    }

    func testLandscapeHelmetFitsBothAxes() {
        for size in [phone15Landscape, phoneSELandscape] {
            for hazard in [false, true] {
                let diameter = helmetDiameter(layout: .landscape, available: size, hazardVisible: hazard)
                XCTAssertLessThanOrEqual(diameter, size.height, "helmet taller than the screen at \(size)")
                XCTAssertLessThanOrEqual(
                    diameter, size.width * HudMetrics.landscapeHelmetColumn + 0.5,
                    "helmet wider than its column at \(size)"
                )
            }
        }
    }

    func testHelmetNeverBecomesNegativeWhenVisibleChromeConsumesTheSpace() {
        let cramped = CGSize(width: 320, height: 200)
        XCTAssertEqual(
            helmetDiameter(layout: .portrait, available: cramped, captionsVisible: true, hazardVisible: true),
            0
        )
        XCTAssertEqual(
            helmetDiameter(layout: .landscape, available: cramped, hazardVisible: true),
            56
        )
    }

    func testHelmetShrinksRatherThanStayingFixedWhenCaptionsOpen() {
        let plain = helmetDiameter(layout: .portrait, available: phoneSEPortrait)
        let withCaptions = helmetDiameter(layout: .portrait, available: phoneSEPortrait, captionsVisible: true)
        XCTAssertLessThan(withCaptions, plain, "captions must cost the helmet height, not secondary controls")
    }

    // MARK: - captions give way before the controls do

    func testCaptionsFitTheirDesignHeightOnATallPhone() {
        XCTAssertEqual(
            captionsHeight(layout: .portrait, available: phone15Portrait, hazardVisible: false, recordingVisible: false),
            HudMetrics.captionsMax
        )
    }

    func testCaptionsShrinkOnAShortPhone() {
        let height = captionsHeight(
            layout: .portrait, available: phoneSEPortrait, hazardVisible: true, recordingVisible: false
        )
        if let height {
            XCTAssertLessThan(height, HudMetrics.captionsMax)
            XCTAssertGreaterThanOrEqual(height, HudMetrics.captionsMin)
        }
    }

    func testCaptionsAreDroppedRatherThanShownAsASliver() {
        let noRoom = CGSize(width: 375, height: 330)
        XCTAssertNil(
            captionsHeight(layout: .portrait, available: noRoom, hazardVisible: true, recordingVisible: true)
        )
    }

    func testLandscapeCaptionsDoNotPayForTheHelmet() {
        // The helmet is in the other column, so captions get more room in
        // landscape than the same height would allow in portrait.
        let landscape = captionsHeight(
            layout: .landscape, available: phone15Landscape, hazardVisible: false, recordingVisible: false
        )
        XCTAssertNotNil(landscape)
    }

    func testGuidanceReservationLeavesRoomForTheHelmetOnTheSmallestPortraitPhone() {
        let captions = captionsHeight(
            layout: .portrait,
            available: phoneSEPortrait,
            hazardVisible: false,
            recordingVisible: true,
            guidanceVisible: true
        )
        let helmet = helmetDiameter(
            layout: .portrait,
            available: phoneSEPortrait,
            captionsVisible: captions != nil,
            hazardVisible: false,
            recordingVisible: true,
            guidanceVisible: true
        )

        // 647pt available minus the 218pt fixed portrait furniture, the
        // 232pt guidance card (120pt map + 74pt summary + 10pt gap + 28pt
        // padding), and the 46pt recording indicator leaves 151pt.
        XCTAssertNil(captions)
        XCTAssertEqual(helmet, 151)
    }

    func testGuidanceCrashHazardAndRecordingDropCaptionsBeforeTheyOverlapTheHelmet() {
        let captions = captionsHeight(
            layout: .portrait,
            available: phone15Portrait,
            hazardVisible: true,
            recordingVisible: true,
            guidanceVisible: true,
            crashVisible: true
        )
        let helmet = helmetDiameter(
            layout: .portrait,
            available: phone15Portrait,
            captionsVisible: captions != nil,
            hazardVisible: true,
            recordingVisible: true,
            guidanceVisible: true,
            crashVisible: true
        )

        // 751pt available minus portrait furniture (218), hazard (100),
        // recording (46), guidance (232), and crash check-in (100) leaves a
        // positive 55pt helmet target. Captions must be absent because the
        // same stack needs a 116pt helmet before any caption may appear.
        XCTAssertNil(captions)
        XCTAssertEqual(helmet, 55)
    }

    func testLandscapeGuidanceAndRecordingBothConsumeTheHelmetHeightBudget() {
        let guidanceOnly = helmetDiameter(
            layout: .landscape,
            available: phone15Landscape,
            guidanceVisible: true
        )
        let constrained = helmetDiameter(
            layout: .landscape,
            available: phone15Landscape,
            hazardVisible: true,
            recordingVisible: true,
            guidanceVisible: true,
            crashVisible: true
        )

        // The landscape top strip occupies 44pt. A 232pt guidance card leaves
        // 66pt of a 342pt iPhone 15 landscape safe area. Adding 100pt hazard,
        // 46pt recording, and 100pt crash check-in leaves no helmet height;
        // the sizing API must clamp that impossible stack to zero rather than
        // report a negative or overlapping size.
        XCTAssertEqual(guidanceOnly, 66)
        XCTAssertEqual(constrained, 0)
    }

    func testLandscapeCaptionsReserveTheActiveSessionRecordingIndicator() {
        let captions = captionsHeight(
            layout: .landscape,
            available: phoneSELandscape,
            hazardVisible: false,
            recordingVisible: true
        )

        // A 355pt landscape safe area has 191pt left after the 118pt
        // landscape furniture and the 46pt active-session recording pill.
        XCTAssertEqual(captions, 191)
    }

    // MARK: - the whole column has to add up

    func testPortraitStackFitsEveryPhoneAndState() {
        for size in [phone15Portrait, phoneSEPortrait] {
            for hazard in [false, true] {
                for recording in [false, true] {
                    for guidance in [false, true] {
                        for crash in [false, true] {
                            let captions = captionsHeight(
                                layout: .portrait,
                                available: size,
                                hazardVisible: hazard,
                                recordingVisible: recording,
                                guidanceVisible: guidance,
                                crashVisible: crash
                            )
                            let helmet = helmetDiameter(
                                layout: .portrait,
                                available: size,
                                captionsVisible: captions != nil,
                                hazardVisible: hazard,
                                recordingVisible: recording,
                                guidanceVisible: guidance,
                                crashVisible: crash
                            )
                            let fixedChrome: CGFloat = 218
                                + (hazard ? 100 : 0)
                                + (recording ? 46 : 0)
                                + (guidance ? 232 : 0)
                                + (crash ? 100 : 0)
                            XCTAssertGreaterThanOrEqual(
                                helmet,
                                0,
                                "helmet became negative at \(size) hazard=\(hazard) recording=\(recording) guidance=\(guidance) crash=\(crash)"
                            )
                            if fixedChrome + 116 <= size.height {
                                XCTAssertLessThanOrEqual(
                                    fixedChrome + helmet + (captions ?? 0),
                                    size.height + 0.5,
                                    "portrait stack overflows at \(size) hazard=\(hazard) recording=\(recording) guidance=\(guidance) crash=\(crash)"
                                )
                            } else {
                                XCTAssertNil(captions)
                                XCTAssertEqual(helmet, max(.zero, size.height - fixedChrome))
                            }
                        }
                    }
                }
            }
        }
    }

    func testLandscapeStackFitsEveryPhoneAndState() {
        for size in [phone15Landscape, phoneSELandscape] {
            for hazard in [false, true] {
                for recording in [false, true] {
                    for guidance in [false, true] {
                        for crash in [false, true] {
                            let captions = captionsHeight(
                                layout: .landscape,
                                available: size,
                                hazardVisible: hazard,
                                recordingVisible: recording,
                                guidanceVisible: guidance,
                                crashVisible: crash
                            )
                            let helmet = helmetDiameter(
                                layout: .landscape,
                                available: size,
                                captionsVisible: captions != nil,
                                hazardVisible: hazard,
                                recordingVisible: recording,
                                guidanceVisible: guidance,
                                crashVisible: crash
                            )
                            let alerts: CGFloat =
                                (hazard ? 100 : 0)
                                + (recording ? 46 : 0)
                                + (guidance ? 232 : 0)
                                + (crash ? 100 : 0)
                            let topRowTotal = 44 + alerts + helmet
                            let readoutFixedChrome = 118 + alerts

                            XCTAssertGreaterThanOrEqual(helmet, 0)
                            if 44 + alerts <= size.height {
                                XCTAssertLessThanOrEqual(
                                    topRowTotal,
                                    size.height + 0.5,
                                    "landscape helmet overlaps alerts at \(size) hazard=\(hazard) recording=\(recording) guidance=\(guidance) crash=\(crash)"
                                )
                            } else {
                                XCTAssertEqual(helmet, 0)
                            }
                            if readoutFixedChrome + 96 <= size.height {
                                XCTAssertLessThanOrEqual(
                                    readoutFixedChrome + (captions ?? 0),
                                    size.height + 0.5,
                                    "landscape captions overlap alerts at \(size) hazard=\(hazard) recording=\(recording) guidance=\(guidance) crash=\(crash)"
                                )
                            } else {
                                XCTAssertNil(captions)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - the crash check-in banner reserves chrome like a hazard banner

    func testCrashBannerReservesChromeLikeAHazardBanner() {
        let without = portraitChromeHeight(captionsVisible: false, hazardVisible: false, recordingVisible: false)
        let with = portraitChromeHeight(
            captionsVisible: false, hazardVisible: false, recordingVisible: false, crashVisible: true
        )
        XCTAssertEqual(with - without, HudMetrics.hazardBanner,
                       "the check-in banner reserves the same vertical space as a hazard banner")
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
