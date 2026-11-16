import CoreLocation

struct AMapCoordinateBounds: Equatable {
    let center: CLLocationCoordinate2D
    let latitudeSpan: Double
    let longitudeSpan: Double

    static func == (lhs: Self, rhs: Self) -> Bool {
        coordinatesEqual(lhs.center, rhs.center)
            && lhs.latitudeSpan == rhs.latitudeSpan
            && lhs.longitudeSpan == rhs.longitudeSpan
    }
}

struct AMapRouteDisplayModel: Equatable {
    let polyline: [CLLocationCoordinate2D]
    let currentLocation: CLLocationCoordinate2D?
    let bounds: AMapCoordinateBounds
    var destinationName: String = ""
    var nextTurn: CLLocationCoordinate2D? = nil
    var nextTurnInstruction: String? = nil

    static func make(guidance: GuidanceState, followsRider: Bool = false) -> Self? {
        guard guidance.polyline.count >= 2,
              guidance.polyline.allSatisfy(isValidCoordinate),
              guidance.currentLocation.map(isValidCoordinate) ?? true else {
            return nil
        }

        let route = guidance.polyline.map(CoordinateDatum.wgs84ToGcj02)
        let rider = guidance.currentLocation.map(CoordinateDatum.wgs84ToGcj02)
        guard route.allSatisfy(isValidCoordinate),
              rider.map(isValidCoordinate) ?? true else {
            return nil
        }

        return Self(
            polyline: route,
            currentLocation: rider,
            bounds: followsRider && rider != nil
                ? AMapCoordinateBounds(center: rider!, latitudeSpan: 0.006, longitudeSpan: 0.008)
                : makeBounds(route: route, currentLocation: rider),
            destinationName: guidance.destinationName,
            nextTurn: guidance.upcomingSteps.first.map { CoordinateDatum.wgs84ToGcj02($0.step.coordinate) },
            nextTurnInstruction: guidance.upcomingSteps.first?.step.displayInstruction
        )
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy(coordinatesEqual)
            && optionalDisplayCoordinatesEqual(lhs.currentLocation, rhs.currentLocation)
            && lhs.bounds == rhs.bounds
            && lhs.destinationName == rhs.destinationName
            && optionalDisplayCoordinatesEqual(lhs.nextTurn, rhs.nextTurn)
            && lhs.nextTurnInstruction == rhs.nextTurnInstruction
    }
}

private func isValidCoordinate(_ coordinate: CLLocationCoordinate2D) -> Bool {
    coordinate.latitude.isFinite
        && coordinate.longitude.isFinite
        && (-90.0...90.0).contains(coordinate.latitude)
        && (-180.0...180.0).contains(coordinate.longitude)
}

private func makeBounds(
    route: [CLLocationCoordinate2D],
    currentLocation: CLLocationCoordinate2D?
) -> AMapCoordinateBounds {
    let coordinates = route + (currentLocation.map { [$0] } ?? [])
    let latitudes = coordinates.map(\.latitude)
    let longitudes = coordinates.map(\.longitude)
    let minLatitude = latitudes.min()!
    let maxLatitude = latitudes.max()!
    let minLongitude = longitudes.min()!
    let maxLongitude = longitudes.max()!
    let minimumSpan = 0.001

    return AMapCoordinateBounds(
        center: .init(
            latitude: (minLatitude + maxLatitude) / 2,
            longitude: (minLongitude + maxLongitude) / 2
        ),
        latitudeSpan: max(maxLatitude - minLatitude, minimumSpan),
        longitudeSpan: max(maxLongitude - minLongitude, minimumSpan)
    )
}

private func optionalDisplayCoordinatesEqual(
    _ lhs: CLLocationCoordinate2D?,
    _ rhs: CLLocationCoordinate2D?
) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (left?, right?): return coordinatesEqual(left, right)
    default: return false
    }
}
