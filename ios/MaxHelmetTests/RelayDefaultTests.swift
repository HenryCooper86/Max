import XCTest
@testable import MaxHelmet

final class RelayDefaultTests: XCTestCase {

    func testDeviceRelayUsesTheConfiguredHost() {
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["HorizonRelayHost": " relay.example.org "]),
            "wss://relay.example.org/agent"
        )
    }

    func testDeviceRelayFallsBackToAPlaceholderWhenUnset() {
        XCTAssertEqual(MainViewModel.deviceRelayURL(infoDictionary: [:]), "wss://relay.example.com/agent")
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["HorizonRelayHost": ""]),
            "wss://relay.example.com/agent"
        )
        XCTAssertEqual(
            MainViewModel.deviceRelayURL(infoDictionary: ["HorizonRelayHost": "$(MAX_RELAY_HOST)"]),
            "wss://relay.example.com/agent"
        )
    }
}
