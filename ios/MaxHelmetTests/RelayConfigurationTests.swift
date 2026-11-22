import CoreLocation
import XCTest
@testable import MaxHelmet

private final class IdleCompanionClient: CompanionClientControlling {
    var onState: ((CompanionConnectionState) -> Void)?
    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool) {}
    func pair(code: String) {}
    func pairDiscover(token: String) {}
    func startRide() {}
    func stopRide() {}
    func stopRide(completion: @escaping (CompanionActionResult) -> Void) {}
    func unpair() {}
    func unpair(completion: @escaping (CompanionActionResult) -> Void) {}
    func sendLatest(_ fix: CompanionFix) {}
    func disconnect() {}
}

private final class IdleLocationStream: CompanionLocationStreaming {
    var onFix: ((CLLocation) -> Void)?
    var onPermission: ((CompanionLocationPermission) -> Void)?
    func startFromForeground() -> Bool { false }
    func stop() {}
}

private final class IdleDiscovery: HelmetDiscovering {
    var onUpdate: (([DiscoveredHelmet]) -> Void)?
    func start() {}
    func stop() {}
}

final class RelayConfigurationTests: XCTestCase {
    func testThePlaceholderAndAnEmptyAddressMeanTheRelayIsNotConfigured() {
        XCTAssertEqual(relaySetupProblem(relayURL: MainViewModel.deviceRelayURL(infoDictionary: [:])), .notConfigured)
        XCTAssertEqual(relaySetupProblem(relayURL: "wss://relay.example.com/agent"), .notConfigured)
        XCTAssertEqual(relaySetupProblem(relayURL: "  "), .notConfigured)
        XCTAssertEqual(relaySetupProblem(relayURL: "wss://RELAY.EXAMPLE.COM:443/agent"), .notConfigured)
    }

    func testARealAddressIsConfigured() {
        XCTAssertNil(relaySetupProblem(relayURL: "wss://relay.example.org/agent"))
        XCTAssertNil(relaySetupProblem(relayURL: "ws://localhost:8787/agent"))
        XCTAssertNil(relaySetupProblem(relayURL: "ws://192.168.1.20:8787/agent"))
        // A malformed address is a different problem: the session reports it.
        XCTAssertNil(relaySetupProblem(relayURL: "not a url"))
    }

    func testTheExplanationSaysWhatToDoInBothLanguages() {
        for language in [AppLanguage.zh, .en] {
            let title = L("relay.unset.title", in: language)
            let body = L("relay.unset.body", in: language)
            XCTAssertNotEqual(title, "relay.unset.title")
            XCTAssertTrue(body.contains("MAX_RELAY_HOST"), "\(language): name the setting")
            XCTAssertTrue(body.contains("Secrets.xcconfig"), "\(language): name the file")
        }
        XCTAssertEqual(L("relay.unset.title", in: .en), "Relay not configured")
    }

    func testStartingHandsFreeWithoutARelayShowsTheSetupStateInsteadOfConnecting() {
        let suite = "relay-config-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("wss://relay.example.com/agent", forKey: "relay_url")
        let viewModel = MainViewModel(
            defaults: defaults,
            initialAuthToken: "",
            initialSessionToken: "",
            companionClient: IdleCompanionClient(),
            locationStream: IdleLocationStream(),
            helmetDiscovery: IdleDiscovery(),
            authLogout: { _, _, _ in },
            persistSecret: { _, _ in },
            monotonicNow: { 0 },
            wallClock: { Date(timeIntervalSince1970: 0) },
            schedule: { _, _ in },
            voiceActions: MainViewModelVoiceActions(
                acknowledgeAuthRequired: {}, selectTranscriptOwner: { _ in },
                isHandsFree: { false }, stop: {}
            )
        )
        XCTAssertFalse(viewModel.relaySetupRequired)

        viewModel.toggleHandsFree()

        XCTAssertTrue(viewModel.relaySetupRequired)
        XCTAssertFalse(viewModel.session.state.handsFree, "no connection attempt against the placeholder")

        viewModel.relayURL = "ws://192.168.1.20:8787/agent"
        XCTAssertFalse(viewModel.relaySetupRequired, "fixing the address clears the notice")
    }
}
