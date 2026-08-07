import CoreLocation
import Foundation

/// Relay-backed navigation search: turns `route`/`reroute` into a `nav.request`
/// over the agent socket, then suspends until `AgentSession` forwards the
/// matching `nav.route`/`nav.error` answer back through `handleNavRoute`/
/// `handleNavError` — or until the client-side timeout or `failPending()`
/// (socket teardown) resolves it instead. No MapKit fallback of any kind: a
/// relay that never answers is an honest `nil`, not a silent retry elsewhere.
///
/// WGS-84 crosses to GCJ-02 exactly once per outgoing coordinate (`origin`,
/// the echoed `destination`), and every incoming `nav.route` coordinate
/// (destination, polyline, steps) is converted back exactly once, in
/// `handleNavRoute` — this is the Task 4 protocol-boundary edge
/// `CoordinateDatum`'s doc comment calls out.
final class RelayNavigationSearch: NavigationRouteSearching {
    private let sendJson: (String) -> Void
    private let timeoutSeconds: Double
    /// Not read by the watchdog itself (`Task.sleep` needs no clock) — kept
    /// for parity with the injectable-clock shape used across this module
    /// (`NavigationController`, `CrashController`) and so a future
    /// deterministic-timeout scheme doesn't need a signature change.
    private let now: () -> TimeInterval

    /// Guards every field below. Production calls into `route`/`reroute`/
    /// `handleNavRoute`/`handleNavError`/`failPending` all arrive from the
    /// main thread (`NavigationController` is `@MainActor`; `AgentSession`
    /// dispatches relay events on main), but the watchdog timeout fires from
    /// a detached `Task` on a background executor, so state mutation must be
    /// race-free — every resume path must be provably the only one that
    /// fires, since a double-resume of a Swift continuation is a crash.
    private let lock = NSLock()
    private var pendingCommandId: String?
    private var pendingContinuation: CheckedContinuation<NavigationRoute?, Never>?
    private var watchdog: Task<Void, Never>?
    /// The most recently resolved route's destination name, remembered so
    /// `reroute(to:from:)` can echo it — the protocol's `reroute` signature
    /// carries only the destination coordinate, not its name.
    private var lastDestinationName: String?

    init(send: @escaping (String) -> Void,
         timeoutSeconds: Double = 7, // under the relay's 8 s device backstop
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.sendJson = send
        self.timeoutSeconds = timeoutSeconds
        self.now = now
    }

    func route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        let commandId = "nav-" + UUID().uuidString
        let gcjOrigin = CoordinateDatum.wgs84ToGcj02(origin)
        let request = buildNavRequest(
            commandId: commandId, reason: "start",
            originLat: gcjOrigin.latitude, originLon: gcjOrigin.longitude,
            query: query, destinationLat: nil, destinationLon: nil, destinationName: nil
        )
        return await awaitAnswer(commandId: commandId, request: request)
    }

    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        let commandId = "nav-" + UUID().uuidString
        let gcjOrigin = CoordinateDatum.wgs84ToGcj02(origin)
        let gcjDestination = CoordinateDatum.wgs84ToGcj02(destination)
        lock.lock()
        let echoedName = lastDestinationName
        lock.unlock()
        let request = buildNavRequest(
            commandId: commandId, reason: "reroute",
            originLat: gcjOrigin.latitude, originLon: gcjOrigin.longitude,
            query: nil, destinationLat: gcjDestination.latitude, destinationLon: gcjDestination.longitude,
            destinationName: echoedName
        )
        return await awaitAnswer(commandId: commandId, request: request)
    }

    /// The relay answered the held request: convert every GCJ-02 coordinate
    /// back to WGS-84 exactly once (destination, every polyline vertex, every
    /// step coordinate) and resume with the assembled route. A commandId that
    /// doesn't match whatever is currently held is a stale/unrelated answer
    /// and is ignored — the real pending request, if any, keeps waiting for
    /// its own answer or its own timeout.
    func handleNavRoute(_ data: NavRouteData) {
        guard let (continuation, watchdogTask) = takePending(matching: data.commandId) else { return }
        watchdogTask?.cancel()
        let route = makeNavigationRoute(
            name: data.destinationName,
            destination: CoordinateDatum.gcj02ToWgs84(data.destination),
            polyline: data.polyline.map(CoordinateDatum.gcj02ToWgs84),
            steps: data.steps.map { step in
                ManeuverStep(
                    instruction: step.instruction,
                    coordinate: CoordinateDatum.gcj02ToWgs84(step.coordinate),
                    alongRouteMeters: step.alongRouteMeters
                )
            },
            totalDistanceMeters: data.distanceMeters,
            totalEtaSeconds: data.etaSeconds
        )
        lock.lock()
        lastDestinationName = data.destinationName
        lock.unlock()
        continuation.resume(returning: route)
    }

    /// The relay could not resolve or route the held request: resume with an
    /// honest `nil` — no fallback of any kind.
    func handleNavError(commandId: String, code: String) {
        guard let (continuation, watchdogTask) = takePending(matching: commandId) else { return }
        watchdogTask?.cancel()
        continuation.resume(returning: nil)
    }

    /// Socket teardown: a dead socket delivers no route, so resolve whatever
    /// is held as an honest failure rather than leaving `perform()` — and the
    /// device slot it holds — suspended forever.
    func failPending() {
        lock.lock()
        let continuation = pendingContinuation
        let watchdogTask = watchdog
        pendingCommandId = nil
        pendingContinuation = nil
        watchdog = nil
        lock.unlock()
        watchdogTask?.cancel()
        continuation?.resume(returning: nil)
    }

    /// Sends `request`, stores it as the single outstanding continuation, and
    /// starts its timeout watchdog. A request already in flight is failed
    /// with nil first — single-outstanding, like the web client's
    /// `pendingCommandId`/`rerouteInFlight` discipline.
    private func awaitAnswer(commandId: String, request: String) async -> NavigationRoute? {
        failPending()
        return await withCheckedContinuation { (continuation: CheckedContinuation<NavigationRoute?, Never>) in
            let watchdogTask = Task.detached { [weak self, timeoutSeconds] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                self?.timeoutIfCurrent(commandId)
            }
            lock.lock()
            pendingCommandId = commandId
            pendingContinuation = continuation
            watchdog = watchdogTask
            lock.unlock()
            sendJson(request)
        }
    }

    private func timeoutIfCurrent(_ commandId: String) {
        guard let (continuation, _) = takePending(matching: commandId) else { return }
        continuation.resume(returning: nil)
    }

    /// Atomically takes the pending continuation + watchdog iff `commandId`
    /// still matches what's held — the single point every resume path (route
    /// answer, error, timeout) goes through, so double-resume is structurally
    /// impossible: only the first caller to match ever gets a non-nil result.
    private func takePending(matching commandId: String) -> (CheckedContinuation<NavigationRoute?, Never>, Task<Void, Never>?)? {
        lock.lock()
        defer { lock.unlock() }
        guard pendingCommandId == commandId, let continuation = pendingContinuation else { return nil }
        let watchdogTask = watchdog
        pendingCommandId = nil
        pendingContinuation = nil
        watchdog = nil
        return (continuation, watchdogTask)
    }
}
