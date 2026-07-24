import Foundation

/// Resolves a spoken name to a phone number entirely on-device. The number
/// never leaves the phone; the relay only ever sends the spoken name.
protocol ContactResolving {
    func isAuthorized() async -> Bool
    func number(matching name: String) async -> String?
}
