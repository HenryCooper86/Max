import CoreLocation
import UIKit
import XCTest
@testable import MaxHelmet

final class CompanionLocationStreamTests: XCTestCase {
    func testPreciseForegroundStartConfiguresDedicatedManagerBeforeStarting() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .authorizedWhenInUse
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { .fullAccuracy })
        var permissions: [CompanionLocationPermission] = []
        stream.onPermission = { permissions.append($0) }

        XCTAssertTrue(stream.startFromForeground())

        XCTAssertEqual(manager.desiredAccuracy, kCLLocationAccuracyBestForNavigation)
        XCTAssertEqual(manager.activityType, .automotiveNavigation)
        XCTAssertTrue(manager.allowsBackgroundLocationUpdates)
        XCTAssertTrue(manager.showsBackgroundLocationIndicator)
        XCTAssertFalse(manager.pausesLocationUpdatesAutomatically)
        XCTAssertEqual(manager.requestCount, 0)
        XCTAssertEqual(manager.startCount, 1)
        XCTAssertEqual(manager.events, ["background:true", "indicator:true", "request-pausing:false", "start"])
        XCTAssertEqual(permissions, [.precise])

        authorization = .authorizedAlways
        XCTAssertTrue(stream.startFromForeground())
        XCTAssertEqual(manager.startCount, 1, "a repeated active start must not create another location session")
    }

    func testNotDeterminedStartRequestsOnceAndBeginsUpdates() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .notDetermined }, accuracy: { .fullAccuracy })
        var permissions: [CompanionLocationPermission] = []
        stream.onPermission = { permissions.append($0) }

        XCTAssertTrue(stream.startFromForeground())
        XCTAssertTrue(stream.startFromForeground())

        XCTAssertEqual(manager.requestCount, 1)
        XCTAssertEqual(manager.startCount, 1)
        XCTAssertEqual(permissions, [.notDetermined])
        XCTAssertEqual(manager.events.suffix(2), ["request", "start"])
    }

    func testNotDeterminedUpdatesNeverForwardUntilCurrentLifecycleBecomesPrecise() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .notDetermined
        var accuracy: CLAccuracyAuthorization = .fullAccuracy
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
        var permissions: [CompanionLocationPermission] = []
        var latitudes: [Double] = []
        stream.onPermission = { permissions.append($0) }
        stream.onFix = { latitudes.append($0.coordinate.latitude) }

        XCTAssertTrue(stream.startFromForeground())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 10)])

        authorization = .denied
        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 11)])

        authorization = .authorizedWhenInUse
        accuracy = .fullAccuracy
        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 12)])

        accuracy = .reducedAccuracy
        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 13)])

        accuracy = .fullAccuracy
        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 14)])

        XCTAssertEqual(permissions, [.notDetermined, .denied, .precise, .reduced, .precise])
        XCTAssertEqual(latitudes, [12, 14])
        XCTAssertEqual(manager.requestCount, 1)
        XCTAssertEqual(manager.startCount, 1)
    }

    func testNotDeterminedPreciseStatusReReadCannotReplacePreciseAuthorizationCallback() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .notDetermined
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { .fullAccuracy })
        var latitudes: [Double] = []
        stream.onFix = { latitudes.append($0.coordinate.latitude) }
        manager.onRequest = {
            authorization = .authorizedAlways
        }

        XCTAssertTrue(stream.startFromForeground())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 15)])

        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 16)])

        XCTAssertEqual(latitudes, [16])
        XCTAssertEqual(manager.requestCount, 1)
        XCTAssertEqual(manager.startCount, 1)
    }

    func testDeniedRestrictedAndReducedStartsPublishTruthAndRefuseUpdates() {
        let cases: [(CLAuthorizationStatus, CLAccuracyAuthorization, CompanionLocationPermission)] = [
            (.denied, .fullAccuracy, .denied),
            (.restricted, .fullAccuracy, .denied),
            (.authorizedWhenInUse, .reducedAccuracy, .reduced),
            (.authorizedAlways, .reducedAccuracy, .reduced)
        ]

        for (authorization, accuracy, expected) in cases {
            let manager = FakeCompanionLocationManager()
            let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
            var permissions: [CompanionLocationPermission] = []
            stream.onPermission = { permissions.append($0) }

            XCTAssertFalse(stream.startFromForeground(), "authorization \(authorization.rawValue)")
            XCTAssertEqual(permissions, [expected])
            XCTAssertEqual(manager.requestCount, 0)
            XCTAssertEqual(manager.startCount, 0)
            XCTAssertTrue(manager.allowsBackgroundLocationUpdates, "the configured attempt remains owned until stop")
            XCTAssertTrue(manager.showsBackgroundLocationIndicator)
        }
    }

    func testEveryAuthorizationAndAccuracyCombinationMapsTruthfully() {
        let cases: [(CLAuthorizationStatus, CLAccuracyAuthorization, CompanionLocationPermission)] = [
            (.notDetermined, .fullAccuracy, .notDetermined),
            (.denied, .fullAccuracy, .denied),
            (.restricted, .fullAccuracy, .denied),
            (.authorizedWhenInUse, .reducedAccuracy, .reduced),
            (.authorizedAlways, .reducedAccuracy, .reduced),
            (.authorizedWhenInUse, .fullAccuracy, .precise),
            (.authorizedAlways, .fullAccuracy, .precise)
        ]

        for (authorization, accuracy, expected) in cases {
            let manager = FakeCompanionLocationManager()
            let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
            var observed: CompanionLocationPermission?
            stream.onPermission = { observed = $0 }

            _ = stream.startFromForeground()

            XCTAssertEqual(observed, expected, "authorization \(authorization.rawValue), accuracy \(accuracy.rawValue)")
        }
    }

    func testBackgroundOriginRefusesWithNoManagerOrPermissionEffects() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(
            manager: manager,
            applicationState: { .background },
            authorization: { .authorizedAlways },
            accuracy: { .fullAccuracy }
        )
        var permissions: [CompanionLocationPermission] = []
        stream.onPermission = { permissions.append($0) }

        XCTAssertFalse(stream.startFromForeground())

        XCTAssertTrue(manager.events.isEmpty)
        XCTAssertEqual(manager.startCount, 0)
        XCTAssertEqual(manager.requestCount, 0)
        XCTAssertTrue(permissions.isEmpty)
    }

    func testDelegateDeliversOnlyNewestLocationFromEachNonemptyActiveBatch() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .authorizedAlways }, accuracy: { .fullAccuracy })
        let first = location(latitude: 31.1)
        let newest = location(latitude: 31.3)
        var received: [CLLocation] = []
        stream.onFix = { received.append($0) }
        XCTAssertTrue(stream.startFromForeground())

        stream.locationManager(CLLocationManager(), didUpdateLocations: [first, location(latitude: 31.2), newest])
        stream.locationManager(CLLocationManager(), didUpdateLocations: [])
        stream.locationManager(CLLocationManager(), didFailWithError: TestLocationError.failed)

        XCTAssertEqual(received.count, 1)
        XCTAssertTrue(received[0] === newest)
    }

    func testStopInvalidatesCallbacksBeforeEffectsAndIsIdempotentForEveryStartAttempt() {
        let cases: [(CLAuthorizationStatus, CLAccuracyAuthorization)] = [
            (.authorizedAlways, .fullAccuracy),
            (.notDetermined, .fullAccuracy),
            (.denied, .fullAccuracy),
            (.authorizedWhenInUse, .reducedAccuracy)
        ]

        for (authorization, accuracy) in cases {
            let manager = FakeCompanionLocationManager()
            let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
            var fixCount = 0
            stream.onFix = { _ in fixCount += 1 }
            _ = stream.startFromForeground()
            manager.onStop = {
                stream.locationManager(CLLocationManager(), didUpdateLocations: [self.location(latitude: 45)])
            }

            stream.stop()
            stream.stop()
            stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 46)])

            XCTAssertFalse(manager.allowsBackgroundLocationUpdates)
            XCTAssertFalse(manager.showsBackgroundLocationIndicator)
            XCTAssertEqual(manager.stopCount, 1, "authorization \(authorization.rawValue)")
            XCTAssertEqual(fixCount, 0)
        }
    }

    func testPermissionChangesDeliverOnMainWithoutDuplicatesAndStopSuppressesStaleChange() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .notDetermined
        var accuracy: CLAccuracyAuthorization = .fullAccuracy
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
        var observed: [(CompanionLocationPermission, Bool)] = []
        stream.onPermission = { observed.append(($0, Thread.isMainThread)) }
        XCTAssertTrue(stream.startFromForeground())

        authorization = .authorizedWhenInUse
        accuracy = .reducedAccuracy
        let reduced = expectation(description: "reduced permission delivered on main")
        DispatchQueue.global().async {
            stream.locationManagerDidChangeAuthorization(CLLocationManager())
            DispatchQueue.main.async { reduced.fulfill() }
        }
        wait(for: [reduced], timeout: 2)

        stream.locationManagerDidChangeAuthorization(CLLocationManager())
        stream.stop()
        authorization = .authorizedAlways
        accuracy = .fullAccuracy
        stream.locationManagerDidChangeAuthorization(CLLocationManager())

        XCTAssertEqual(observed.map(\.0), [.notDetermined, .reduced])
        XCTAssertTrue(observed.allSatisfy(\.1))
    }

    func testSynchronousPermissionReentryLeavesNewestStopStartOwnerAuthoritative() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .notDetermined
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { .fullAccuracy })
        var permissions: [CompanionLocationPermission] = []
        var reentered = false
        stream.onPermission = { permission in
            permissions.append(permission)
            guard permission == .precise, !reentered else { return }
            reentered = true
            stream.stop()
            XCTAssertTrue(stream.startFromForeground())
        }
        manager.onRequest = {
            authorization = .authorizedAlways
            stream.locationManagerDidChangeAuthorization(CLLocationManager())
        }

        XCTAssertTrue(stream.startFromForeground())

        XCTAssertEqual(permissions, [.notDetermined, .precise, .precise])
        XCTAssertEqual(manager.requestCount, 1)
        XCTAssertEqual(manager.stopCount, 1)
        XCTAssertEqual(manager.startCount, 1, "the stale outer start must not start a second session")
        XCTAssertTrue(manager.allowsBackgroundLocationUpdates)
    }

    func testSynchronousRequestDowngradeCannotLetOuterStartForwardLocations() {
        let cases: [(CLAuthorizationStatus, CLAccuracyAuthorization, CompanionLocationPermission)] = [
            (.denied, .fullAccuracy, .denied),
            (.authorizedWhenInUse, .reducedAccuracy, .reduced)
        ]

        for (newAuthorization, newAccuracy, expectedPermission) in cases {
            let manager = FakeCompanionLocationManager()
            var authorization: CLAuthorizationStatus = .notDetermined
            var accuracy: CLAccuracyAuthorization = .fullAccuracy
            let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
            var permissions: [CompanionLocationPermission] = []
            var fixCount = 0
            stream.onPermission = { permissions.append($0) }
            stream.onFix = { _ in fixCount += 1 }
            manager.onRequest = {
                authorization = newAuthorization
                accuracy = newAccuracy
                stream.locationManagerDidChangeAuthorization(CLLocationManager())
            }

            XCTAssertFalse(stream.startFromForeground())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 30)])

            XCTAssertEqual(permissions, [.notDetermined, expectedPermission])
            XCTAssertEqual(manager.requestCount, 1)
            XCTAssertEqual(manager.startCount, 0)
            XCTAssertEqual(fixCount, 0)
        }
    }

    func testActiveStreamStopsForwardingImmediatelyWhenPermissionBecomesDeniedOrReduced() {
        let cases: [(CLAuthorizationStatus, CLAccuracyAuthorization, CompanionLocationPermission)] = [
            (.denied, .fullAccuracy, .denied),
            (.authorizedWhenInUse, .reducedAccuracy, .reduced)
        ]

        for (newAuthorization, newAccuracy, expectedPermission) in cases {
            let manager = FakeCompanionLocationManager()
            var authorization: CLAuthorizationStatus = .authorizedAlways
            var accuracy: CLAccuracyAuthorization = .fullAccuracy
            let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { accuracy })
            var permissions: [CompanionLocationPermission] = []
            var latitudes: [Double] = []
            stream.onPermission = { permissions.append($0) }
            stream.onFix = { latitudes.append($0.coordinate.latitude) }
            XCTAssertTrue(stream.startFromForeground())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 40)])

            authorization = newAuthorization
            accuracy = newAccuracy
            stream.locationManagerDidChangeAuthorization(CLLocationManager())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 41)])

            XCTAssertEqual(permissions, [.precise, expectedPermission])
            XCTAssertEqual(latitudes, [40])
            XCTAssertEqual(manager.startCount, 1)
            XCTAssertTrue(manager.allowsBackgroundLocationUpdates, "the coordinator still owns explicit cleanup")
        }
    }

    func testSynchronousStartCallbackAndFixReentryCannotDeliverAfterStop() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .authorizedAlways }, accuracy: { .fullAccuracy })
        let first = location(latitude: 50)
        let second = location(latitude: 51)
        var received: [CLLocation] = []
        stream.onFix = { location in
            received.append(location)
            stream.stop()
        }
        manager.onStart = {
            stream.locationManager(CLLocationManager(), didUpdateLocations: [first])
            stream.locationManager(CLLocationManager(), didUpdateLocations: [second])
        }

        XCTAssertFalse(stream.startFromForeground(), "reentrant stop makes the completed start inactive")
        stream.locationManager(CLLocationManager(), didUpdateLocations: [second])

        XCTAssertEqual(received.count, 1)
        XCTAssertTrue(received[0] === first)
        XCTAssertEqual(manager.startCount, 1)
        XCTAssertEqual(manager.stopCount, 1)
    }

    func testSupersededRequestEffectCannotAssignItsLateSynchronousFixToReplacementStart() {
        let manager = FakeCompanionLocationManager()
        var authorization: CLAuthorizationStatus = .notDetermined
        let stream = makeStream(manager: manager, authorization: { authorization }, accuracy: { .fullAccuracy })
        var latitudes: [Double] = []
        stream.onFix = { latitudes.append($0.coordinate.latitude) }
        manager.onRequest = {
            manager.onRequest = nil
            stream.stop()
            authorization = .authorizedAlways
            XCTAssertTrue(stream.startFromForeground())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [self.location(latitude: 31)])
        }

        _ = stream.startFromForeground()
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 32)])

        XCTAssertEqual(latitudes, [32])
        XCTAssertEqual(manager.requestCount, 1)
        XCTAssertEqual(manager.startCount, 1)
        XCTAssertEqual(manager.stopCount, 1)
    }

    func testSupersededStartEffectRejectsReviewProbeLeakButAcceptsLaterFreshFix() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .authorizedAlways }, accuracy: { .fullAccuracy })
        var latitudes: [Double] = []
        stream.onFix = { latitudes.append($0.coordinate.latitude) }
        manager.onStart = {
            manager.onStart = nil
            stream.stop()
            XCTAssertTrue(stream.startFromForeground())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [self.location(latitude: 21)])
        }

        _ = stream.startFromForeground()
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 22)])

        XCTAssertEqual(latitudes, [22])
        XCTAssertEqual(manager.startCount, 2)
        XCTAssertEqual(manager.stopCount, 1)
    }

    func testSupersededStopEffectCannotAssignItsLateSynchronousFixToNestedFreshStart() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .authorizedAlways }, accuracy: { .fullAccuracy })
        var latitudes: [Double] = []
        stream.onFix = { latitudes.append($0.coordinate.latitude) }
        XCTAssertTrue(stream.startFromForeground())
        manager.onStop = {
            manager.onStop = nil
            XCTAssertTrue(stream.startFromForeground())
            stream.locationManager(CLLocationManager(), didUpdateLocations: [self.location(latitude: 41)])
        }

        stream.stop()
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 42)])

        XCTAssertEqual(latitudes, [42])
        XCTAssertEqual(manager.startCount, 2)
        XCTAssertEqual(manager.stopCount, 1)
    }

    func testStopThenFreshStartAcceptsOnlyFreshLifecycleCallbacks() {
        let manager = FakeCompanionLocationManager()
        let stream = makeStream(manager: manager, authorization: { .authorizedAlways }, accuracy: { .fullAccuracy })
        var latitudes: [Double] = []
        stream.onFix = { latitudes.append($0.coordinate.latitude) }

        XCTAssertTrue(stream.startFromForeground())
        stream.stop()
        XCTAssertTrue(stream.startFromForeground())
        stream.locationManager(CLLocationManager(), didUpdateLocations: [location(latitude: 60)])

        XCTAssertEqual(latitudes, [60])
        XCTAssertEqual(manager.startCount, 2)
        XCTAssertEqual(manager.stopCount, 1)
    }

    private func makeStream(
        manager: FakeCompanionLocationManager,
        applicationState: @escaping () -> UIApplication.State = { .active },
        authorization: @escaping () -> CLAuthorizationStatus,
        accuracy: @escaping () -> CLAccuracyAuthorization
    ) -> CompanionLocationStream {
        CompanionLocationStream(
            manager: manager,
            applicationState: applicationState,
            authorizationStatus: authorization,
            accuracyAuthorization: accuracy
        )
    }

    private func location(latitude: Double) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: 121.4),
            altitude: 0,
            horizontalAccuracy: 1,
            verticalAccuracy: 1,
            course: 0,
            speed: 0,
            timestamp: Date(timeIntervalSince1970: 1)
        )
    }
}

private enum TestLocationError: Error {
    case failed
}

private final class FakeCompanionLocationManager: CompanionLocationManaging {
    var desiredAccuracy: CLLocationAccuracy = kCLLocationAccuracyThreeKilometers
    var activityType: CLActivityType = .other
    var allowsBackgroundLocationUpdates = false {
        didSet { events.append("background:\(allowsBackgroundLocationUpdates)") }
    }
    var showsBackgroundLocationIndicator = false {
        didSet { events.append("indicator:\(showsBackgroundLocationIndicator)") }
    }
    var pausesLocationUpdatesAutomatically = true {
        didSet { events.append("request-pausing:\(pausesLocationUpdatesAutomatically)") }
    }

    var requestCount = 0
    var startCount = 0
    var stopCount = 0
    var events: [String] = []
    var onRequest: (() -> Void)?
    var onStart: (() -> Void)?
    var onStop: (() -> Void)?

    func requestWhenInUseAuthorization() {
        requestCount += 1
        events.append("request")
        onRequest?()
    }

    func startUpdatingLocation() {
        startCount += 1
        events.append("start")
        onStart?()
    }

    func stopUpdatingLocation() {
        stopCount += 1
        events.append("stop")
        onStop?()
    }
}
