import CoreLocation
import Foundation
import MapKit

struct Destination: Equatable {
    let name: String
    let coordinate: CLLocationCoordinate2D
    let distanceMeters: Double
    let etaSeconds: Double

    static func == (lhs: Destination, rhs: Destination) -> Bool {
        lhs.name == rhs.name
            && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude
            && lhs.distanceMeters == rhs.distanceMeters
            && lhs.etaSeconds == rhs.etaSeconds
    }
}

protocol RouteSearching {
    func search(_ query: String) async -> Destination?
}

/// MKLocalSearch for the place, MKDirections for distance and ETA. MapKit has
/// no motorcycle profile — only automobile, walking, and transit — so these
/// figures follow car routing and will not respect 摩托车禁行 roads.
/// Cross-border requests from a China-region device return no route.
struct MapKitRouteSearch: RouteSearching {
    func search(_ query: String) async -> Destination? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { return nil }

        let directions = MKDirections.Request()
        directions.destination = item
        directions.transportType = .automobile
        guard let route = try? await MKDirections(request: directions).calculate().routes.first else { return nil }

        return Destination(
            name: item.name ?? query,
            coordinate: item.placemark.coordinate,
            distanceMeters: route.distance,
            etaSeconds: route.expectedTravelTime
        )
    }
}

/// The spoken line. States distance and time only — it must never imply that
/// guidance has started, because this card issues none.
func destinationSummary(_ destination: Destination) -> String {
    let km = String(format: "%.1f", destination.distanceMeters / 1000)
    let minutes = Int((destination.etaSeconds / 60).rounded())
    return "\(destination.name)，距离 \(km) 公里，开车大约 \(minutes) 分钟。路线卡片已经显示。"
}

struct DestinationResolver: DeviceActionHandler {
    private let search: RouteSearching
    private let onResolved: (Destination) -> Void

    init(search: RouteSearching = MapKitRouteSearch(), onResolved: @escaping (Destination) -> Void) {
        self.search = search
        self.onResolved = onResolved
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .destinationShow(query) = action else { return .unsupported("action.mismatch") }
        guard let destination = await search.search(query) else { return .unsupported("route.unavailable") }
        onResolved(destination)
        return .ok
    }
}
