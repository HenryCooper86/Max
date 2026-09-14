import CoreLocation
import XCTest
@testable import MaxHelmet

final class RelayNavigationSearchTests: XCTestCase {

    /// Captures every JSON string handed to the search's `send` closure — the
    /// CrashController-style send seam AgentSession wires to the socket.
    /// Locked because the watchdog timeout resumes from a detached Task.
    private final class SendBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _sent: [String] = []
        var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }
        func handle(_ json: String) { lock.lock(); _sent.append(json); lock.unlock() }
    }

    /// Records whether/what a suspended `route`/`reroute` call resolved to,
    /// settable from whatever thread resumes its continuation. Locked for the
    /// same reason `SendBox` is: the watchdog (and, here, the preempted
    /// caller's own resumption) can run off the calling thread.
    private final class ResolutionBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _resolved = false
        private var _route: NavigationRoute?
        var resolved: Bool { lock.lock(); defer { lock.unlock() }; return _resolved }
        var route: NavigationRoute? { lock.lock(); defer { lock.unlock() }; return _route }
        func record(_ route: NavigationRoute?) {
            lock.lock()
            _resolved = true
            _route = route
            lock.unlock()
        }
    }

    private func decode(_ json: String) -> [String: Any] {
        let object = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        return object as? [String: Any] ?? [:]
    }

    /// Bounded busy-wait for an observable condition instead of an arbitrary
    /// fixed sleep — mirrors the Kotlin test suite's own `awaitCondition`
    /// helper (`android/.../RelayNavigationSearchTest.kt`).
    private func awaitCondition(
        timeoutSeconds: Double = 2,
        description: String = "condition",
        _ check: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !check() {
            if Date() > deadline {
                XCTFail("Timed out waiting for \(description)")
                return
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: - route(to:from:)

    func testRouteSendsNavRequestWithReasonStartGCJOriginAndQuery() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle)
        let wgsOrigin = CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817) // Beijing

        let task = Task { await search.route(to: "天安门", from: wgsOrigin) }
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(box.sent.count, 1)
        let payload = decode(box.sent[0])
        XCTAssertEqual(payload["type"] as? String, "nav.request")
        XCTAssertEqual(payload["reason"] as? String, "start")
        XCTAssertEqual(payload["query"] as? String, "天安门")
        XCTAssertNil(payload["destination"], "reason start carries no destination")
        XCTAssertNil(payload["destinationName"])

        let origin = payload["origin"] as? [String: Any]
        let expectedGCJ = CoordinateDatum.wgs84ToGcj02(wgsOrigin)
        let originLat = origin?["lat"] as? Double ?? .nan
        let originLon = origin?["lon"] as? Double ?? .nan
        XCTAssertEqual(originLat, expectedGCJ.latitude, accuracy: 1e-9)
        XCTAssertEqual(originLon, expectedGCJ.longitude, accuracy: 1e-9)
        // The wire origin must be the GCJ-02 shift, not a passthrough of the WGS input.
        XCTAssertGreaterThan(abs(originLat - wgsOrigin.latitude), 1e-4)

        guard let commandId = payload["commandId"] as? String else { return XCTFail("missing commandId") }
        search.handleNavError(commandId: commandId, code: "route.unavailable")
        _ = await task.value
    }

    func testHandleNavRouteResumesWithEveryCoordinateRoundTrippedToWGS() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle)
        let origin = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)

        // Known WGS-84 vectors (same as CoordinateDatumTests) spread across every
        // coordinate field the wire event carries.
        let knownDestination = CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817) // Beijing
        let knownWaypoint = CLLocationCoordinate2D(latitude: 22.543847, longitude: 113.912316) // Shenzhen
        let knownStep = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737) // Shanghai

        let task = Task { await search.route(to: "终点", from: origin) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        guard let commandId = decode(box.sent[0])["commandId"] as? String else { return XCTFail("missing commandId") }

        search.handleNavRoute(NavRouteData(
            commandId: commandId,
            destinationName: "天安门",
            destination: CoordinateDatum.wgs84ToGcj02(knownDestination),
            polyline: [CoordinateDatum.wgs84ToGcj02(knownWaypoint), CoordinateDatum.wgs84ToGcj02(knownDestination)],
            steps: [ManeuverStep(
                instruction: "到达终点",
                coordinate: CoordinateDatum.wgs84ToGcj02(knownStep),
                alongRouteMeters: 1200
            )],
            distanceMeters: 1200,
            etaSeconds: 240
        ))
        let route = await task.value

        guard let route else { return XCTFail("expected a route") }
        XCTAssertEqual(route.relayCommandId, commandId)
        XCTAssertEqual(route.destinationName, "天安门")
        XCTAssertEqual(route.destinationCoordinate.latitude, knownDestination.latitude, accuracy: 1e-5)
        XCTAssertEqual(route.destinationCoordinate.longitude, knownDestination.longitude, accuracy: 1e-5)
        XCTAssertEqual(route.polyline.count, 2)
        XCTAssertEqual(route.polyline[0].latitude, knownWaypoint.latitude, accuracy: 1e-5)
        XCTAssertEqual(route.polyline[0].longitude, knownWaypoint.longitude, accuracy: 1e-5)
        XCTAssertEqual(route.polyline[1].latitude, knownDestination.latitude, accuracy: 1e-5)
        XCTAssertEqual(route.polyline[1].longitude, knownDestination.longitude, accuracy: 1e-5)
        XCTAssertEqual(route.steps.count, 1)
        XCTAssertEqual(route.steps[0].coordinate.latitude, knownStep.latitude, accuracy: 1e-5)
        XCTAssertEqual(route.steps[0].coordinate.longitude, knownStep.longitude, accuracy: 1e-5)
        XCTAssertEqual(route.steps[0].alongRouteMeters, 1200)
        XCTAssertEqual(route.totalDistanceMeters, 1200)
        XCTAssertEqual(route.totalEtaSeconds, 240)
    }

    func testHandleNavErrorResumesNil() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle)
        let task = Task { await search.route(to: "终点", from: CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        guard let commandId = decode(box.sent[0])["commandId"] as? String else { return XCTFail("missing commandId") }

        search.handleNavError(commandId: commandId, code: "route.unavailable")
        let route = await task.value

        XCTAssertNil(route)
    }

    func testMismatchedCommandIdIsIgnoredThenTimesOut() async {
        let box = SendBox()
        // Short injected timeout so the test doesn't wait the real 7 s default.
        let search = RelayNavigationSearch(send: box.handle, timeoutSeconds: 0.05)
        let task = Task { await search.route(to: "终点", from: CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)) }
        try? await Task.sleep(nanoseconds: 20_000_000)

        search.handleNavRoute(NavRouteData(
            commandId: "not-the-right-id",
            destinationName: "别处",
            destination: CLLocationCoordinate2D(latitude: 1, longitude: 1),
            polyline: [],
            steps: [],
            distanceMeters: 0,
            etaSeconds: 0
        ))
        search.handleNavError(commandId: "also-wrong", code: "route.unavailable")

        // Neither mismatched answer resumes it — only the watchdog timeout does.
        let route = await task.value
        XCTAssertNil(route)
    }

    func testFailPendingResumesNil() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle, timeoutSeconds: 5)
        let task = Task { await search.route(to: "终点", from: CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)) }
        try? await Task.sleep(nanoseconds: 50_000_000)

        search.failPending()
        let route = await task.value

        XCTAssertNil(route)
    }

    func testSecondConcurrentRouteCallFailsTheFirstWithNil() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle, timeoutSeconds: 5)
        let firstTask = Task { await search.route(to: "第一个", from: CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)) }
        try? await Task.sleep(nanoseconds: 50_000_000)

        let secondTask = Task { await search.route(to: "第二个", from: CLLocationCoordinate2D(latitude: 39.91, longitude: 116.41)) }
        let firstResult = await firstTask.value

        XCTAssertNil(firstResult, "a second concurrent call fails the first with nil")

        guard let secondSent = box.sent.last, let commandId = decode(secondSent)["commandId"] as? String else {
            return XCTFail("missing second commandId")
        }
        search.handleNavError(commandId: commandId, code: "route.unavailable")
        _ = await secondTask.value
    }

    /// Pins the atomic preempt-and-register swap: a second `route()` started
    /// while the first is suspended must resolve the first with `nil`
    /// strictly BEFORE the second's request is sent, not merely "eventually,
    /// before the second's own answer arrives". Ordering is read off the
    /// captured `sent` array itself (by-count, bounded-polled) rather than a
    /// fixed sleep, mirroring the Kotlin suite's own by-count assertions.
    func testSecondRouteResolvesFirstWithNilBeforeSecondRequestIsSent() async {
        let box = SendBox()
        let firstResolution = ResolutionBox()
        let search = RelayNavigationSearch(send: box.handle, timeoutSeconds: 5)
        let origin = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)

        let firstTask = Task {
            let route = await search.route(to: "第一个", from: origin)
            firstResolution.record(route)
        }
        await awaitCondition(description: "first request sent") { box.sent.count == 1 }

        let secondTask = Task { await search.route(to: "第二个", from: origin) }
        // Poll `sent` before inspecting the first's resolution: proves the
        // second request was actually dispatched, not merely that the first
        // was preempted at some later, unobserved point.
        await awaitCondition(description: "second request sent") { box.sent.count == 2 }

        XCTAssertTrue(firstResolution.resolved, "first route() must already be resolved by the time the second request is sent")
        XCTAssertNil(firstResolution.route, "the preempted first call resolves with nil")

        guard let secondCommandId = decode(box.sent[1])["commandId"] as? String else {
            return XCTFail("missing second commandId")
        }
        search.handleNavRoute(NavRouteData(
            commandId: secondCommandId,
            destinationName: "第二个",
            destination: CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817),
            polyline: [],
            steps: [],
            distanceMeters: 500,
            etaSeconds: 100
        ))
        let secondResult = await secondTask.value
        XCTAssertNotNil(secondResult, "the surviving second call resolves with a routed answer")

        _ = await firstTask.value
    }

    // MARK: - reroute(to:from:)

    func testRerouteSendsReasonRerouteWithGCJDestinationAndRememberedName() async {
        let box = SendBox()
        let search = RelayNavigationSearch(send: box.handle)
        let origin = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
        let destination = CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817)

        // Establish an active route first so a destinationName is remembered.
        let startTask = Task { await search.route(to: "终点", from: origin) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        guard let startId = decode(box.sent[0])["commandId"] as? String else { return XCTFail("missing commandId") }
        search.handleNavRoute(NavRouteData(
            commandId: startId,
            destinationName: "天安门",
            destination: CoordinateDatum.wgs84ToGcj02(destination),
            polyline: [CoordinateDatum.wgs84ToGcj02(destination)],
            steps: [],
            distanceMeters: 1000,
            etaSeconds: 200
        ))
        _ = await startTask.value

        let rerouteOrigin = CLLocationCoordinate2D(latitude: 39.905, longitude: 116.395)
        let rerouteTask = Task { await search.reroute(to: destination, from: rerouteOrigin) }
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(box.sent.count, 2)
        let payload = decode(box.sent[1])
        XCTAssertEqual(payload["reason"] as? String, "reroute")
        XCTAssertEqual(payload["destinationName"] as? String, "天安门")
        XCTAssertNil(payload["query"])
        let sentDestination = payload["destination"] as? [String: Any]
        let expectedGCJDestination = CoordinateDatum.wgs84ToGcj02(destination)
        XCTAssertEqual(sentDestination?["lat"] as? Double ?? .nan, expectedGCJDestination.latitude, accuracy: 1e-9)
        XCTAssertEqual(sentDestination?["lon"] as? Double ?? .nan, expectedGCJDestination.longitude, accuracy: 1e-9)
        let sentOrigin = payload["origin"] as? [String: Any]
        let expectedGCJOrigin = CoordinateDatum.wgs84ToGcj02(rerouteOrigin)
        XCTAssertEqual(sentOrigin?["lat"] as? Double ?? .nan, expectedGCJOrigin.latitude, accuracy: 1e-9)

        guard let rerouteId = payload["commandId"] as? String else { return XCTFail("missing commandId") }
        search.handleNavError(commandId: rerouteId, code: "route.unavailable")
        _ = await rerouteTask.value
    }
}
