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
    func requestAccess() async -> Bool { granted }
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
            return await withCheckedContinuation { holdContinuation = $0 }
        }
        return route
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

    func resolveHeldReroute(with result: NavigationRoute?) {
        holdRerouteContinuation?.resume(returning: result)
        holdRerouteContinuation = nil
    }
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

    final class Box { var guidance: GuidanceState?; var spoken: [String] = []; var interrupts = 0 }

    private func make(
        _ stream: FakeStream, _ search: FakeSearch,
        clock: @escaping () -> TimeInterval = { 0 },
        firstFixTimeoutSeconds: TimeInterval = 3
    ) -> (NavigationController, Box) {
        let box = Box()
        let controller = NavigationController(
            search: search, stream: stream,
            onGuidance: { box.guidance = $0 },
            speak: { box.spoken.append($0) },
            interruptPlayback: { box.interrupts += 1 },
            now: clock,
            firstFixTimeoutSeconds: firstFixTimeoutSeconds
        )
        return (controller, box)
    }

    func testStartResolvesStreamsAndSpeaksSummary() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search)

        let result = await controller.perform(.navigationStart(query: "终点"))

        XCTAssertEqual(result, .ok)
        XCTAssertTrue(stream.started)
        XCTAssertNotNil(box.guidance)
        XCTAssertFalse(box.spoken.isEmpty, "opening summary is spoken")
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
        XCTAssertEqual(firstResult.status, .unsupported)
        XCTAssertEqual(firstResult.reason, "route.unavailable")

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

        XCTAssertEqual(second.status, .unsupported)
        XCTAssertEqual(second.reason, "route.unavailable")
        XCTAssertFalse(stream.started, "the stale install must not restart the stream")
        XCTAssertNil(box.guidance, "the stale install must not revive guidance")
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
        XCTAssertEqual(second.status, .unsupported)
        XCTAssertEqual(second.reason, "route.unavailable")
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

    func testActionMismatchIsRejected() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.torchSet(on: true))
        XCTAssertEqual(result.status, .unsupported)
    }
}
