import CoreLocation
import XCTest
@testable import MaxHelmet

private final class PermissionLocationManager: CLLocationManager {
    var status: CLAuthorizationStatus = .notDetermined
    var requests = 0
    override var authorizationStatus: CLAuthorizationStatus { status }
    override func startUpdatingLocation() {}
    override func stopUpdatingLocation() {}
    override func requestWhenInUseAuthorization() { requests += 1 }
}

@MainActor
final class SystemLocationStreamTests: XCTestCase {
    func testBackgroundLocationIsScopedToNavigation() {
        let manager = PermissionLocationManager()
        let stream = SystemLocationStream(manager: manager)
        stream.start()
        XCTAssertTrue(manager.allowsBackgroundLocationUpdates)
        XCTAssertTrue(manager.showsBackgroundLocationIndicator)
        stream.stop()
        XCTAssertFalse(manager.allowsBackgroundLocationUpdates)
        XCTAssertFalse(manager.showsBackgroundLocationIndicator)
    }

    func testCachedAndInvalidFixesCannotStartOrAdvanceGuidance() {
        let manager = PermissionLocationManager()
        let now = Date(timeIntervalSince1970: 1_000)
        let stream = SystemLocationStream(manager: manager, now: { now })
        var received: [CLLocationCoordinate2D] = []
        stream.onUpdate = { received.append($0) }
        func fix(latitude: Double = 31, accuracy: Double = 10, age: TimeInterval = 0) -> CLLocation {
            CLLocation(coordinate: .init(latitude: latitude, longitude: 121), altitude: 0,
                       horizontalAccuracy: accuracy, verticalAccuracy: 10,
                       timestamp: now.addingTimeInterval(-age))
        }
        stream.locationManager(manager, didUpdateLocations: [fix(age: 60), fix(accuracy: -1), fix(latitude: 91), fix(age: -60)])
        XCTAssertTrue(received.isEmpty)
        stream.locationManager(manager, didUpdateLocations: [fix(latitude: 32, age: 1), fix(accuracy: -1)])
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first?.latitude, 32)
    }

    func testConcurrentPermissionRequestsSharePromptAndAllComplete() async {
        let manager = PermissionLocationManager()
        let stream = SystemLocationStream(manager: manager)
        let first = Task { await stream.requestAccess() }
        let second = Task { await stream.requestAccess() }
        // Enqueue a barrier behind both tasks on the main actor.
        await Task { @MainActor in }.value
        XCTAssertEqual(manager.requests, 1)
        stream.locationManagerDidChangeAuthorization(manager)
        manager.status = .authorizedWhenInUse
        stream.locationManagerDidChangeAuthorization(manager)
        let firstResult = await first.value
        let secondResult = await second.value
        XCTAssertTrue(firstResult)
        XCTAssertTrue(secondResult)
        // Repeated delegate callbacks must not resume either request twice.
        stream.locationManagerDidChangeAuthorization(manager)
    }

    func testSettledPermissionReturnsWithoutWaitingForAnotherCallback() async {
        let manager = PermissionLocationManager()
        let stream = SystemLocationStream(manager: manager)
        manager.status = .denied
        let denied = await stream.requestAccess()
        XCTAssertFalse(denied)
        manager.status = .authorizedWhenInUse
        let granted = await stream.requestAccess()
        XCTAssertTrue(granted)
        XCTAssertEqual(manager.requests, 0)
    }
}
