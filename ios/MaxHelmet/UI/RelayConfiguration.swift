import Foundation

// A device build without MAX_RELAY_HOST used to point at a placeholder host and
// fail like any unreachable relay. These helpers let the HUD say what is
// actually wrong and how to fix it.

#if MAX_RELAY_HOST_MISSING && !targetEnvironment(simulator)
// Release.xcconfig defines MAX_RELAY_HOST_MISSING when MAX_RELAY_HOST is empty.
#error("Release device builds need a relay: set MAX_RELAY_HOST in ios/Config/Secrets.xcconfig (see Secrets.xcconfig.example) or pass MAX_RELAY_HOST=<host> to xcodebuild.")
#endif

enum RelaySetupProblem: Equatable {
    case notConfigured
}

/// The host `MainViewModel.deviceRelayURL` falls back to when the build has none.
let placeholderRelayHost = "relay.example.com"

/// Distinguishes "nobody configured a relay" from every other connection
/// problem. A malformed address is left to the session, which already reports it.
func relaySetupProblem(relayURL: String) -> RelaySetupProblem? {
    let trimmed = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return .notConfigured }
    guard let host = URLComponents(string: trimmed)?.host?.lowercased() else { return nil }
    return host == placeholderRelayHost ? .notConfigured : nil
}
