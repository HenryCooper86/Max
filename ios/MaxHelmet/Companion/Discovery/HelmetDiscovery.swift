import Foundation

/// A helmet beacon seen on the local network (or, in Phase 2, over BLE).
/// `token` is the same 32-lowercase-hex discovery token the board advertises
/// and `MainViewModel.pairDiscoveredHelmet(token:)` sends over the companion
/// socket — discovery never invents its own identity for a helmet.
struct DiscoveredHelmet: Equatable, Identifiable {
    let token: String       // 32 lowercase hex chars
    let transport: String   // "mdns" (Phase 2 adds "ble")
    var id: String { token }
}

extension DiscoveredHelmet {
    /// Collapses repeat beacons (a helmet can be seen on more than one
    /// interface, or re-announce during a browse) to one entry per token,
    /// keeping the first (most recent, since callers pass newest-first).
    static func merged(_ items: [DiscoveredHelmet]) -> [DiscoveredHelmet] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.token).inserted }
    }
}

/// Abstracts the discovery transport so the view model and tests never touch
/// `Network`/`NWBrowser` directly. Phase 2 adds a BLE-backed conformer beside
/// `BonjourHelmetDiscovery`.
protocol HelmetDiscovering: AnyObject {
    var onUpdate: (([DiscoveredHelmet]) -> Void)? { get set }
    func start()
    func stop()
}
