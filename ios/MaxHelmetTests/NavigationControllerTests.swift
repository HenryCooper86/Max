import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeStream: LocationStreaming, @unchecked Sendable {
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    var auth: LocationAuthorization = .authorized
    var granted = true
    var started = false
    func authorization() -> LocationAuthorization { auth }
    func requestAccess() async -> Bool { granted }
    func start() { started = true }
    func stop() { started = false }
    func feed(_ c: CLLocationCoordinate2D) { onUpdate?(c) }
}

private final class FakeSearch: NavigationRouteSearching, @unchecked Sendable {
    var route: NavigationRoute?
    var rerouteResult: NavigationRoute?
    var rerouteCalls = 0
    func route(to query: String) async -> NavigationRoute? { route }
    func reroute(to destination: CLLocationCoordinate2D, from origin: CLLocationCoordinate2D) async -> NavigationRoute? {
        rerouteCalls += 1
        return rerouteResult
    }
}

@MainActor
final class NavigationControllerTests: XCTestCase {

    private func straightRoute() -> NavigationRoute {
        let dest = CLLocationCoordinate2D(latitude: 39.9180, longitude: 116.40)
        return NavigationRoute(
            destinationName: "终点", destinationCoordinate: dest,
            polyline: [CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40), dest],
            steps: [ManeuverStep(instruction: "到达终点", coordinate: dest, distanceMeters: 2000)],
            totalDistanceMeters: 2000, totalEtaSeconds: 400
        )
    }

    final class Box { var guidance: GuidanceState?; var spoken: [String] = []; var interrupts = 0 }

    private func make(_ stream: FakeStream, _ search: FakeSearch, clock: @escaping () -> TimeInterval = { 0 }) -> (NavigationController, Box) {
        let box = Box()
        let controller = NavigationController(
            search: search, stream: stream,
            onGuidance: { box.guidance = $0 },
            speak: { box.spoken.append($0) },
            interruptPlayback: { box.interrupts += 1 },
            now: clock
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

    func testActionMismatchIsRejected() async {
        let (controller, _) = make(FakeStream(), FakeSearch())
        let result = await controller.perform(.torchSet(on: true))
        XCTAssertEqual(result.status, .unsupported)
    }
}
