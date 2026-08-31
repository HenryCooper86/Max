import XCTest
@testable import MaxHelmet

final class AMapSDKBootstrapperTests: XCTestCase {
    func testDeclinedConsentAndMissingKeyNeverInvokeSDKConfiguration() {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0
        let configuration = AMapSDKPrivacyConfiguration(
            showPrivacy: { calls += 1 },
            agreePrivacy: { calls += 1 },
            enableHTTPS: { calls += 1 },
            assignAPIKey: { _ in calls += 1 }
        )
        let acceptedConsent = AMapAcceptedConsent(decision: .accepted)

        XCTAssertNil(AMapAcceptedConsent(decision: .declined))
        XCTAssertFalse(
            bootstrapper.prepare(
                consent: AMapAcceptedConsent(decision: .declined),
                apiKey: "configured-value",
                configuration: configuration
            )
        )
        XCTAssertFalse(
            bootstrapper.prepare(
                consent: acceptedConsent,
                apiKey: "   ",
                configuration: configuration
            )
        )

        XCTAssertEqual(calls, 0)
    }

    func testValidKeyConfiguresExactlyOnceWithoutExposingIt() throws {
        let bootstrapper = AMapSDKBootstrapper()
        var calls = 0
        let configuration = AMapSDKPrivacyConfiguration(
            showPrivacy: { calls += 1 },
            agreePrivacy: { calls += 1 },
            enableHTTPS: { calls += 1 },
            assignAPIKey: { value in
                XCTAssertFalse(value.isEmpty)
                calls += 1
            }
        )
        let consent = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))

        XCTAssertTrue(
            bootstrapper.prepare(
                consent: consent,
                apiKey: "configured-value",
                configuration: configuration
            )
        )
        XCTAssertTrue(
            bootstrapper.prepare(
                consent: consent,
                apiKey: "configured-value",
                configuration: configuration
            )
        )

        XCTAssertEqual(calls, 4)
        XCTAssertFalse(String(describing: bootstrapper).contains("configured-value"))
    }

    func testPrepareUsesPrivacyConfigurationSeamInRequiredOrder() throws {
        let bootstrapper = AMapSDKBootstrapper()
        var calls: [String] = []
        let configuration = AMapSDKPrivacyConfiguration(
            showPrivacy: { calls.append("show") },
            agreePrivacy: { calls.append("agree") },
            enableHTTPS: { calls.append("https") },
            assignAPIKey: { _ in calls.append("key") }
        )

        XCTAssertTrue(
            bootstrapper.prepare(
                consent: try XCTUnwrap(AMapAcceptedConsent(decision: .accepted)),
                apiKey: "configured-value",
                configuration: configuration
            )
        )

        XCTAssertEqual(calls, ["show", "agree", "https", "key"])
    }

    func testConcurrentAcceptedPreparationConfiguresExactlyOnce() throws {
        let bootstrapper = AMapSDKBootstrapper()
        let consent = try XCTUnwrap(AMapAcceptedConsent(decision: .accepted))
        let lock = NSLock()
        var calls = 0
        let configuration = AMapSDKPrivacyConfiguration(
            showPrivacy: {
                lock.lock()
                calls += 1
                lock.unlock()
            },
            agreePrivacy: {
                lock.lock()
                calls += 1
                lock.unlock()
            },
            enableHTTPS: {
                lock.lock()
                calls += 1
                lock.unlock()
            },
            assignAPIKey: { _ in
                lock.lock()
                calls += 1
                lock.unlock()
            }
        )
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "AMapSDKBootstrapperTests", attributes: .concurrent)

        for _ in 0 ..< 100 {
            group.enter()
            queue.async {
                XCTAssertTrue(
                    bootstrapper.prepare(
                        consent: consent,
                        apiKey: "configured-value",
                        configuration: configuration
                    )
                )
                group.leave()
            }
        }

        XCTAssertEqual(group.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(calls, 4)
    }
}
