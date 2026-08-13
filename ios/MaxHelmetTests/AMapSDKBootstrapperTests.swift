import XCTest
@testable import MaxHelmet

final class AMapSDKBootstrapperTests: XCTestCase {
    func testEmptyKeyNeverInvokesSDKConfiguration() {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0

        XCTAssertFalse(bootstrapper.prepare(apiKey: "   ") { _ in calls += 1 })

        XCTAssertEqual(calls, 0)
    }

    func testValidKeyConfiguresExactlyOnceWithoutExposingIt() {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0
        let apply: (String) -> Void = { value in
            XCTAssertFalse(value.isEmpty)
            calls += 1
        }

        XCTAssertTrue(bootstrapper.prepare(apiKey: "configured-value", apply: apply))
        XCTAssertTrue(bootstrapper.prepare(apiKey: "configured-value", apply: apply))

        XCTAssertEqual(calls, 1)
        XCTAssertFalse(String(describing: bootstrapper).contains("configured-value"))
    }

    func testPrivacyIsShownAndAcceptedBeforeKeyAssignment() {
        var calls: [String] = []
        let configuration = AMapSDKPrivacyConfiguration(
            showPrivacy: { calls.append("show") },
            agreePrivacy: { calls.append("agree") },
            enableHTTPS: { calls.append("https") },
            assignAPIKey: { _ in calls.append("key") }
        )

        configuration.apply(apiKey: "configured-value")

        XCTAssertEqual(calls, ["show", "agree", "https", "key"])
    }
}
