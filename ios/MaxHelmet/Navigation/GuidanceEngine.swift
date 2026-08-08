import CoreLocation
import Foundation

/// Distance bands at which a maneuver is announced. Each fires once per
/// maneuver; thresholds are cleared when the engine advances to the next one.
enum PromptThreshold: CaseIterable, Equatable {
    case far, near, now

    var meters: Double {
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
    /// Thresholds already spoken for the *current* maneuver only; cleared on advance.
    var firedThresholds: Set<PromptThreshold>
    var arrived: Bool
}

/// The engine's output for one fix.
struct GuidanceUpdate: Equatable {
    var progress: GuidanceProgress
    var distanceToManeuverMeters: Double
    var remainingMeters: Double
    var remainingSeconds: Double
    var offRoute: Bool
    var arrived: Bool
    var spokenPrompt: String?
    /// Identity of the threshold that fired this tick, if any. The interrupt
    /// decision MUST key on this, never on `spokenPrompt` text: the "now"
    /// template is the bare instruction, with no "现在" marker left to grep for.
    var firedThreshold: PromptThreshold?
    var currentInstruction: String?
}

/// Pure route math and prompt timing — no I/O, no CoreLocation manager. Every
/// decision the rider's safety depends on lives here, so it can be table-
/// tested. Literal port of shared/guidance.ts's `step`: the constants, the
/// snap math (see Geo.swift), and the six rules below must stay identical to
/// the TypeScript/Kotlin siblings so guidance never diverges by device.
enum GuidanceEngine {
    static let offRouteThresholdMeters = 50.0
    static let arrivalRadiusMeters = 30.0
    static let maneuverAdvanceMeters = 30.0

    /// Advances guidance by one fix. Pure function of (position, route,
    /// progress): the caller supplies the previous `GuidanceProgress` and
    /// gets the next one back in `update.progress`, never mutated in place,
    /// so a fix can be re-run safely (e.g. after a GPS correction).
    ///
    /// Port contract shared with the TypeScript/Kotlin siblings
    /// (shared/guidance.ts:128-170, adapted here) — keep these six rules
    /// identical across platforms so guidance never diverges by device:
    ///
    /// 1. Single distance metric: every prompt threshold AND the "reached
    ///    this maneuver" check both read the SAME along-route distance
    ///    (maneuver `alongRouteMeters` minus the snapped along-route
    ///    position). There is no second, straight-line-to-coordinate metric —
    ///    a curved approach means haversine distance is a chord shorter than
    ///    the along-route path, and mixing metrics lets "reached" (30 m) fire
    ///    before "now" (40 m), skipping the safety-critical prompt entirely.
    /// 2. Prompt-before-advance ordering: within one fix, the current
    ///    maneuver's threshold prompt is decided FIRST, using its pre-advance
    ///    distance; only then is the advance condition evaluated. A fix that
    ///    both crosses the "now" threshold and reaches the maneuver in the
    ///    same tick still speaks the prompt — the returned `progress`
    ///    reflects the post-advance maneuver, but `spokenPrompt` is the one
    ///    that just fired for the maneuver being left behind.
    /// 3. Off-route freezes progression, not just prompts: while `offRoute`
    ///    is true, `maneuverIndex` and `firedThresholds` carry through
    ///    unchanged — no prompt fires and no advance happens, however far
    ///    along the route the (untrusted) snapped position appears to be.
    ///    Reroute policy is the caller's job; this function only reports the
    ///    fact and waits.
    /// 4. `arrived` is sticky: once true it stays true regardless of
    ///    subsequent fixes (a noisy GPS reading after arrival must not
    ///    un-arrive the rider). The caller resets it only by starting a
    ///    fresh `GuidanceProgress` for a new route, never by an in-band
    ///    "un-arrive" call.
    /// 5. Snap tie-break: when two polyline segments are equidistant, the
    ///    FIRST one in array order (lowest index) wins — the snap loop only
    ///    replaces the best match on a strictly-smaller cross-track distance.
    /// 6. Arrival is a DIFFERENT metric from rule 1 by design: it is the
    ///    straight-line (haversine) distance from the fix to the route's
    ///    final polyline vertex, not an along-route distance. It is evaluated
    ///    on every fix regardless of `offRoute` — arrival wins over
    ///    off-route, because a rider who is close enough to the destination
    ///    but has drifted off the plotted polyline (parking lot, driveway,
    ///    wrong side of a divided road) must still be told they've arrived.
    ///    Like rule 4, arrival is sticky.
    static func step(
        position: CLLocationCoordinate2D,
        route: NavigationRoute,
        progress: GuidanceProgress
    ) -> GuidanceUpdate {
        let snap = Geo.snapToRoute(position, route.polyline)
        let offRoute = snap.crossTrackMeters > offRouteThresholdMeters

        let lastPoint = route.polyline.last
        let distanceToDestination = lastPoint.map { Geo.haversineMeters(position, $0) } ?? .infinity
        let arrived = progress.arrived || distanceToDestination <= arrivalRadiusMeters

        var maneuverIndex = progress.maneuverIndex
        var firedThresholds = progress.firedThresholds
        var spokenPrompt: String?
        var firedThreshold: PromptThreshold?

        // Prompt-then-advance, gated entirely behind on-route — see rules 1-3 above.
        if !offRoute {
            let currentManeuver = maneuverIndex < route.steps.count ? route.steps[maneuverIndex] : nil
            if let currentManeuver {
                let distanceToManeuver = max(0, currentManeuver.alongRouteMeters - snap.alongRouteMeters)

                let due = PromptThreshold.allCases.filter { distanceToManeuver <= $0.meters && !firedThresholds.contains($0) }
                if !due.isEmpty {
                    let urgent = due.min { $0.meters < $1.meters }!
                    due.forEach { firedThresholds.insert($0) }
                    firedThreshold = urgent
                    spokenPrompt = urgent == .now
                        ? currentManeuver.instruction
                        : "前方\(Int((distanceToManeuver / 50).rounded()) * 50)米，\(currentManeuver.instruction)"
                }

                let reachedManeuver = distanceToManeuver <= maneuverAdvanceMeters
                    || snap.alongRouteMeters > currentManeuver.alongRouteMeters
                let hasNextManeuver = maneuverIndex + 1 < route.steps.count
                if reachedManeuver && hasNextManeuver {
                    maneuverIndex += 1
                    firedThresholds = []
                }
            }
        }

        let finalManeuver = maneuverIndex < route.steps.count ? route.steps[maneuverIndex] : nil
        let distanceToManeuverMeters = finalManeuver
            .map { max(0, $0.alongRouteMeters - snap.alongRouteMeters) }
            ?? max(0, route.totalDistanceMeters - snap.alongRouteMeters)
        let currentInstruction = finalManeuver?.instruction

        let remainingMeters = max(0, route.totalDistanceMeters - snap.alongRouteMeters)
        let remainingSeconds = route.totalDistanceMeters > 0
            ? route.totalEtaSeconds * remainingMeters / route.totalDistanceMeters
            : 0

        return GuidanceUpdate(
            progress: GuidanceProgress(maneuverIndex: maneuverIndex, firedThresholds: firedThresholds, arrived: arrived),
            distanceToManeuverMeters: distanceToManeuverMeters,
            remainingMeters: remainingMeters,
            remainingSeconds: remainingSeconds,
            offRoute: offRoute,
            arrived: arrived,
            spokenPrompt: offRoute ? nil : spokenPrompt,
            firedThreshold: offRoute ? nil : firedThreshold,
            currentInstruction: currentInstruction
        )
    }
}
