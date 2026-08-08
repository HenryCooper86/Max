import CoreLocation
import Foundation

enum LocationAuthorization {
    case authorized
    case denied
    case notDetermined
}

/// The location stream behind a protocol so the controller is testable with
/// synthetic coordinates. The real one is a CLLocationManager configured for
/// driving; it never runs unless navigating.
protocol LocationStreaming: AnyObject {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)? { get set }
    func authorization() -> LocationAuthorization
    func requestAccess() async -> Bool
    func start()
    func stop()
}

/// Owns the active route, the location stream, and the reroute/arrival
/// lifecycle. All the hard math is delegated to `GuidanceEngine`; this class is
/// orchestration and speech. Reference type: it holds live navigation state.
@MainActor
final class NavigationController: DeviceActionHandler {
    // Mirrors the web client's REROUTE_COOLDOWN_MS (src/lib/navigation.ts):
    // 20 s from send time. Was 15 s here pre-Task-4 — aligned to match.
    private static let rerouteCooldownSeconds: TimeInterval = 20

    private let search: NavigationRouteSearching
    private let stream: LocationStreaming
    private let onGuidance: (GuidanceState?) -> Void
    private let speak: (String) -> Void
    private let interruptPlayback: () -> Void
    private let now: () -> TimeInterval
    private let firstFixTimeoutSeconds: TimeInterval

    private var route: NavigationRoute?
    private var progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    private var rerouting = false
    private var lastRerouteAt: TimeInterval = -.greatestFiniteMagnitude
    private var firstFixContinuation: CheckedContinuation<CLLocationCoordinate2D?, Never>?
    private var firstFixWatchdog: Task<Void, Never>?
    /// Bumped once per `start(_:)` attempt. Nothing tears down `route`/the
    /// stream on behalf of a stale generation: a concurrent `start()` can
    /// supersede an in-flight first-fix wait, an in-flight search (both share
    /// RelayNavigationSearch's single-outstanding nav.request slot), or an
    /// in-flight reroute — and none of those superseded operations' eventual
    /// answers may still act once a newer generation owns navigation state.
    private var navigationGeneration = 0

    /// Nonisolated so a non-`@MainActor` owner (AgentSession's router) can build
    /// it in a stored/lazy property. It only wires collaborators; all navigation
    /// state is mutated on the main actor.
    nonisolated init(
        search: NavigationRouteSearching,
        stream: LocationStreaming,
        onGuidance: @escaping (GuidanceState?) -> Void,
        speak: @escaping (String) -> Void,
        interruptPlayback: @escaping () -> Void,
        now: @escaping () -> TimeInterval,
        firstFixTimeoutSeconds: TimeInterval = 3
    ) {
        self.search = search
        self.stream = stream
        self.onGuidance = onGuidance
        self.speak = speak
        self.interruptPlayback = interruptPlayback
        self.now = now
        self.firstFixTimeoutSeconds = firstFixTimeoutSeconds
        self.stream.onUpdate = { [weak self] coord in
            Task { @MainActor in self?.handleFix(coord) }
        }
    }

    // The protocol requirement is `async`, so this `@MainActor` witness is legal:
    // an actor-isolated async method may satisfy a nonisolated async requirement.
    // The whole body therefore runs on the main actor without any MainActor.run.
    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        switch action {
        case let .navigationStart(query):
            return await start(query)
        case .navigationStop:
            return stopGuidance()
        case let .destinationShow(query):
            // Legacy Spec 1 action from an older relay — start guidance too.
            return await start(query)
        default:
            return .unsupported("action.mismatch")
        }
    }

    private func start(_ query: String) async -> DeviceActionResult {
        switch stream.authorization() {
        case .denied:
            return .denied("permission.location")
        case .notDetermined:
            let granted = await stream.requestAccess()
            if !granted { return .denied("permission.location") }
        case .authorized:
            break
        }
        // Each attempt gets its own generation so a superseded attempt — at
        // any stage (first fix, search, or an in-flight reroute racing a
        // fresh start; see `attemptReroute`) — can tell it is no longer the
        // one responsible for `route`/the stream before touching either.
        navigationGeneration += 1
        let generation = navigationGeneration

        // The first fix must be in hand BEFORE searching: the relay routes
        // FROM the rider's position, so there is no query to send without it.
        stream.start()
        guard let origin = await awaitFirstFix(generation: generation) else {
            // Only stop the stream if nothing else is relying on it: a
            // still-active route from an earlier, already-succeeded start
            // (Important #2), or a newer generation that superseded this one
            // and is still in flight (Important #1), must keep it running.
            if generation == navigationGeneration, route == nil { stream.stop() }
            return .unsupported("route.unavailable")
        }
        guard let resolved = await search.route(to: query, from: origin) else {
            if generation == navigationGeneration, route == nil { stream.stop() }
            return .unsupported("route.unavailable")
        }
        guard generation == navigationGeneration else {
            // Superseded while the search was in flight (Important #3's
            // sibling case: a newer start(), not a reroute) — the newer
            // generation now owns `route`/the stream; do not stomp on it.
            return .unsupported("route.unavailable")
        }
        // Re-assert: a teardown elsewhere (e.g. arrival on the route this
        // request supersedes) may have stopped the stream since the
        // stream.start() call above ran — a route about to commit must
        // never land on a dead stream. Idempotent when it's already running.
        stream.start()
        route = resolved
        progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
        publish(location: nil)
        speak(openingSummary(resolved))
        return .ok
    }

    /// Awaits the location stream's first fix, bounded so a stalled GPS never
    /// hangs navigation.start indefinitely. Every fix — including this first
    /// one — still flows through `handleFix` (wired in `init`); the resolve
    /// there is a no-op once this has already resolved (by answer or timeout).
    ///
    /// Single-outstanding: a concurrent `start()` supersedes any first-fix
    /// wait already in flight. The stale one is resolved nil immediately
    /// (mirrors `RelayNavigationSearch.failPending()`) so its `perform()`
    /// always gets its one `device.result` instead of leaking the
    /// continuation forever — and its watchdog is guarded by `generation` so
    /// that even though `.cancel()` can't stop an already-sleeping Task's
    /// code from running, it can't resolve a LATER request's continuation
    /// once it wakes.
    private func awaitFirstFix(generation: Int) async -> CLLocationCoordinate2D? {
        resolveFirstFix(nil)
        return await withCheckedContinuation { (continuation: CheckedContinuation<CLLocationCoordinate2D?, Never>) in
            firstFixContinuation = continuation
            firstFixWatchdog = Task { @MainActor [weak self] in
                let timeout = self?.firstFixTimeoutSeconds ?? 3
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self, generation == self.navigationGeneration else { return }
                self.resolveFirstFix(nil)
            }
        }
    }

    private func resolveFirstFix(_ coordinate: CLLocationCoordinate2D?) {
        guard let continuation = firstFixContinuation else { return }
        firstFixContinuation = nil
        firstFixWatchdog?.cancel()
        firstFixWatchdog = nil
        continuation.resume(returning: coordinate)
    }

    private func stopGuidance() -> DeviceActionResult {
        guard route != nil else { return .failed("navigation.notActive") }
        // Teardown invalidates the generation: an explicit stop is a
        // deliberate "cancel everything" — any start or reroute already in
        // flight must never revive navigation once its answer arrives late.
        navigationGeneration += 1
        // A concurrent start() awaiting its first fix must not hang forever
        // once the bump above invalidates its generation: its own watchdog
        // would see the mismatch and correctly refuse to resolve it (see
        // awaitFirstFix), so the resolve has to happen here instead — a
        // no-op when nothing is currently awaiting a fix.
        resolveFirstFix(nil)
        route = nil
        stream.stop()
        onGuidance(nil)
        speak("已停止导航。")
        return .ok
    }

    private func handleFix(_ location: CLLocationCoordinate2D) {
        resolveFirstFix(location)
        guard let route else { return }
        let update = GuidanceEngine.step(position: location, route: route, progress: progress)
        progress = update.progress

        // Keyed on threshold IDENTITY, never on prompt text: the TS-ported
        // "now" template is the bare instruction with no "现在" marker left to
        // grep for, so a substring check here would silently swallow the
        // safety-critical interrupt.
        if update.firedThreshold == .now { interruptPlayback() }
        if let prompt = update.spokenPrompt { speak(prompt) }
        if update.arrived { speak("已到达目的地。") }

        publish(location: location, update: update)

        if update.arrived {
            // Deliberately does NOT bump navigationGeneration: arrival only
            // retires THIS route, not any other in-flight request. A start
            // already in progress for an unrelated destination (or a
            // reroute still trying to fix this very route) must be free to
            // land — its own commit site re-asserts stream.start(), so a
            // route that lands after this teardown is never streamless.
            // Contrast with stopGuidance/reroute-failure below, which are
            // explicit "stop everything" events and DO bump the generation.
            self.route = nil
            stream.stop()
            onGuidance(nil)
            return
        }
        if update.offRoute { attemptReroute(from: location, to: route.destinationCoordinate) }
    }

    private func attemptReroute(from origin: CLLocationCoordinate2D, to destination: CLLocationCoordinate2D) {
        guard !rerouting, now() - lastRerouteAt >= Self.rerouteCooldownSeconds else { return }
        rerouting = true
        lastRerouteAt = now()
        let generation = navigationGeneration
        speak("已偏离路线，正在重新规划。")
        Task { @MainActor in
            defer { rerouting = false }
            let fresh = await search.reroute(to: destination, from: origin)
            // A concurrent start() shares RelayNavigationSearch's single
            // outstanding nav.request slot, so it can fail THIS reroute
            // (nil) via failPending() while it supersedes it. Whichever way
            // this reroute resolves, a stale answer must never touch
            // `route`/the stream once a newer generation owns them — that
            // newer start is either still installing its own route or has
            // already installed one.
            guard generation == navigationGeneration else { return }
            if let fresh {
                // Re-assert for the same reason start()'s commit does: an
                // arrival teardown on this same route (see handleFix) may
                // have stopped the stream while this reroute was in flight.
                stream.start()
                route = fresh
                progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
                publish(location: origin)
            } else {
                // A genuine reroute failure is itself a "stop everything"
                // event — bump the generation for the same reason
                // stopGuidance does, so nothing still tied to this
                // generation can later revive what was just torn down.
                navigationGeneration += 1
                route = nil
                stream.stop()
                onGuidance(nil)
                speak("无法重新规划路线，已停止导航。")
            }
        }
    }

    private func publish(location: CLLocationCoordinate2D?, update: GuidanceUpdate? = nil) {
        guard let route else { return }
        let maneuver = update?.currentInstruction ?? route.steps.first?.instruction
        onGuidance(GuidanceState(
            destinationName: route.destinationName,
            polyline: route.polyline,
            currentLocation: location,
            maneuverInstruction: maneuver,
            distanceToManeuverMeters: update?.distanceToManeuverMeters ?? route.totalDistanceMeters,
            remainingDistanceMeters: update?.remainingMeters ?? route.totalDistanceMeters,
            remainingSeconds: update?.remainingSeconds ?? route.totalEtaSeconds,
            offRoute: update?.offRoute ?? false
        ))
    }

    private func openingSummary(_ route: NavigationRoute) -> String {
        let km = String(format: "%.1f", route.totalDistanceMeters / 1000)
        let minutes = Int((route.totalEtaSeconds / 60).rounded())
        let firstTurn = route.steps.first.map { "，" + $0.instruction } ?? ""
        return "开始导航，全程 \(km) 公里，预计 \(minutes) 分钟\(firstTurn)。仅供参考，请注意实际路况。"
    }
}

/// Production `LocationStreaming`, a CLLocationManager configured for driving.
/// Runs only while navigating; the app's idle-timer-disabled hands-free session
/// keeps it foregrounded, so WhenInUse authorization is sufficient.
final class SystemLocationStream: NSObject, LocationStreaming, CLLocationManagerDelegate {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    private let manager = CLLocationManager()
    private var accessContinuation: CheckedContinuation<Bool, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .automotiveNavigation
        manager.distanceFilter = 10
    }

    func authorization() -> LocationAuthorization {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            accessContinuation = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    func start() { manager.startUpdatingLocation() }
    func stop() { manager.stopUpdatingLocation() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let coord = locations.last?.coordinate { onUpdate?(coord) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let continuation = accessContinuation else { return }
        accessContinuation = nil
        continuation.resume(returning: authorization() == .authorized)
    }
}
