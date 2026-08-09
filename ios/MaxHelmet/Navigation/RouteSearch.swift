import CoreLocation

/// Resolves a spoken place to a full route from a given origin, and re-resolves
/// from a moved origin. The relay is the only backend (`RelayNavigationSearch`)
/// — there is no on-device fallback of any kind.
protocol NavigationRouteSearching {
    func route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
    /// Resolves whatever request is currently held with an honest failure —
    /// used by an explicit `navigation.stop` to fail an in-flight
    /// `start(_:)`'s relay search immediately, rather than leaving that
    /// request's own `perform()` (and the device slot it holds) suspended
    /// until the relay's own timeout. A no-op when nothing is held.
    /// `RelayNavigationSearch` already implements this (it also uses it for
    /// socket teardown); this just widens the protocol so the controller can
    /// reach it through the reference it already holds.
    func failPending()
}

/// Pure assembler, extracted so a search backend's route answer is testable
/// without constructing its native/wire objects.
func makeNavigationRoute(
    name: String,
    destination: CLLocationCoordinate2D,
    polyline: [CLLocationCoordinate2D],
    steps: [ManeuverStep],
    totalDistanceMeters: Double,
    totalEtaSeconds: Double
) -> NavigationRoute {
    NavigationRoute(
        destinationName: name,
        destinationCoordinate: destination,
        polyline: polyline,
        steps: steps,
        totalDistanceMeters: totalDistanceMeters,
        totalEtaSeconds: totalEtaSeconds
    )
}
