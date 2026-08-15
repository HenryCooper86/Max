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
                requiresDevice: false
            ),
            .consentRequired
        )
        XCTAssertFalse(store.isPromptPresented)

        handleGuidanceMapHostLifecycle(.appeared, consent: store)

        XCTAssertTrue(store.isPromptPresented)
    }

    func testHostAppearanceDoesNotRepromptAcceptedOrDeclinedConsent() {
        let accepted = AMapConsentStore(defaults: defaults)
        accepted.accept()
        handleGuidanceMapHostLifecycle(.appeared, consent: accepted)
        XCTAssertFalse(accepted.isPromptPresented)

        let declinedSuiteName = "GuidanceMapHostPresentationTests.\(UUID().uuidString)"
        let declinedDefaults = UserDefaults(suiteName: declinedSuiteName)!
        defer { declinedDefaults.removePersistentDomain(forName: declinedSuiteName) }
        let declined = AMapConsentStore(defaults: declinedDefaults)
        declined.decline()
        handleGuidanceMapHostLifecycle(.appeared, consent: declined)
        XCTAssertFalse(declined.isPromptPresented)
    }

    func testDeclinedRouteUsesNotEnabledPlaceholderAndExplicitReconsideration() {
        let store = AMapConsentStore(defaults: defaults)
        store.decline()

        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: store.decision,
                hasAPIKey: true,
                hasGeometry: true,
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
                requiresDevice: false
            ),
            .nativeMap(acceptedConsent)
        )
    }

    func testMissingKeyInvalidGeometryAndSimulatorYieldUnavailableMapSurface() {
        for inputs in [
            (false, true, false),
            (true, false, false),
            (true, true, true)
        ] {
            XCTAssertEqual(
                guidanceMapHostViewState(
                    decision: .accepted,
                    hasAPIKey: inputs.0,
                    hasGeometry: inputs.1,
                    requiresDevice: inputs.2
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
                requiresDevice: false
            ),
            .consentRequired
        )
        XCTAssertEqual(
            guidanceMapHostViewState(
                decision: .declined,
                hasAPIKey: true,
                hasGeometry: true,
                requiresDevice: false
            ),
            .notEnabled
        )
    }

    func testAcceptedMapStaysStructuralNativeThroughRepeatedFailuresAndRecovery() throws {
        let accepted = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))

        let healthy = guidanceMapHostPresentation(
            decision: .accepted,
            hasAPIKey: true,
            hasGeometry: true,
            loadFailed: false,
            requiresDevice: false
        )
        let failures = (0..<10).map { _ in
            guidanceMapHostPresentation(
                decision: .accepted,
                hasAPIKey: true,
                hasGeometry: true,
                loadFailed: true,
                requiresDevice: false
            )
        }
        let recovered = guidanceMapHostPresentation(
            decision: .accepted,
            hasAPIKey: true,
            hasGeometry: true,
            loadFailed: false,
            requiresDevice: false
        )

        XCTAssertEqual(healthy, .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: false))
        XCTAssertTrue(failures.allSatisfy {
            $0 == .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: true)
        })
        XCTAssertEqual(recovered, .init(viewState: .nativeMap(accepted), showsUnavailableOverlay: false))
    }

    func testStatesWithoutNativeMapNeverShowLoadFailureOverlay() {
        let cases: [(
            decision: AMapConsentDecision,
            hasAPIKey: Bool,
            hasGeometry: Bool,
            requiresDevice: Bool,
            expected: GuidanceMapHostViewState
        )] = [
            (.unknown, true, true, false, .consentRequired),
            (.declined, true, true, false, .notEnabled),
            (.accepted, false, true, false, .unavailable),
            (.accepted, true, false, false, .unavailable),
            (.accepted, true, true, true, .unavailable),
        ]

        for item in cases {
            let presentation = guidanceMapHostPresentation(
                decision: item.decision,
                hasAPIKey: item.hasAPIKey,
                hasGeometry: item.hasGeometry,
                loadFailed: true,
                requiresDevice: item.requiresDevice
            )

            XCTAssertEqual(presentation.viewState, item.expected)
            XCTAssertFalse(presentation.showsUnavailableOverlay)
        }
    }
}
