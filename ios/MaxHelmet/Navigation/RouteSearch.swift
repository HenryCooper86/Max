import CoreLocation
import MapKit

/// Resolves a spoken place to a full route, and re-resolves from a moved origin.
protocol NavigationRouteSearching {
    func route(to query: String) async -> NavigationRoute?
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute?
}

/// Pure assembler, extracted so the MKRoute→NavigationRoute shape is testable
/// without constructing MapKit objects.
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

/// MapKit-backed search. Automobile transport only — no motorcycle profile, so
/// routes follow car rules and will not respect 摩托车禁行 roads. Cross-border
/// requests from a China-region device return nil.
struct MapKitNavigationSearch: NavigationRouteSearching {
    func route(to query: String) async -> NavigationRoute? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { return nil }
        let directions = MKDirections.Request()
        directions.destination = item
        directions.transportType = .automobile
        guard let mkRoute = try? await MKDirections(request: directions).calculate().routes.first else { return nil }
        return convert(mkRoute, name: item.name ?? query, destination: item.placemark.coordinate)
    }

    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        let directions = MKDirections.Request()
        directions.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
        directions.destination = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        directions.transportType = .automobile
        guard let mkRoute = try? await MKDirections(request: directions).calculate().routes.first else { return nil }
        return convert(mkRoute, name: "目的地", destination: destination)
    }

    private func convert(_ mkRoute: MKRoute, name: String, destination: CLLocationCoordinate2D) -> NavigationRoute {
        let pointCount = mkRoute.polyline.pointCount
        var coords = [CLLocationCoordinate2D](repeating: .init(), count: pointCount)
        mkRoute.polyline.getCoordinates(&coords, range: NSRange(location: 0, length: pointCount))
        let steps = mkRoute.steps
            .filter { !$0.instructions.isEmpty }
            .map { ManeuverStep(instruction: $0.instructions, coordinate: $0.polyline.coordinate, distanceMeters: $0.distance) }
        return makeNavigationRoute(
            name: name, destination: destination, polyline: coords, steps: steps,
            totalDistanceMeters: mkRoute.distance, totalEtaSeconds: mkRoute.expectedTravelTime
        )
    }
}
