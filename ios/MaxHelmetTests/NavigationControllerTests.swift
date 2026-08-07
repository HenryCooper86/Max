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
        return rerouteResult
    }

    func resolveHeld(with result: NavigationRoute?) {
        holdContinuation?.resume(returning: result)
        holdContinuation = nil
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
