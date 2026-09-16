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
@MainActor
protocol LocationStreaming: AnyObject {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)? { get set }
    var onFailure: ((String) -> Void)? { get set }
    func authorization() -> LocationAuthorization
    func requestAccess() async -> Bool
    func start()
    func stop()
}

extension LocationStreaming {
    var onFailure: ((String) -> Void)? { get { nil } set {} }
}

/// Owns the active route, the location stream, and the reroute/arrival
/// lifecycle. All the hard math is delegated to `GuidanceEngine`; this class is
/// orchestration and speech. Reference type: it holds live navigation state.
@MainActor
final class NavigationController: DeviceActionHandler {
    // Mirrors the web client's REROUTE_COOLDOWN_MS (src/lib/navigation.ts):
    // 20 s from send time. Was 15 s here pre-Task-4 — aligned to match.
    private static let rerouteCooldownSeconds: TimeInterval = 20
    private static let locatingSpoken = "正在定位…"
    private static let noFixDetail = "还没获取到精确位置。请检查 Max 的定位和精确位置权限，并到室外或空旷处重试。"

    private let search: NavigationRouteSearching
    private let stream: LocationStreaming
    private let onGuidance: (GuidanceState?) -> Void
    private let speak: (String) -> Void
    private let sendRelayPrompt: ((String) -> Void)?
    private let interruptPlayback: () -> Void
    private let now: () -> TimeInterval
    private let firstFixTimeoutSeconds: TimeInterval
    private let firstFixAnnounceSeconds: TimeInterval

    private var confirmation: CheckedContinuation<Bool, Never>?
    private var confirmationTimeout: Task<Void, Never>?
    private var awaitingDestinationConfirmation = false
    private var confirmationID: UUID?
    private var locationFailure: String?
    private var latestLocation: CLLocationCoordinate2D?
    private let requiresDestinationConfirmation: Bool
    private let confirmationTimeoutSeconds: TimeInterval
    private var route: NavigationRoute?
    private var progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
    private var rerouting = false
    private var rerouteAttemptId = 0
    private var lastRerouteAt: TimeInterval = -.greatestFiniteMagnitude
    private var firstFixContinuation: CheckedContinuation<CLLocationCoordinate2D?, Never>?
    private var firstFixWatchdog: Task<Void, Never>?
    private var firstFixAnnounce: Task<Void, Never>?
    /// True from the generation bump inside `start(_:)` until that SAME
    /// generation's own terminal exit (first-fix timeout, an unresolved
    /// search, the stale-generation guard, or a successful commit — see
    /// `start(_:)`'s `defer`). A superseded attempt's own exit leaves this
    /// alone: its captured `generation` no longer matches
    /// `navigationGeneration`, so it knows a later attempt already owns it
    /// and already cleared this itself. That "later attempt" is never the
    /// superseded one's own `defer` in that case — it is whichever of the
    /// THREE sites bumps `navigationGeneration` (`start(_:)`'s own next
    /// call, `stopGuidance`, or `attemptReroute`'s failure branch), and
    /// every one of them clears `starting` explicitly alongside its own
    /// bump for exactly that reason: none of them can rely on a stale
    /// attempt's exit to do it on their behalf. `stopGuidance` reads this to
    /// tell "a start is genuinely in flight, with no route committed yet"
    /// apart from "nothing is happening at all" — both otherwise look
    /// identical as `route == nil`.
    private var starting = false
    /// Bumped once per `start(_:)` attempt. Nothing tears down `route`/the
    /// stream on behalf of a stale generation: a concurrent `start()` can
    /// supersede an in-flight first-fix wait, an in-flight search (both share
    /// RelayNavigationSearch's single-outstanding nav.request slot), or an
    /// in-flight reroute — and none of those superseded operations' eventual
    /// answers may still act once a newer generation owns navigation state.
    private var navigationGeneration = 0

    init(
        search: NavigationRouteSearching,
        stream: LocationStreaming,
        onGuidance: @escaping (GuidanceState?) -> Void,
        speak: @escaping (String) -> Void,
        interruptPlayback: @escaping () -> Void,
        now: @escaping () -> TimeInterval,
        firstFixTimeoutSeconds: TimeInterval = 30,
        firstFixAnnounceSeconds: TimeInterval = 1.5,
        sendRelayPrompt: ((String) -> Void)? = nil,
        requiresDestinationConfirmation: Bool = true,
        confirmationTimeoutSeconds: TimeInterval = 60
    ) {
        self.requiresDestinationConfirmation = requiresDestinationConfirmation
        self.confirmationTimeoutSeconds = confirmationTimeoutSeconds
        self.search = search
        self.stream = stream
        self.onGuidance = onGuidance
        self.speak = speak
        self.sendRelayPrompt = sendRelayPrompt
        self.interruptPlayback = interruptPlayback
        self.now = now
        self.firstFixTimeoutSeconds = firstFixTimeoutSeconds
        self.firstFixAnnounceSeconds = firstFixAnnounceSeconds
        self.stream.onFailure = { [weak self] detail in
            Task { @MainActor in
                guard let self else { return }
                self.locationFailure = detail
                self.resolveFirstFix(nil)
                self.search.failPending()
                if let route = self.route {
                    _ = self.relayPrompt(route, kind: "locationLost")
                    self.resolveConfirmation(false)
                    self.route = nil
                    self.stream.stop()
                    self.onGuidance(nil)
                }
            }
        }
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
        // Permission prompts are part of the attempt: stop, teardown, or a
        // newer destination must invalidate it before permission returns.
        if awaitingDestinationConfirmation { route = nil; onGuidance(nil) }
        resolveConfirmation(false)
        awaitingDestinationConfirmation = false
        navigationGeneration += 1
        let generation = navigationGeneration
        starting = true
        latestLocation = nil
        locationFailure = nil
        resolveFirstFix(nil)
        defer { if generation == navigationGeneration { starting = false } }

        switch stream.authorization() {
        case .denied:
            return .denied("permission.location")
        case .notDetermined:
            let granted = await stream.requestAccess()
            guard generation == navigationGeneration else {
                return .failed("navigation.cancelled")
            }
            if !granted { return .denied("permission.location") }
        case .authorized:
            break
        }

        // The first fix must be in hand BEFORE searching: the relay routes
        // FROM the rider's position, so there is no query to send without it.
        guard let origin = await awaitFirstFix(generation: generation) else {
            // Only stop the stream if nothing else is relying on it: a
            // still-active route from an earlier, already-succeeded start
            // (Important #2), or a newer generation that superseded this one
            // and is still in flight (Important #1), must keep it running.
            if generation == navigationGeneration, route == nil { stream.stop() }
            return startFailureResult(generation: generation, detail: locationFailure ?? Self.noFixDetail)
        }
        guard let resolved = await search.route(to: query, from: origin) else {
            if generation == navigationGeneration, route == nil { stream.stop() }
            return startFailureResult(generation: generation)
        }
        guard generation == navigationGeneration else {
            // Superseded while the search was in flight (Important #3's
            // sibling case: a newer start(), not a reroute) — the newer
            // generation now owns `route`/the stream; do not stomp on it.
            return startFailureResult(generation: generation)
        }
        if let locationFailure { return .unsupported("route.unavailable", locationFailure) }
        // Re-assert: a teardown elsewhere (e.g. arrival on the route this
        // request supersedes) may have stopped the stream since the
        // stream.start() call above ran — a route about to commit must
        // never land on a dead stream. Idempotent when it's already running.
        stream.start()
        route = resolved
        progress = GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false)
        // Web/Android parity: a fresh route never inherits whatever this
        // generation superseded's reroute cooldown or in-flight latch.
        rerouting = false
        lastRerouteAt = -.greatestFiniteMagnitude
        latestLocation = latestLocation ?? origin
        if requiresDestinationConfirmation {
            let accepted = await withCheckedContinuation { continuation in
                confirmation = continuation
                awaitingDestinationConfirmation = true
                confirmationID = UUID()
                publish(location: latestLocation ?? origin)
                if !relayPrompt(resolved, kind: "confirm") {
                    speak("请确认目的地：\(resolved.destinationName)。确认后开始导航。")
                }
                confirmationTimeout = Task { @MainActor [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(nanoseconds: UInt64(confirmationTimeoutSeconds * 1_000_000_000)) }
                    catch { return }
                    resolveConfirmation(false)
                }
            }
            guard generation == navigationGeneration else { return .failed("navigation.cancelled") }
            awaitingDestinationConfirmation = false
            if let locationFailure { return .unsupported("route.unavailable", locationFailure) }
            guard accepted else {
                route = nil
                stream.stop()
                onGuidance(nil)
                return .failed("navigation.cancelled")
            }
        }
        publish(location: latestLocation ?? origin)
        // Deliberately silent on success: the relay speaks the confirmation
        // itself (its okSpeech, attached once the real route is known)
        // rather than this client re-announcing a summary it can only
        // partially reconstruct.
        return .ok
    }

    /// A start exit with no route in hand: "route.unavailable" when this
    /// generation is still the current one (a genuine failure — no fix, or
    /// no route, while nothing else touched navigation state in the
    /// meantime), or "navigation.cancelled" when a newer start or an
    /// explicit stop already superseded it while it waited.
    private func startFailureResult(generation: Int, detail: String? = nil) -> DeviceActionResult {
        generation == navigationGeneration
            ? .unsupported("route.unavailable", detail ?? locationFailure)
            : .failed("navigation.cancelled")
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
            stream.start()
            // Spoken once, and only while this same wait is still pending: a
            // fix that lands first cancels this in `resolveFirstFix`, so the
            // rider never hears "locating" after guidance has begun.
            firstFixAnnounce = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(self.firstFixAnnounceSeconds * 1_000_000_000))
                guard generation == self.navigationGeneration,
                      self.firstFixContinuation != nil else { return }
                self.speak(Self.locatingSpoken)
            }
            firstFixWatchdog = Task { @MainActor [weak self] in
                let timeout = self?.firstFixTimeoutSeconds ?? 8
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
        // Cancelled here rather than merely guarded at fire time: a fix landing
        // a moment before the deadline would otherwise queue the announcement
        // behind this resolution on the main actor and speak it anyway.
        firstFixAnnounce?.cancel()
        firstFixAnnounce = nil
        continuation.resume(returning: coordinate)
    }

    private func stopGuidance() -> DeviceActionResult {
        let hadRoute = route != nil
        // No route committed yet AND no start in flight (`starting`) is the
        // only genuine "nothing to stop" case — a start awaiting its first
        // fix or the relay's search is very much something to cancel, even
        // though `route` itself is still nil at that point too.
        guard hadRoute || starting else { return .failed("navigation.notActive") }
        // Teardown invalidates the generation: an explicit stop is a
        // deliberate "cancel everything" — any start or reroute already in
        // flight must never revive navigation once its answer arrives late.
        // `starting` is cleared right here, rather than left for the
        // in-flight start's own exit to clear: that exit only clears it when
        // its OWN generation is still current, which — once superseded by
        // this very bump — it never is again, so leaving it to that alone
        // would strand `starting` true forever.
        resolveConfirmation(false)
        awaitingDestinationConfirmation = false
        navigationGeneration += 1
        starting = false
        // A concurrent start() awaiting its first fix must not hang forever
        // once the bump above invalidates its generation: its own watchdog
        // would see the mismatch and correctly refuse to resolve it (see
        // awaitFirstFix), so the resolve has to happen here instead — a
        // no-op when nothing is currently awaiting a fix.
        resolveFirstFix(nil)
        // Fail whatever the search itself is currently holding — UNCONDITIONALLY,
        // not only in the "no route yet" branch below. iOS can hold a
        // committed route AND an in-flight second start (or reroute) at the
        // same time; a stop in that state must not leave that second
        // request's `nav.request` suspended until the relay's own ~7 s
        // timeout — that would tear down the active route's guidance now
        // and only deliver the superseded request's own "已取消导航。" up to
        // 7 s later, as a stray non-sequitur. A no-op when nothing is held.
        // Safe even when a route IS active: the bump above (plus, in the
        // hadRoute branch below, `route = nil`) makes any in-flight reroute
        // answer this could also resolve fail `attemptReroute`'s guard
        // (generation + route != nil), so this can never trigger the
        // reroute-failure teardown speech.
        search.failPending()
        if hadRoute {
            route = nil
            // Web/Android parity: a stopped route's reroute cooldown and
            // in-flight latch must not survive it — the next fresh route
            // starts clean, same as a successful start-commit.
            rerouting = false
            lastRerouteAt = -.greatestFiniteMagnitude
            stream.stop()
            onGuidance(nil)
            if sendRelayPrompt == nil { speak("已停止导航。") }
        } else {
            // No route yet, but a start was genuinely in flight, and
            // nothing else needs the stream anymore. Silent here: the
            // cancelled start's own device.result (navigation.cancelled) is
            // what the relay's FAILURE_SPEECH map speaks — "已取消导航。" —
            // once it arrives, not this stop's own `.ok`.
            stream.stop()
        }
        return .ok
    }

    /// Session teardown: retire any pending first-fix wait and any active
    /// route silently — no speech, no result — for when the session itself
    /// ends (hands-free `stop()`) and there is no rider-facing turn left to
    /// answer or speak it to. Mirrors Android's `NavigationController.teardown()`:
    /// bumps the generation (so a first-fix wait or search already in flight
    /// can never later commit a route onto a session nothing can still
    /// stop), clears `starting` (a fourth generation-bump site, alongside
    /// `start(_:)`, `stopGuidance`, and `attemptReroute`'s failure branch —
    /// see `starting`'s doc), and resolves any pending first-fix
    /// continuation so `start(_:)` always gets its one `device.result`
    /// (silently dropped by the caller — the socket is already gone)
    /// instead of hanging forever, or — the bug this fixes — its announce
    /// timer firing 正在定位… after nobody is listening.
    ///
    /// Deliberately does NOT call `search.failPending()`: AgentSession calls
    /// that itself, right beside this, exactly as it always has.
    func teardown() {
        resolveConfirmation(false)
        awaitingDestinationConfirmation = false
        navigationGeneration += 1
        starting = false
        resolveFirstFix(nil)
        route = nil
        rerouting = false
        lastRerouteAt = -.greatestFiniteMagnitude
        stream.stop()
        onGuidance(nil)
    }

    func confirmDestination(id: UUID, accepted: Bool) {
        guard confirmationID == id else { return }
        resolveConfirmation(accepted)
    }

    func handleConfirmationReply(_ text: String) {
        guard let id = confirmationID else { return }
        let reply = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if ["确认", "确认导航", "开始导航", "是的", "yes", "confirm", "start navigation"].contains(reply) {
            confirmDestination(id: id, accepted: true)
        } else if ["取消", "取消导航", "不是", "no", "cancel", "cancel navigation"].contains(reply) {
            confirmDestination(id: id, accepted: false)
        }
    }

    private func resolveConfirmation(_ accepted: Bool) {
        let pending = confirmation
        confirmation = nil
        confirmationID = nil
        confirmationTimeout?.cancel()
        confirmationTimeout = nil
        pending?.resume(returning: accepted)
    }

    private func handleFix(_ location: CLLocationCoordinate2D) {
        latestLocation = location
        resolveFirstFix(location)
        if awaitingDestinationConfirmation { publish(location: location); return }
        guard let route else { return }
        let maneuverIndex = progress.maneuverIndex
        let update = GuidanceEngine.step(position: location, route: route, progress: progress)
        progress = update.progress

        if update.arrived {
            if !relayPrompt(route, kind: "arrived") { speak("已到达目的地。") }
        } else if let threshold = update.firedThreshold, let prompt = update.spokenPrompt {
            let alongRoute = route.totalDistanceMeters - update.remainingMeters
            let distance = max(0, route.steps[maneuverIndex].alongRouteMeters - alongRoute)
            if !relayPrompt(route, kind: "maneuver", maneuverIndex: maneuverIndex,
                            threshold: String(describing: threshold), distanceMeters: distance) {
                if threshold == .now { interruptPlayback() }
                speak(prompt)
            }
        }

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
        if update.offRoute && !starting { attemptReroute(from: location, to: route.destinationCoordinate) }
    }

    private func attemptReroute(from origin: CLLocationCoordinate2D, to destination: CLLocationCoordinate2D) {
        guard !rerouting, now() - lastRerouteAt >= Self.rerouteCooldownSeconds else { return }
        rerouting = true
        lastRerouteAt = now()
        let generation = navigationGeneration
        rerouteAttemptId += 1
        let attemptId = rerouteAttemptId
        if let route, !relayPrompt(route, kind: "offRoute") { speak("已偏离路线，正在重新规划。") }
        Task { @MainActor in
            defer { if attemptId == rerouteAttemptId { rerouting = false } }
            let fresh = await search.reroute(to: destination, from: origin)
            // Guarded BEFORE either branch, on TWO conditions:
            //
            // (1) A concurrent start() shares RelayNavigationSearch's single
            // outstanding nav.request slot: `awaitAnswer`'s atomic swap
            // preempts THIS reroute with a nil answer the instant a newer
            // request registers (not a separate failPending() call racing
            // this one). Whichever way this reroute resolves, a stale
            // answer must never touch `route`/the stream once a newer
            // generation owns them — that newer start is either still
            // installing its own route or has already installed one.
            //
            // (2) `route == nil` catches the one case the generation check
            // alone misses: arrival on THIS SAME route, which deliberately
            // does not bump the generation (see handleFix) so an unrelated
            // concurrent start can still land. Without this second check, a
            // reroute launched one tick before arrival would pass the
            // generation-only guard and — on success — restart the stream
            // and reinstall a route the rider was just told had finished
            // ("已到达目的地。"), or — on failure — speak "无法重新规划路线，
            // 已停止导航。" right after it. Either branch is moot once the
            // route it was fixing is gone.
            guard generation == navigationGeneration, route != nil else { return }
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
                // This is the third of the three generation-bump sites
                // (alongside start(_:) and stopGuidance): it must clear
                // `starting` too, exactly like the other two — a start
                // superseded by THIS bump (its generation captured by the
                // reroute this failure resolves) can never clear the latch
                // via its own exit once stale, so leaving it to that alone
                // would strand `starting` true forever, and a later
                // genuinely-idle stop would wrongly answer `.ok`.
                resolveConfirmation(false)
                navigationGeneration += 1
                starting = false
                if let route, !relayPrompt(route, kind: "rerouteFailed") { speak("无法重新规划路线，已停止导航。") }
                route = nil
                rerouting = false
                stream.stop()
                onGuidance(nil)
            }
        }
    }

    /// Relay chooses and speaks trusted route text in MAX's selected voice.
    /// A missing route identity must never fall back to a second voice.
    private func relayPrompt(_ route: NavigationRoute, kind: String, maneuverIndex: Int? = nil,
                             threshold: String? = nil, distanceMeters: Double? = nil) -> Bool {
        guard let sendRelayPrompt else { return false }
        guard let commandId = route.relayCommandId else { return true }
        var payload: [String: Any] = ["type": "nav.prompt", "promptId": UUID().uuidString,
                                      "routeCommandId": commandId, "kind": kind]
        if let maneuverIndex { payload["maneuverIndex"] = maneuverIndex }
        if let threshold { payload["threshold"] = threshold }
        if let distanceMeters { payload["distanceMeters"] = distanceMeters }
        if let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) {
            sendRelayPrompt(json)
        }
        return true
    }

    private func publish(location: CLLocationCoordinate2D?, update: GuidanceUpdate? = nil) {
        guard let route else { return }
        let maneuver = update?.currentInstruction ?? route.steps.first?.instruction
        onGuidance(GuidanceState(
            destinationName: route.destinationName,
            polyline: route.polyline,
            currentLocation: location,
            maneuverInstruction: maneuver,
            distanceToManeuverMeters: update?.distanceToManeuverMeters ?? route.steps.first?.alongRouteMeters ?? route.totalDistanceMeters,
            remainingDistanceMeters: update?.remainingMeters ?? route.totalDistanceMeters,
            remainingSeconds: update?.remainingSeconds ?? route.totalEtaSeconds,
            offRoute: update?.offRoute ?? false,
            confirmationID: confirmationID
        ))
    }
}
