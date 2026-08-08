import CoreLocation

/// Resolves a spoken place to a full route from a given origin, and re-resolves
/// from a moved origin. The relay is the only backend (`RelayNavigationSearch`)
/// — there is no on-device fallback of any kind.
protocol NavigationRouteSearching {
    func route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
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
