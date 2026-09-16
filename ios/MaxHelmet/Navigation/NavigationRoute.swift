import CoreLocation

/// Two coordinates are equal within ~1 m — CLLocationCoordinate2D is not
/// Equatable and exact float comparison is fragile.
func coordinatesEqual(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Bool {
    abs(a.latitude - b.latitude) < 1e-5 && abs(a.longitude - b.longitude) < 1e-5
}

/// One turn on the route: what to do, where, and how long this step runs.
struct ManeuverStep: Equatable {
    let instruction: String
    let coordinate: CLLocationCoordinate2D
    /// Cumulative along-route distance from the route start to this maneuver,
    /// matching NavManeuver.alongRouteMeters on the wire. NOT a per-leg length.
    let alongRouteMeters: Double

    static func == (lhs: ManeuverStep, rhs: ManeuverStep) -> Bool {
        lhs.instruction == rhs.instruction
            && coordinatesEqual(lhs.coordinate, rhs.coordinate)
            && lhs.alongRouteMeters == rhs.alongRouteMeters
    }
}

/// The full route the engine needs — the geometry and turn list MapKit hands us
/// and Spec 1 threw away.
struct NavigationRoute: Equatable {
    let destinationName: String
    let destinationCoordinate: CLLocationCoordinate2D
    let polyline: [CLLocationCoordinate2D]
    let steps: [ManeuverStep]
    let totalDistanceMeters: Double
    let totalEtaSeconds: Double
    var relayCommandId: String? = nil

    static func == (lhs: NavigationRoute, rhs: NavigationRoute) -> Bool {
        lhs.destinationName == rhs.destinationName
            && coordinatesEqual(lhs.destinationCoordinate, rhs.destinationCoordinate)
            && lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy { coordinatesEqual($0, $1) }
            && lhs.steps == rhs.steps
            && lhs.totalDistanceMeters == rhs.totalDistanceMeters
            && lhs.totalEtaSeconds == rhs.totalEtaSeconds
    }
}

/// What the guidance card renders. Published on the session state.
struct GuidanceState: Equatable {
    let destinationName: String
    let polyline: [CLLocationCoordinate2D]
    var currentLocation: CLLocationCoordinate2D?
    var maneuverInstruction: String?
    var distanceToManeuverMeters: Double
    var remainingDistanceMeters: Double
    var remainingSeconds: Double
    var offRoute: Bool
    var confirmationID: UUID? = nil
    var upcomingSteps: [NavigationStepDetail] = []

    static func == (lhs: GuidanceState, rhs: GuidanceState) -> Bool {
        lhs.destinationName == rhs.destinationName
            && lhs.polyline.count == rhs.polyline.count
            && zip(lhs.polyline, rhs.polyline).allSatisfy { coordinatesEqual($0, $1) }
            && optionalCoordinatesEqual(lhs.currentLocation, rhs.currentLocation)
            && lhs.maneuverInstruction == rhs.maneuverInstruction
            && lhs.distanceToManeuverMeters == rhs.distanceToManeuverMeters
            && lhs.remainingDistanceMeters == rhs.remainingDistanceMeters
            && lhs.remainingSeconds == rhs.remainingSeconds
            && lhs.offRoute == rhs.offRoute
            && lhs.confirmationID == rhs.confirmationID
            && lhs.upcomingSteps == rhs.upcomingSteps
    }
}

private func optionalCoordinatesEqual(_ a: CLLocationCoordinate2D?, _ b: CLLocationCoordinate2D?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case let (l?, r?): return coordinatesEqual(l, r)
    default: return false
    }
}

struct NavigationStepDetail: Equatable, Identifiable {
    let id: Int
    let step: ManeuverStep
    let distanceMeters: Double
}

func navigationStepDetails(route: NavigationRoute, index: Int, remainingMeters: Double) -> [NavigationStepDetail] {
    let traveled = max(0, route.totalDistanceMeters - remainingMeters)
    return route.steps.enumerated().dropFirst(max(0, index)).map { index, step in
        NavigationStepDetail(id: index, step: step, distanceMeters: max(0, step.alongRouteMeters - traveled))
    }
}
