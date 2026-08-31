import XCTest
@testable import MaxHelmet

final class AMapConfigurationTests: XCTestCase {
    func testTrimsAConfiguredKey() {
        let configuration = AMapConfiguration(
            infoDictionary: [AMapConfiguration.plistKey: "  bundle-restricted-value  "]
        )
        XCTAssertEqual(configuration.apiKey, "bundle-restricted-value")
        XCTAssertTrue(configuration.hasAPIKey)
    }

    func testMissingEmptyAndUnexpandedBuildSettingsAreUnavailable() {
        for value in [nil, "", "   ", "$(AMAP_IOS_KEY)"] {
            var dictionary: [String: Any] = [:]
            if let value { dictionary[AMapConfiguration.plistKey] = value }
            let configuration = AMapConfiguration(infoDictionary: dictionary)
            XCTAssertNil(configuration.apiKey)
            XCTAssertFalse(configuration.hasAPIKey)
        }
    }
}
