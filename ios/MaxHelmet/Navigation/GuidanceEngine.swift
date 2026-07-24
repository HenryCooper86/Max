import CoreLocation
import Foundation

/// Distance bands at which a maneuver is announced. Each fires once per maneuver.
enum PromptThreshold: CaseIterable {
    case far, near, now

    var distanceMeters: Double {
        switch self {
        case .far: return 400
        case .near: return 150
        case .now: return 40
        }
    }
}

/// The mutable state the engine advances across fixes.
struct GuidanceProgress: Equatable {
    var maneuverIndex: Int
    var firedThresholds: Set<PromptThreshold>
    var arrived: Bool
}

/// The engine's output for one fix.
struct GuidanceUpdate: Equatable {
    var progress: GuidanceProgress
    var distanceToManeuverMeters: Double
    var remainingDistanceMeters: Double
    var remainingSeconds: Double
    var offRoute: Bool
    var spokenPrompt: String?
}

/// Pure route math and prompt timing — no I/O, no CoreLocation manager. Every
/// decision the rider's safety depends on lives here, so it can be table-tested.
enum GuidanceEngine {
    static let offRouteThresholdMeters = 50.0
    static let arrivalRadiusMeters = 30.0
    static let maneuverReachedMeters = 25.0

    static func step(
        location: CLLocationCoordinate2D,
        route: NavigationRoute,
        progress: GuidanceProgress
    ) -> GuidanceUpdate {
        var progress = progress
        let offRoute = Geo.nearestSegmentDistance(location, route.polyline) > offRouteThresholdMeters
        let distanceToDest = Geo.haversineMeters(location, route.destinationCoordinate)

        if distanceToDest <= arrivalRadiusMeters {
            progress.arrived = true
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: 0,
                remainingDistanceMeters: 0, remainingSeconds: 0,
                offRoute: offRoute, spokenPrompt: "已到达目的地。"
            )
        }

        guard progress.maneuverIndex < route.steps.count else {
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: distanceToDest,
                remainingDistanceMeters: distanceToDest,
                remainingSeconds: eta(route, distanceToDest),
                offRoute: offRoute, spokenPrompt: nil
            )
        }

        let maneuver = route.steps[progress.maneuverIndex]
        let distToManeuver = Geo.haversineMeters(location, maneuver.coordinate)

        // Reached this maneuver: advance to the next and announce nothing this tick.
        if distToManeuver <= maneuverReachedMeters, progress.maneuverIndex + 1 < route.steps.count {
            progress.maneuverIndex += 1
            progress.firedThresholds = []
            let next = route.steps[progress.maneuverIndex]
            let d = Geo.haversineMeters(location, next.coordinate)
            return GuidanceUpdate(
                progress: progress, distanceToManeuverMeters: d,
                remainingDistanceMeters: remaining(route, progress, d),
                remainingSeconds: eta(route, remaining(route, progress, d)),
                offRoute: offRoute, spokenPrompt: nil
            )
        }

        // Fire the most urgent unfired threshold the rider has crossed; mark all
        // crossed thresholds fired so a skipped-over one cannot fire later.
        var prompt: String?
        let due = PromptThreshold.allCases.filter { distToManeuver <= $0.distanceMeters && !progress.firedThresholds.contains($0) }
        if let urgent = due.min(by: { $0.distanceMeters < $1.distanceMeters }) {
            due.forEach { progress.firedThresholds.insert($0) }
            prompt = phrase(urgent, maneuver.instruction)
        }

        let remain = remaining(route, progress, distToManeuver)
        return GuidanceUpdate(
            progress: progress, distanceToManeuverMeters: distToManeuver,
            remainingDistanceMeters: remain, remainingSeconds: eta(route, remain),
            offRoute: offRoute, spokenPrompt: prompt
        )
    }

    private static func remaining(_ route: NavigationRoute, _ progress: GuidanceProgress, _ distToManeuver: Double) -> Double {
        let rest = route.steps.dropFirst(progress.maneuverIndex + 1).reduce(0.0) { $0 + $1.distanceMeters }
        return distToManeuver + rest
    }

    private static func eta(_ route: NavigationRoute, _ remaining: Double) -> Double {
        guard route.totalDistanceMeters > 0 else { return 0 }
        return route.totalEtaSeconds * min(1, remaining / route.totalDistanceMeters)
    }

    private static func phrase(_ threshold: PromptThreshold, _ instruction: String) -> String {
        switch threshold {
        case .far: return "前方400米，\(instruction)"
        case .near: return "150米后，\(instruction)"
        case .now: return "现在，\(instruction)"
        }
    }
}
