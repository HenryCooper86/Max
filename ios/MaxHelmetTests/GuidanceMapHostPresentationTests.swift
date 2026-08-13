import XCTest
@testable import MaxHelmet

@MainActor
final class GuidanceMapHostPresentationTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "GuidanceMapHostPresentationTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testUnknownRoutePresentsConsentSheetJustInTime() {
        let store = AMapConsentStore(defaults: defaults)

        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: store.decision,
                hasAPIKey: false,
                hasGeometry: true,
                loadFailed: false,
                requiresDevice: false
            ),
            .consentRequired
        )
        XCTAssertFalse(store.isPromptPresented)

        store.requestIfNeeded()

        XCTAssertTrue(store.isPromptPresented)
    }

    func testDeclinedRouteUsesNotEnabledPlaceholderAndExplicitReconsideration() {
        let store = AMapConsentStore(defaults: defaults)
        store.decline()

        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: store.decision,
                hasAPIKey: true,
                hasGeometry: true,
                loadFailed: false,
                requiresDevice: false
            ),
            .notEnabled
        )

        store.reconsider()

        XCTAssertTrue(store.isPromptPresented)
    }

    func testAcceptedKeyedHealthyRouteYieldsNativeMapWithAcceptedCapability() throws {
        let acceptedConsent = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))

        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: .accepted,
                hasAPIKey: true,
                hasGeometry: true,
                loadFailed: false,
                requiresDevice: false
            ),
            .nativeMap(acceptedConsent)
        )
    }

    func testMissingKeyInvalidGeometryLoadFailureAndSimulatorYieldUnavailableMapSurface() {
        for inputs in [
            (false, true, false, false),
            (true, false, false, false),
            (true, true, true, false),
            (true, true, false, true)
        ] {
            XCTAssertEqual(
                guidanceMapHostViewState(
                    decision: .accepted,
                    hasAPIKey: inputs.0,
                    hasGeometry: inputs.1,
                    loadFailed: inputs.2,
                    requiresDevice: inputs.3
                ),
                .unavailable
            )
        }
    }

    func testNonacceptedDecisionsCannotYieldNativeMap() {
        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: .unknown,
                hasAPIKey: true,
                hasGeometry: true,
                loadFailed: false,
                requiresDevice: false
            ),
            .consentRequired
        )
        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: .declined,
                hasAPIKey: true,
                hasGeometry: true,
                loadFailed: false,
                requiresDevice: false
            ),
            .notEnabled
        )
    }
}
