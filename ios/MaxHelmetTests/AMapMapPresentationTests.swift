import XCTest
@testable import MaxHelmet

final class AMapMapPresentationTests: XCTestCase {
    func testUnknownAlwaysRequiresConsentBeforeAnyMapState() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .unknown, hasAPIKey: true, hasGeometry: true
            ),
            .consentRequired
        )
    }

    func testUnknownStillShowsDisclosureBeforeMissingKeyFailure() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .unknown, hasAPIKey: false, hasGeometry: true
            ),
            .consentRequired
        )
    }

    func testDeclineWinsWithoutConstructingAMap() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .declined, hasAPIKey: true, hasGeometry: true
            ),
            .notEnabled
        )
    }

    func testAcceptedRequiresOnlyKeyAndGeometryForStructuralMapEligibility() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .accepted,
                hasAPIKey: true,
                hasGeometry: true
            ),
            .map
        )
        for inputs in [(false, true), (true, false), (false, false)] {
            XCTAssertEqual(
                amapMapPresentation(
                    decision: .accepted,
                    hasAPIKey: inputs.0,
                    hasGeometry: inputs.1
                ),
                .unavailable
            )
        }
    }
}
