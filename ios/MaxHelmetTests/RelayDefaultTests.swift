import XCTest
@testable import MaxHelmet

final class RelayDefaultTests: XCTestCase {

    func testDeviceRelayUsesTheConfiguredHost() {
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["MaxRelayHost": " relay.example.org "]),
            "wss://relay.example.org/agent"
        )
    }

    func testDeviceRelayFallsBackToAPlaceholderWhenUnset() {
        XCTAssertEqual(MainViewModel.deviceRelayURL(infoDictionary: [:]), "wss://relay.example.com/agent")
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["MaxRelayHost": ""]),
            "wss://relay.example.com/agent"
        )
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["MaxRelayHost": "$(MAX_RELAY_HOST)"]),
            "wss://relay.example.com/agent"
        )
    }
}
