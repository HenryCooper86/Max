import XCTest
@testable import MaxHelmet

@MainActor
final class AMapConsentStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "AMapConsentStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testUnknownPromptsExactlyWhenRequested() {
        let store = AMapConsentStore(defaults: defaults)
        XCTAssertEqual(store.decision, .unknown)
        XCTAssertFalse(store.isPromptPresented)
        store.requestIfNeeded()
        XCTAssertTrue(store.isPromptPresented)
    }

    func testAcceptanceAndDeclinePersistWithoutAutomaticReprompt() {
        let accepted = AMapConsentStore(defaults: defaults)
        accepted.accept()
        XCTAssertEqual(AMapConsentStore(defaults: defaults).decision, .accepted)

        let secondDefaults = UserDefaults(suiteName: "AMapConsentStoreTests.\(UUID().uuidString)")!
        let declined = AMapConsentStore(defaults: secondDefaults)
        declined.decline()
        let relaunched = AMapConsentStore(defaults: secondDefaults)
        relaunched.requestIfNeeded()
        XCTAssertEqual(relaunched.decision, .declined)
        XCTAssertFalse(relaunched.isPromptPresented)
    }

    func testDeclinedRiderCanExplicitlyReconsiderAndAccept() {
        let store = AMapConsentStore(defaults: defaults)
        store.decline()
        store.reconsider()
        XCTAssertTrue(store.isPromptPresented)
        store.accept()
        XCTAssertEqual(store.decision, .accepted)
        XCTAssertFalse(store.isPromptPresented)
    }
}
