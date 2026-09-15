import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeStream: LocationStreaming, @unchecked Sendable {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    var auth: LocationAuthorization = .authorized
    var granted = true
    var started = false
    /// Delivered synchronously from `start()`, mirroring a location manager
    /// that already has a cached fix ready. Set to nil to simulate a stalled
    /// GPS for the bounded first-fix wait.
    var fixOnStart: CLLocationCoordinate2D? = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
    func authorization() -> LocationAuthorization { auth }
    var holdAccess = false
    var accessWaiters: [CheckedContinuation<Bool, Never>] = []
    func requestAccess() async -> Bool {
        if !holdAccess { return granted }
        return await withCheckedContinuation { accessWaiters.append($0) }
    }
    func resolveAccess() {
        auth = granted ? .authorized : .denied
        let waiters = accessWaiters
        accessWaiters = []
        waiters.forEach { $0.resume(returning: granted) }
    }
    func start() {
        started = true
        if let fixOnStart { onUpdate?(fixOnStart) }
    }
    func stop() { started = false }
    func feed(_ c: CLLocationCoordinate2D) { onUpdate?(c) }
}

private final class FakeSearch: NavigationRouteSearching, @unchecked Sendable {
    var route: NavigationRoute?
    var rerouteResult: NavigationRoute?
    var rerouteCalls = 0
    var routeOrigin: CLLocationCoordinate2D?
    var rerouteOrigin: CLLocationCoordinate2D?
    var rerouteDestination: CLLocationCoordinate2D?

    /// When true, `route(to:from:)` suspends until `resolveHeld(with:)` is
    /// called — mirrors the relay's real async round trip so a test can
    /// assert nothing observable happens before the answer arrives.
    var holdRoute = false
    private var holdContinuation: CheckedContinuation<NavigationRoute?, Never>?

    /// When set, a held `route(to:from:)` races its continuation against
    /// this duration and resolves it to `nil` if nothing else has by
    /// then — mirrors `RelayNavigationSearch`'s real watchdog (the relay's
    /// own ~7 s timeout). Nil (the default) preserves every other test's
    /// existing behavior: a hold with no auto-resolution, settled only by an
    /// explicit `resolveHeld`/`failPending` call. Lets a test prove a stop
    /// resolves a suspended search PROMPTLY via `failPending()`, rather than
    /// merely "eventually" once this fires.
    var searchTimeoutSeconds: TimeInterval?
    private var holdGeneration = 0

    /// Same idea for `reroute(to:from:)`, kept as its own gate (rather than
    /// sharing `holdContinuation`) so a test can hold a reroute open while a
    /// concurrent `route(to:from:)` call completes normally — the real
    /// relay's single-outstanding nav.request slot would fail the reroute
    /// the moment the new request is sent; this lets a test control that
    /// ordering explicitly instead of racing it.
    var holdReroute = false
    private var holdRerouteContinuation: CheckedContinuation<NavigationRoute?, Never>?

    func route(to query: String, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        routeOrigin = origin
        if holdRoute {
            holdGeneration += 1
            let generation = holdGeneration
            if let searchTimeoutSeconds {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(searchTimeoutSeconds * 1_000_000_000))
                    self?.timeoutHeldIfCurrent(generation)
                }
            }
            return await withCheckedContinuation { holdContinuation = $0 }
        }
        return route
    }

    private func timeoutHeldIfCurrent(_ generation: Int) {
        guard generation == holdGeneration, let continuation = holdContinuation else { return }
        holdContinuation = nil
        continuation.resume(returning: nil)
    }

    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        rerouteCalls += 1
        rerouteOrigin = origin
        rerouteDestination = destination
        if holdReroute {
            return await withCheckedContinuation { holdRerouteContinuation = $0 }
        }
        return rerouteResult
    }

    func resolveHeld(with result: NavigationRoute?) {
        holdContinuation?.resume(returning: result)
        holdContinuation = nil
    }

    func detachHeldReroute() -> (NavigationRoute?) -> Void {
        let continuation = holdRerouteContinuation
        holdRerouteContinuation = nil
        return { continuation?.resume(returning: $0) }
    }

    func resolveHeldReroute(with result: NavigationRoute?) {
        holdRerouteContinuation?.resume(returning: result)
        holdRerouteContinuation = nil
    }

    /// Mirrors `RelayNavigationSearch.failPending()`: resolves whatever is
    /// currently held (route or reroute — production has a single shared
    /// slot; this fake keeps them separate purely for test control, see the
    /// doc comments above, so failing "the pending request" means failing
    /// whichever of the two is actually outstanding) with an honest nil.
    func failPending() {
        holdContinuation?.resume(returning: nil)
        holdContinuation = nil
        holdRerouteContinuation?.resume(returning: nil)
        holdRerouteContinuation = nil
    }
}

/// A mutable clock a test can advance explicitly, so a cooldown-window
/// assertion doesn't depend on real wall-clock time passing during the test.
private final class FakeClock: @unchecked Sendable {
    var value: TimeInterval = 0
}

@MainActor
final class NavigationControllerTests: XCTestCase {

    private func straightRoute() -> NavigationRoute {
        let dest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点", destinationCoordinate: dest,
            polyline: [CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40), dest],
            steps: [ManeuverStep(instruction: "到达终点", coordinate: dest, alongRouteMeters: 2000)],
            totalDistanceMeters: 2000, totalEtaSeconds: 400
        )
    }

    // A route with an intermediate turn, so a "now" fix near it is well clear
    // of the arrival radius — isolates the interrupt-identity assertion below
    // from arrival's own (separate) speech.
    private func routeWithTurn() -> NavigationRoute {
        let turn = CLLocationCoordinate2D(latitude: 39.9090, longitude: 116.40)
        let dest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点", destinationCoordinate: dest,
            polyline: [CLLocationCoordinate2D(latitude: 39.9000, longitude: 116.40), turn, dest],
            steps: [
                ManeuverStep(instruction: "右转", coordinate: turn, alongRouteMeters: 1000),
                ManeuverStep(instruction: "到达终点", coordinate: dest, alongRouteMeters: 2000)
            ],
            totalDistanceMeters: 2000, totalEtaSeconds: 400
        )
    }

    final class Box { var guidance: GuidanceState?; var spoken: [String] = []; var interrupts = 0; var prompts: [String] = [] }

    private func make(
        _ stream: FakeStream, _ search: FakeSearch,
        clock: @escaping () -> TimeInterval = { 0 },
        firstFixTimeoutSeconds: TimeInterval = 3,
        firstFixAnnounceSeconds: TimeInterval = 1.5,
        relaySpeech: Bool = false
    ) -> (NavigationController, Box) {
        let box = Box()
        let controller = NavigationController(
            search: search, stream: stream,
            onGuidance: { box.guidance = $0 },
            speak: { box.spoken.append($0) },
            interruptPlayback: { box.interrupts += 1 },
            now: clock,
            firstFixTimeoutSeconds: firstFixTimeoutSeconds,
            firstFixAnnounceSeconds: firstFixAnnounceSeconds,
            sendRelayPrompt: relaySpeech ? { box.prompts.append($0) } : nil
        )
        return (controller, box)
    }

    func testStopDuringPermissionPromptCannotStartNavigationAfterGrant() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.auth = .notDetermined
        stream.holdAccess = true
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        let start = Task { await controller.perform(.navigationStart(query: "终点")) }
        while stream.accessWaiters.isEmpty { await Task.yield() }
        let stopped = await controller.perform(.navigationStop)
        stream.resolveAccess()
        let result = await start.value
        XCTAssertEqual(stopped, .ok)
        XCTAssertEqual(result, .failed("navigation.cancelled"))
        XCTAssertFalse(stream.started)
        XCTAssertNil(search.routeOrigin)
        XCTAssertNil(box.guidance)
    }

    func testTeardownDuringPermissionPromptCannotReviveNavigation() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.auth = .notDetermined
        stream.holdAccess = true
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        let start = Task { await controller.perform(.navigationStart(query: "终点")) }
        while stream.accessWaiters.isEmpty { await Task.yield() }
        controller.teardown()
        stream.resolveAccess()
        let result = await start.value
        XCTAssertEqual(result, .failed("navigation.cancelled"))
        XCTAssertFalse(stream.started)
        XCTAssertNil(box.guidance)
    }

    func testOldRerouteCompletionCannotUnlockNewReroute() async throws {
        let stream = FakeStream(), search = FakeSearch(), clock = FakeClock()
        search.route = straightRoute()
        search.holdReroute = true
        let (controller, _) = make(stream, search, clock: { clock.value })
        _ = await controller.perform(.navigationStart(query: "first"))
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)
        let finishOld = search.detachHeldReroute()
        _ = await controller.perform(.navigationStart(query: "second"))
        stream.feed(off)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 2)
        finishOld(nil)
        try await Task.sleep(nanoseconds: 50_000_000)
        clock.value = 30
        stream.feed(off)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 2, "the new reroute remains in flight even after cooldown")
        search.resolveHeldReroute(with: straightRoute())
        try await Task.sleep(nanoseconds: 50_000_000)
        _ = await controller.perform(.navigationStop)
    }

    func testConnectedNavigationUsesRelayVoiceAndSilentStop() async throws {
        let stream = FakeStream(), search = FakeSearch()
        var route = routeWithTurn()
        route.relayCommandId = "relay-route"
        search.route = route
        let (controller, box) = make(stream, search, relaySpeech: true)
        let result = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(result, .ok)
        stream.feed(CLLocationCoordinate2D(latitude: 39.9088, longitude: 116.40))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(box.prompts.count, 1)
        let prompt = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(box.prompts.first).utf8)) as? [String: Any])
        XCTAssertEqual(prompt["routeCommandId"] as? String, "relay-route")
        XCTAssertEqual(prompt["kind"] as? String, "maneuver")
        XCTAssertEqual(prompt["maneuverIndex"] as? Int, 0)
        XCTAssertEqual(prompt["threshold"] as? String, "now")
        XCTAssertNil(prompt["text"])
        _ = await controller.perform(.navigationStop)
        XCTAssertTrue(box.spoken.isEmpty)
        XCTAssertEqual(box.interrupts, 0)
    }

    func testConnectedArrivalDoesNotAlsoSpeakTurn() async throws {
        let stream = FakeStream(), search = FakeSearch()
        var route = straightRoute()
        route.relayCommandId = "relay-route"
        search.route = route
        let (controller, box) = make(stream, search, relaySpeech: true)
        _ = await controller.perform(.navigationStart(query: "终点"))
        stream.feed(route.destinationCoordinate)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(box.prompts.count, 1)
        let prompt = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(box.prompts.first).utf8)) as? [String: Any])
        XCTAssertEqual(prompt["kind"] as? String, "arrived")
        XCTAssertTrue(box.spoken.isEmpty)
    }

    // A fix that is merely slow must not sound like a routing failure: the
    // rider hears 正在定位…, the search still runs, and navigation starts.
    func testSlowFixAnnouncesLocatingAndStillStarts() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        search.route = straightRoute()
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 8,
            firstFixAnnounceSeconds: 0.05
        )

        async let result = controller.perform(.navigationStart(query: "外滩"))
        try? await Task.sleep(nanoseconds: 150_000_000)
        stream.feed(CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40))

        let outcome = await result
        XCTAssertEqual(outcome, .ok)
        XCTAssertEqual(box.spoken, ["正在定位…"])
        XCTAssertNotNil(box.guidance)
    }

    // The common case must stay silent: a fix already in hand means the rider
    // hears only the relay's own start summary.
    func testPromptFixNeverAnnouncesLocating() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search, firstFixAnnounceSeconds: 0.05)

        let result = await controller.perform(.navigationStart(query: "外滩"))

        XCTAssertEqual(result, .ok)
        XCTAssertFalse(box.spoken.contains("正在定位…"))
    }

    // No fix at all: the failure must name the cause instead of blaming route
    // planning, which is what shipped.
    func testNoFixFailsWithLocationDetailRatherThanRouteFailure() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 0.1,
            firstFixAnnounceSeconds: 0.05
        )

        let result = await controller.perform(.navigationStart(query: "外滩"))

        XCTAssertEqual(
            result,
            .unsupported("route.unavailable", "还没定位到，到室外或空旷处再说一次。")
        )
        XCTAssertEqual(box.spoken, ["正在定位…"])
    }

    // A relay that answers with no route is a different failure and must keep
    // its own speech: the fix arrived, so the location copy would be a lie.
    func testSearchFailureKeepsTheRoutePlanningSpeech() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = nil
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "外滩"))

        XCTAssertEqual(result, .unsupported("route.unavailable", nil))
    }

    // An explicit stop while the fix is still pending must cancel the pending
    // announcement, not let it arrive afterwards as a non-sequitur.
    func testStopBeforeTheFixSuppressesTheAnnouncement() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 8,
            firstFixAnnounceSeconds: 0.1
        )

        async let result = controller.perform(.navigationStart(query: "外滩"))
        try? await Task.sleep(nanoseconds: 20_000_000)
        _ = await controller.perform(.navigationStop)
        try? await Task.sleep(nanoseconds: 200_000_000)

        _ = await result
        XCTAssertFalse(box.spoken.contains("正在定位…"))
    }

    func testStartResolvesAndStreamsWithoutSpeakingLocally() async {
        // The relay speaks the start confirmation itself, as an agent
        // transcript (via okSpeech) — the controller must stay silent on a
        // successful commit rather than double-announcing it.
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result, .ok)
        XCTAssertTrue(stream.started)
        XCTAssertNotNil(box.guidance)
        XCTAssertTrue(box.spoken.isEmpty, "no local opening summary — the relay's okSpeech covers it")
    }

    func testStartPassesTheFirstFixAsOrigin() async {
        let stream = FakeStream()
        let origin = CLLocationCoordinate2D(latitude: 39.87, longitude: 116.33)
        stream.fixOnStart = origin
        let search = FakeSearch()
        search.route = straightRoute()
        let (controller, _) = make(stream, search)

        _ = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertNotNil(search.routeOrigin)
        if let routeOrigin = search.routeOrigin {
            XCTAssertTrue(coordinatesEqual(routeOrigin, origin))
        }
    }

    func testStartHoldsUntilSearchResolves() async {
        // Mirrors the web client's "requests, then acks ok only after
        // nav.route arrives" — nothing observable happens while suspended.
        let stream = FakeStream(), search = FakeSearch()
        search.holdRoute = true
        let (controller, box) = make(stream, search)

        let task = Task { await controller.perform(.navigationStart(query: "终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(box.guidance, "no guidance is published until the search resolves")

        search.resolveHeld(with: straightRoute())
        let result = await task.value

        XCTAssertEqual(result, .ok)
        XCTAssertNotNil(box.guidance)
    }

    // fix round 1 (review findings Important #1/#2/#3): concurrent starts,
    // an active route surviving a failed re-start, and a superseding start
    // surviving a stale in-flight reroute's failure branch. These interact —
    // see NavigationController's `navigationGeneration` and the fix-round-1
    // section of the task-4 report for the full rationale.

    func testConcurrentStartsEachYieldExactlyOneResultWithoutLeakOrSpuriousFailure() async {
        executionTimeAllowance = 5 // guards against a regression reintroducing the leaked-continuation hang
        let stream = FakeStream()
        stream.fixOnStart = nil // fix delivery is controlled manually below
        let search = FakeSearch()
        search.route = straightRoute()
        // Long enough that neither request's own watchdog reaches its
        // natural deadline during this test — the assertions below exercise
        // the explicit supersede-and-cancel path (a concurrent start()
        // resolving the stale one immediately), not a race against a timeout.
        let (controller, box) = make(stream, search, firstFixTimeoutSeconds: 5)

        let firstTask = Task { await controller.perform(.navigationStart(query: "第一个")) }
        try? await Task.sleep(nanoseconds: 20_000_000) // let the first reach its first-fix wait

        let secondTask = Task { await controller.perform(.navigationStart(query: "第二个")) }
        try? await Task.sleep(nanoseconds: 20_000_000) // let the second supersede the first

        // The superseded first request must resolve promptly on its own —
        // proves its continuation was never leaked (which would otherwise
        // hang perform() forever, holding the device slot, and log a
        // "SWIFT TASK CONTINUATION MISUSE" leak).
        let firstResult = await firstTask.value
        XCTAssertEqual(firstResult.status, .failed)
        XCTAssertEqual(firstResult.reason, "navigation.cancelled", "superseded by a newer start, not a genuine route failure")

        // Deliver the real fix — it must satisfy the SECOND (current)
        // request. The superseded first request's watchdog was cancelled the
        // instant the second one began (awaitFirstFix's resolveFirstFix(nil)
        // call), so it cannot still be "authoritative" here.
        stream.feed(CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40))

        let secondResult = await secondTask.value
        XCTAssertEqual(secondResult, .ok, "the current request gets the real fix, not a spurious failure")
        XCTAssertNotNil(box.guidance)
        XCTAssertTrue(stream.started, "the superseded request's own failure cleanup must not have stopped it")
    }

    func testFailedRestartWhileNavigatingLeavesActiveRouteRunning() async {
        let stream = FakeStream(), search = FakeSearch()
        let activeRoute = straightRoute()
        search.route = activeRoute
        let (controller, box) = make(stream, search)

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)
        XCTAssertTrue(stream.started)

        // A second, unrelated destination fails to resolve while already navigating.
        search.route = nil
        let second = await controller.perform(.navigationStart(query: "无法到达的地方"))

        XCTAssertEqual(second.status, .unsupported)
        XCTAssertEqual(second.reason, "route.unavailable")
        XCTAssertTrue(stream.started, "the active route's stream must keep running")
        XCTAssertNotNil(box.guidance)
        XCTAssertEqual(box.guidance?.destinationName, activeRoute.destinationName, "the original route is still active")

        // Prove guidance is genuinely live, not merely that `started` wasn't
        // flipped: a fresh fix on the original route still produces arrival.
        stream.feed(CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)) // at destination
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(box.spoken.contains { $0.contains("到达") }, "guidance is still processing fixes on the original route")
    }

    func testSupersedingStartSurvivesAStaleRerouteFailure() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search, clock: { 0 })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        // Drift off-route to kick off a reroute, held so the test controls
        // exactly when it resolves — like the relay's real single-outstanding
        // nav.request slot, which a concurrent start() would fail.
        search.holdReroute = true
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)

        // A brand-new start supersedes it and succeeds while the reroute is
        // still held.
        let newRoute = NavigationRoute(
            destinationName: "新终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45),
            polyline: [
                CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
                CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45)
            ],
            steps: [ManeuverStep(
                instruction: "到达新终点",
                coordinate: CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45),
                alongRouteMeters: 3000
            )],
            totalDistanceMeters: 3000, totalEtaSeconds: 500
        )
        search.route = newRoute
        let second = await controller.perform(.navigationStart(query: "新终点"))
        XCTAssertEqual(second, .ok)
        XCTAssertEqual(box.guidance?.destinationName, "新终点")

        // NOW the stale reroute's failure answer arrives — it must be
        // discarded entirely: the fresh route and its stream must survive.
        search.resolveHeldReroute(with: nil)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(stream.started, "the fresh start's stream must keep running")
        XCTAssertNotNil(box.guidance)
        XCTAssertEqual(box.guidance?.destinationName, "新终点", "the stale reroute must not tear down the new navigation")
        XCTAssertFalse(box.spoken.contains { $0.contains("无法重新规划路线") }, "the stale reroute's failure speech must be suppressed")
    }

    // Nav-parity-closure Task 3: a reroute in flight when arrival lands must
    // never revive navigation once its (stale, but not generation-stale —
    // arrival deliberately does not bump the generation) answer arrives.

    func testPostArrivalRerouteSuccessDoesNotRevive() async {
        let stream = FakeStream(), search = FakeSearch()
        let route = straightRoute()
        search.route = route
        let (controller, box) = make(stream, search, clock: { 0 })
        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        search.holdReroute = true
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)

        // Arrival lands while the reroute is still held.
        stream.feed(route.destinationCoordinate)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(stream.started, "arrival stopped the stream")
        XCTAssertNil(box.guidance)
        XCTAssertTrue(box.spoken.contains { $0.contains("到达") })

        // The stale reroute now succeeds — confirmed post-arrival revival
        // must not happen: no stream restart, no card state.
        search.resolveHeldReroute(with: route)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(stream.started, "a reroute answer after arrival must not restart the stream")
        XCTAssertNil(box.guidance, "a reroute answer after arrival must not reinstall a card")
    }

    func testPostArrivalRerouteFailureDoesNotSpeak() async {
        let stream = FakeStream(), search = FakeSearch()
        let route = straightRoute()
        search.route = route
        let (controller, box) = make(stream, search, clock: { 0 })
        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        search.holdReroute = true
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)

        stream.feed(route.destinationCoordinate)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(stream.started, "arrival stopped the stream")

        // The stale reroute now fails — the spurious "无法重新规划路线，已停止
        // 导航。" line must never be heard after arrival already announced
        // "已到达目的地。".
        search.resolveHeldReroute(with: nil)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(box.spoken.contains { $0.contains("无法重新规划路线") }, "the spurious reroute-failure line must be suppressed after arrival")
        XCTAssertFalse(stream.started, "the stale failure must not touch the stream again")
    }

    func testFreshStartAfterRerouteDoesNotInheritCooldown() async {
        let stream = FakeStream(), search = FakeSearch()
        let clock = FakeClock()
        search.route = straightRoute()
        search.rerouteResult = straightRoute()
        let (controller, _) = make(stream, search, clock: { clock.value })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1, "the first off-route fix reroutes immediately (no prior cooldown)")

        // A brand-new start for a different destination, well inside what
        // would have been the previous route's 20 s cooldown window.
        clock.value = 5
        search.route = straightRoute()
        let second = await controller.perform(.navigationStart(query: "新的目的地"))
        XCTAssertEqual(second, .ok)
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Drifting off THIS fresh route must reroute immediately — it must
        // not inherit the superseded route's cooldown stamp.
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 2, "a fresh route's own off-route drift must not be blocked by the old route's cooldown")
    }

    // Final-review fix wave: a route committed after a teardown must never
    // land on a stopped stream, and nothing must ever revive navigation
    // after an explicit 停止导航. See the "Final-review fix wave" section of
    // the task-4 report for the chosen arrival-vs-stop asymmetry and why.

    func testStartCommittedAfterArrivalTeardownReassertsTheStream() async {
        let stream = FakeStream(), search = FakeSearch()
        let routeA = straightRoute()
        search.route = routeA
        let (controller, box) = make(stream, search, clock: { 0 })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        // Rider asks for a new, unrelated destination B while still
        // approaching A. Hold B's search so an arrival on A can land while
        // B is still in flight.
        search.holdRoute = true
        let routeB = NavigationRoute(
            destinationName: "新终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45),
            polyline: [
                CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
                CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45)
            ],
            steps: [ManeuverStep(
                instruction: "到达新终点",
                coordinate: CLLocationCoordinate2D(latitude: 39.95, longitude: 116.45),
                alongRouteMeters: 3000
            )],
            totalDistanceMeters: 3000, totalEtaSeconds: 500
        )
        let secondTask = Task { await controller.perform(.navigationStart(query: "新终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it reach the held search

        // A fix arrives within A's arrival radius — arrival tears the stream
        // down while B's request is still in flight.
        stream.feed(routeA.destinationCoordinate)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(stream.started, "arrival on A stopped the stream")
        XCTAssertNil(box.guidance)

        // B's search now resolves — a fresh, independent request must still
        // commit, on a live stream, rather than being silently discarded.
        search.resolveHeld(with: routeB)
        let second = await secondTask.value

        XCTAssertEqual(second, .ok, "arrival on the OLD route must not discard the still-valid new request")
        XCTAssertTrue(stream.started, "committing the new route re-asserts the stream")
        XCTAssertEqual(box.guidance?.destinationName, "新终点")
    }

    func testStopDuringHeldSearchDiscardsTheStaleInstall() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search, clock: { 0 })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        search.holdRoute = true
        let secondTask = Task { await controller.perform(.navigationStart(query: "新终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it reach the held search

        let stopResult = await controller.perform(.navigationStop)
        XCTAssertEqual(stopResult, .ok)
        XCTAssertFalse(stream.started)
        XCTAssertNil(box.guidance)

        // The stale answer arrives after the explicit stop — it must never
        // revive navigation, on a live stream or otherwise.
        search.resolveHeld(with: straightRoute())
        let second = await secondTask.value

        XCTAssertEqual(second.status, .failed)
        XCTAssertEqual(second.reason, "navigation.cancelled", "the explicit stop superseded it, not a genuine route failure")
        XCTAssertFalse(stream.started, "the stale install must not restart the stream")
        XCTAssertNil(box.guidance, "the stale install must not revive guidance")

        // The stop above already cleared `starting` alongside its own
        // generation bump — a genuinely idle stop right after must not find
        // it stuck true.
        let idleStop = await controller.perform(.navigationStop)
        XCTAssertEqual(idleStop.reason, "navigation.notActive", "the cancelled start must not leave `starting` stuck true")
    }

    func testStaleRerouteFailureBumpClearsTheStartingLatch() async {
        // Fix-round-1 Important #1: the reroute-failure branch is a THIRD
        // generation-bump site (alongside start(_:) and stopGuidance) and
        // must clear `starting` too — otherwise a start superseded by a
        // reroute failure (rather than by a newer start or an explicit
        // stop) strands the latch true forever, and a later genuinely-idle
        // stop wrongly answers `.ok` instead of `navigation.notActive`.
        let stream = FakeStream(), search = FakeSearch()
        let routeA = straightRoute()
        search.route = routeA
        let (controller, box) = make(stream, search, clock: { 0 })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        // A second start supersedes generation-wise but is held mid-search
        // — its OWN eventual exit will correctly decline to clear
        // `starting` once stale, so nothing but the reroute-failure bump
        // below can clear it.
        search.holdRoute = true
        let secondTask = Task { await controller.perform(.navigationStart(query: "新终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it reach the held search

        // A drifts off-route: the reroute captures the CURRENT generation
        // (the second start's, since it already bumped it), then fails.
        search.rerouteResult = nil
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)
        XCTAssertFalse(stream.started, "the reroute failure tore down route A")
        XCTAssertNil(box.guidance)

        // Nothing is genuinely actionable now: route is nil, and the
        // superseded second start can never land (its generation is
        // permanently stale). An explicit stop here must report
        // notActive, not silently succeed because `starting` was left
        // stuck true by the reroute-failure bump.
        let idleStop = await controller.perform(.navigationStop)
        XCTAssertEqual(idleStop.status, .failed)
        XCTAssertEqual(idleStop.reason, "navigation.notActive", "the reroute-failure bump must clear `starting` too")

        // Let the superseded second start resolve so its continuation isn't
        // leaked past the test.
        search.resolveHeld(with: nil)
        _ = await secondTask.value
    }

    func testStopWhileAwaitingFirstFixForANewStartResolvesImmediately() async {
        executionTimeAllowance = 5 // safety net, not the actual bound this test proves
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        // Deliberately short relative to the 1 s assertion below: if `stop`
        // didn't resolve the pending first-fix wait directly, this test
        // would only pass by accident, after waiting out the 2 s watchdog —
        // the timing assertion distinguishes "resolved immediately by the
        // stop" from "resolved eventually by its own watchdog" (which would
        // otherwise see the generation the stop just bumped and correctly
        // refuse to resolve it, since a stale request must not revive
        // anything — but must still resolve promptly, not hang).
        let (controller, _) = make(stream, search, clock: { 0 }, firstFixTimeoutSeconds: 2)

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        // A second start is awaiting its OWN first fix — not yet even at the
        // search stage — when the rider stops navigation outright.
        stream.fixOnStart = nil
        let secondTask = Task { await controller.perform(.navigationStart(query: "新终点")) }
        try? await Task.sleep(nanoseconds: 20_000_000)

        let stopResult = await controller.perform(.navigationStop)
        XCTAssertEqual(stopResult, .ok)

        let resolvedFrom = Date()
        let second = await secondTask.value
        XCTAssertLessThan(
            Date().timeIntervalSince(resolvedFrom), 1.0,
            "stop must resolve the pending first-fix wait immediately, not via its own 2 s watchdog"
        )
        XCTAssertEqual(second.status, .failed)
        XCTAssertEqual(second.reason, "navigation.cancelled", "the explicit stop superseded it, not a genuine route failure")
    }

    // Nav-parity-closure Task 3: stop-cancels. No route has committed yet
    // (unlike the tests above, nothing is navigating at all), but a start is
    // genuinely in flight — web's `cancelHeldStart` semantics: the stop
    // itself succeeds, and the cancelled start gets its own truthful result
    // rather than hanging until a timeout.

    func testStopMidFirstFixCancelsTheInFlightStart() async {
        executionTimeAllowance = 5 // safety net; the assertions below prove it resolves promptly, not via a timeout
        let stream = FakeStream()
        stream.fixOnStart = nil // GPS never reports a fix — stays parked awaiting one
        let search = FakeSearch()
        let (controller, box) = make(stream, search, firstFixTimeoutSeconds: 5)

        let startTask = Task { await controller.perform(.navigationStart(query: "终点")) }
        try? await Task.sleep(nanoseconds: 20_000_000) // let it reach the first-fix wait

        let stopResult = await controller.perform(.navigationStop)
        XCTAssertEqual(stopResult, .ok)

        let startResult = await startTask.value
        XCTAssertEqual(startResult.status, .failed)
        XCTAssertEqual(startResult.reason, "navigation.cancelled")
        XCTAssertNil(box.guidance, "nothing installs")
        XCTAssertFalse(stream.started, "the stream is stopped")
    }

    func testStopMidRelayAwaitCancelsTheInFlightStart() async {
        executionTimeAllowance = 5 // safety net; without failPending() wired through, this would hang until FakeSearch's continuation leaks
        let stream = FakeStream(), search = FakeSearch()
        search.holdRoute = true // the relay never answers on its own — only the stop's failPending() resolves it
        let (controller, box) = make(stream, search)

        let startTask = Task { await controller.perform(.navigationStart(query: "终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it reach the held search

        let stopResult = await controller.perform(.navigationStop)
        XCTAssertEqual(stopResult, .ok)

        let startResult = await startTask.value
        XCTAssertEqual(startResult.status, .failed)
        XCTAssertEqual(startResult.reason, "navigation.cancelled")
        XCTAssertNil(box.guidance, "nothing installs")
        XCTAssertFalse(stream.started, "the stream is stopped")
    }

    // Nav-fast-follow Task 3: the parity-review hoist. iOS can hold a
    // committed route AND an in-flight second start at once — the case
    // above (`testStopMidRelayAwaitCancelsTheInFlightStart`) only covers the
    // "no route yet" branch, which already called `search.failPending()`
    // pre-hoist. This is the ROUTE-ACTIVE branch: a stop there must fail the
    // second start's held search too, not just tear down the active route —
    // otherwise the rider hears "已停止导航。" and then, up to the relay's
    // own ~7 s timeout later, the superseded start's own "已取消导航。"
    // arrives as a stray non-sequitur.
    func testStopWithActiveRouteFailsTheInFlightSecondStartsPendingSearchPromptly() async {
        executionTimeAllowance = 6 // safety net: draining B in the RED case rides out the fake relay's own 5 s watchdog
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute() // route A resolves immediately and becomes the committed, active route
        // Generous relative to the bounded check below (mirrors
        // RelayNavigationSearch's real ~7 s watchdog): pre-hoist, B is only
        // resolved by THIS firing, ~5 s away — the bounded check below must
        // catch it still pending long before that, not ride it out.
        search.searchTimeoutSeconds = 5
        let (controller, box) = make(stream, search, clock: { 0 })

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)

        // A second start for a NEW destination is suspended at the relay
        // await while route A is still active — mirrors the ledgered
        // scenario exactly (a committed route AND an in-flight second start
        // coexisting).
        search.holdRoute = true
        final class ResultBox: @unchecked Sendable { var result: DeviceActionResult? }
        let secondResult = ResultBox()
        let secondTask = Task { secondResult.result = await controller.perform(.navigationStart(query: "新终点")) }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it reach the held search

        let stopResult = await controller.perform(.navigationStop)
        XCTAssertEqual(stopResult, .ok)
        XCTAssertTrue(box.spoken.contains("已停止导航。"), "the active route's own stop confirmation still fires")

        // The bounded-wait assertion: B must already have resolved well
        // under the search's own (generous) timeout — this is what fails
        // RED promptly (B still pending here) rather than as a hang.
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNotNil(secondResult.result, "the stop must fail B's pending search directly, not leave it to the search's own timeout")
        if let result = secondResult.result {
            XCTAssertEqual(result.status, .failed)
            XCTAssertEqual(result.reason, "navigation.cancelled", "the explicit stop superseded it, not a genuine route failure")
        }

        // Safety premise: the stop's generation bump (plus route == nil)
        // makes this stale answer fail the reroute guard, so failing it
        // early can never trigger reroute-teardown speech.
        XCTAssertFalse(box.spoken.contains { $0.contains("无法重新规划路线") }, "no reroute-teardown speech from the failed pending search")

        _ = await secondTask.value // drain for cleanup regardless of RED/GREEN timing
    }

    func testRerouteSuccessReassertsTheStream() async {
        let stream = FakeStream(), search = FakeSearch()
        let route = straightRoute()
        search.route = route
        let (controller, box) = make(stream, search, clock: { 0 })
        _ = await controller.perform(.navigationStart(query: "终点"))

        search.holdReroute = true
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(search.rerouteCalls, 1)

        // Simulate the stream having stopped for any reason (e.g. an
        // arrival teardown on this same route) while the reroute was
        // in flight.
        stream.stop()
        XCTAssertFalse(stream.started)

        search.resolveHeldReroute(with: route)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(stream.started, "committing a rerouted route re-asserts the stream")
        XCTAssertNotNil(box.guidance)
    }

    func testStartWithNoFixWithinBoundReportsRouteUnavailable() async {
        let stream = FakeStream()
        stream.fixOnStart = nil // GPS never reports a fix
        let search = FakeSearch()
        search.route = straightRoute()
        let (controller, _) = make(stream, search, firstFixTimeoutSeconds: 0.05)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "route.unavailable")
        XCTAssertFalse(stream.started, "the stream is stopped after giving up on a fix")
        XCTAssertNil(search.routeOrigin, "search is never invoked without an origin fix")
    }

    func testStartReportsUnresolvableRoute() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = nil
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "火星"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "route.unavailable")
        XCTAssertFalse(stream.started)
    }

    func testStartReportsDeniedLocation() async {
        let stream = FakeStream(); stream.auth = .denied
        let search = FakeSearch(); search.route = straightRoute()
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.location")
    }

    func testStopClearsGuidance() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        _ = await controller.perform(.navigationStart(query: "终点"))

        let result = await controller.perform(.navigationStop)

        XCTAssertEqual(result, .ok)
        XCTAssertFalse(stream.started)
        XCTAssertNil(box.guidance)
    }

    func testStopWhileIdleIsBenign() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.navigationStop)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "navigation.notActive")
    }

    func testOffRouteTriggersExactlyOneDebouncedReroute() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        search.rerouteResult = straightRoute()
        let (controller, _) = make(stream, search, clock: { 0 })
        _ = await controller.perform(.navigationStart(query: "终点"))

        // Two off-route fixes within the cooldown → one reroute.
        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020) // ~170 m east
        stream.feed(off)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(search.rerouteCalls, 1)
    }

    func testRerouteEchoesTheActiveRouteDestination() async {
        let stream = FakeStream(), search = FakeSearch()
        let route = straightRoute()
        search.route = route
        search.rerouteResult = route
        let (controller, _) = make(stream, search, clock: { 0 })
        _ = await controller.perform(.navigationStart(query: "终点"))

        let off = CLLocationCoordinate2D(latitude: 39.9060, longitude: 116.4020)
        stream.feed(off)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(search.rerouteCalls, 1)
        XCTAssertNotNil(search.rerouteDestination)
        if let rerouteDestination = search.rerouteDestination {
            XCTAssertTrue(coordinatesEqual(rerouteDestination, route.destinationCoordinate))
        }
    }

    func testArrivalEndsGuidance() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)
        _ = await controller.perform(.navigationStart(query: "终点"))

        stream.feed(CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)) // at destination
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(stream.started, "arrival stops the stream")
        XCTAssertTrue(box.spoken.contains { $0.contains("到达") })
    }

    func testNowThresholdInterruptsPlaybackByIdentityNotText() async {
        // The TS-ported "now" template is the bare instruction — no "现在"
        // substring left to grep for — so the interrupt must key on the
        // engine's `firedThreshold` identity, not on the spoken text.
        let stream = FakeStream(), search = FakeSearch()
        search.route = routeWithTurn()
        let (controller, box) = make(stream, search)
        _ = await controller.perform(.navigationStart(query: "终点"))

        // ~22 m short of the turn: within the 40 m "now" band, well clear of
        // the 30 m arrival radius to the (much farther away) destination.
        let nearTurn = CLLocationCoordinate2D(latitude: 39.9090 - 22.0 / 111_000, longitude: 116.40)
        stream.feed(nearTurn)
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(box.interrupts, 1)
        XCTAssertEqual(box.spoken.last, "右转")
        XCTAssertFalse(box.spoken.last?.contains("现在") ?? true)
    }

    // Final whole-branch review, Important #1: nothing tore down an
    // in-flight first-fix wait when the SESSION itself ends (as opposed to
    // an explicit 停止导航), so the announce timer could still fire 正在
    // 定位… — or the watchdog still fail route.unavailable — into a session
    // nobody is listening to. `teardown()` is AgentSession's answer to
    // "the session ends" from the spec's Suppression list; these two tests
    // exercise it directly, the way `testStopBeforeTheFixSuppressesTheAnnouncement`
    // and `testStopMidFirstFixCancelsTheInFlightStart` already do for stop().

    func testTeardownBeforeTheFixSuppressesTheAnnouncementAndResolvesTheStart() async {
        executionTimeAllowance = 5
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil // GPS never reports a fix — stays parked awaiting one
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 8,
            firstFixAnnounceSeconds: 0.1
        )

        let startTask = Task { await controller.perform(.navigationStart(query: "外滩")) }
        try? await Task.sleep(nanoseconds: 20_000_000) // let it reach the first-fix wait

        controller.teardown()

        let result = await startTask.value
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "navigation.cancelled", "the session ending superseded it, not a genuine route failure")

        // Prove the announce timer was actually cancelled, not merely raced:
        // wait past its 0.1 s fire time and confirm it never spoke.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(box.spoken.contains("正在定位…"), "teardown must suppress the interim line, same as an explicit stop")
        XCTAssertFalse(stream.started, "the stream is stopped")
        XCTAssertNil(box.guidance)
    }

    func testTeardownWithActiveRouteEndsGuidanceSilently() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)

        let first = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(first, .ok)
        XCTAssertTrue(stream.started)

        controller.teardown()

        // Silent — unlike stopGuidance's "已停止导航。": there is no
        // rider-facing turn left to speak it to once the session is gone.
        XCTAssertFalse(box.spoken.contains("已停止导航。"))
        XCTAssertFalse(stream.started)
        XCTAssertNil(box.guidance)

        // The controller itself is reusable across session cycles (mirrors
        // Android's teardown() doc): a fresh start after teardown must work
        // normally, not find itself permanently wedged.
        let second = await controller.perform(.navigationStart(query: "终点"))
        XCTAssertEqual(second, .ok)
        XCTAssertTrue(stream.started)
    }

    func testActionMismatchIsRejected() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.torchSet(on: true))
        XCTAssertEqual(result.status, .unsupported)
    }
}
