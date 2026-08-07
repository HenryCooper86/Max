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
    private static let rerouteCooldownSeconds: TimeInterval = 15

    private let search: NavigationRouteSearching
    private let stream: LocationStreaming
    private let onGuidance: (GuidanceState?) -> Void
    private let speak: (String) -> Void
    private let interruptPlayback: () -> Void
    private let now: () -> TimeInterval

    private var route: NavigationRoute?
    private var progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    private var rerouting = false
    private var lastRerouteAt: TimeInterval = -.greatestFiniteMagnitude

    /// Nonisolated so a non-`@MainActor` owner (AgentSession's router) can build
    /// it in a stored/lazy property. It only wires collaborators; all navigation
    /// state is mutated on the main actor.
    nonisolated init(
        search: NavigationRouteSearching,
        stream: LocationStreaming,
        onGuidance: @escaping (GuidanceState?) -> Void,
        speak: @escaping (String) -> Void,
        interruptPlayback: @escaping () -> Void,
        now: @escaping () -> TimeInterval
    ) {
        self.search = search
        self.stream = stream
        self.onGuidance = onGuidance
        self.speak = speak
        self.interruptPlayback = interruptPlayback
        self.now = now
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
        guard let resolved = await search.route(to: query) else { return .unsupported("route.unavailable") }
        route = resolved
        progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
        stream.start()
        publish(location: nil)
        speak(openingSummary(resolved))
        return .ok
    }

    private func stopGuidance() -> DeviceActionResult {
        guard route != nil else { return .failed("navigation.notActive") }
        route = nil
        stream.stop()
        onGuidance(nil)
        speak("已停止导航。")
        return .ok
    }

    private func handleFix(_ location: CLLocationCoordinate2D) {
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
        speak("已偏离路线，正在重新规划。")
        Task { @MainActor in
            defer { rerouting = false }
            if let fresh = await search.reroute(to: destination, from: origin) {
                route = fresh
                progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
                publish(location: origin)
            } else {
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
