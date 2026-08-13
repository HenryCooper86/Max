import XCTest
@testable import MaxHelmet

final class AMapMapPresentationTests: XCTestCase {
    func testUnknownAlwaysRequiresConsentBeforeAnyMapState() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .unknown, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .consentRequired
        )
    }

    func testUnknownStillShowsDisclosureBeforeMissingKeyFailure() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .unknown, hasAPIKey: false, hasGeometry: true, loadFailed: false
            ),
            .consentRequired
        )
    }

    func testDeclineWinsWithoutConstructingAMap() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .declined, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .notEnabled
        )
    }

    func testAcceptedRequiresKeyGeometryAndHealthyLoad() {
        XCTAssertEqual(
            amapMapPresentation(
                decision: .accepted, hasAPIKey: true, hasGeometry: true, loadFailed: false
            ),
            .map
        )
        for inputs in [(false, true, false), (true, false, false), (true, true, true)] {
            XCTAssertEqual(
                amapMapPresentation(
                    decision: .accepted,
                    hasAPIKey: inputs.0,
                    hasGeometry: inputs.1,
                    loadFailed: inputs.2
                ),
                .unavailable
            )
        }
    }
}
