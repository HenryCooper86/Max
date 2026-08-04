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

    func testHelmetNeverCollapsesBelowTheReadableFloor() {
        let cramped = CGSize(width: 320, height: 200)
        XCTAssertEqual(
            helmetDiameter(layout: .portrait, available: cramped, captionsVisible: true, hazardVisible: true),
            HudMetrics.helmetMinDiameter
        )
        XCTAssertEqual(
            helmetDiameter(layout: .landscape, available: cramped, hazardVisible: true),
            HudMetrics.helmetMinDiameter
        )
    }

    func testHelmetShrinksRatherThanStayingFixedWhenCaptionsOpen() {
        let plain = helmetDiameter(layout: .portrait, available: phoneSEPortrait)
        let withCaptions = helmetDiameter(layout: .portrait, available: phoneSEPortrait, captionsVisible: true)
        XCTAssertLessThan(withCaptions, plain, "captions must cost the helmet height, not the mic dock")
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

    // MARK: - the whole column has to add up

    func testPortraitStackFitsEveryPhoneAndState() {
        for size in [phone15Portrait, phoneSEPortrait] {
            for hazard in [false, true] {
                for recording in [false, true] {
                    let captions = captionsHeight(
                        layout: .portrait, available: size, hazardVisible: hazard, recordingVisible: recording
                    )
                    let helmet = helmetDiameter(
                        layout: .portrait,
                        available: size,
                        captionsVisible: captions != nil,
                        hazardVisible: hazard,
                        recordingVisible: recording
                    )
                    let chrome = portraitChromeHeight(
                        captionsVisible: false, hazardVisible: hazard, recordingVisible: recording
                    )
                    let total = chrome + helmet + (captions ?? 0)
                    XCTAssertLessThanOrEqual(
                        total, size.height + 0.5,
                        "portrait stack overflows at \(size) hazard=\(hazard) recording=\(recording): \(total)"
                    )
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
