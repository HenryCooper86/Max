import CoreLocation
import Foundation

/// Production `LocationStreaming`, a CLLocationManager configured for driving.
/// Runs only during explicit navigation, including background navigation.
final class SystemLocationStream: NSObject, LocationStreaming, CLLocationManagerDelegate {
    var onFailure: ((String) -> Void)?
    var onUpdate: ((CLLocationCoordinate2D) -> Void)?
    private let manager: CLLocationManager
    private let now: () -> Date
    private var accessContinuations: [CheckedContinuation<Bool, Never>] = []

    init(manager: CLLocationManager = CLLocationManager(), now: @escaping () -> Date = Date.init) {
        self.manager = manager
        self.now = now
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .automotiveNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
    }

    func authorization() -> LocationAuthorization {
        guard CLLocationManager.locationServicesEnabled() else { return .denied }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestAccess() async -> Bool {
        switch authorization() {
        case .authorized: return true
        case .denied: return false
        case .notDetermined: break
        }
        return await withCheckedContinuation { continuation in
            accessContinuations.append(continuation)
            if accessContinuations.count == 1 { manager.requestWhenInUseAuthorization() }
        }
    }

    func start() {
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        if let cached = manager.location {
            locationManager(manager, didUpdateLocations: [cached])
        }
    }
    func stop() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        manager.showsBackgroundLocationIndicator = false
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let currentTime = now()
        // Core Location can initially return a cached fix. Reject invalid
        // measurements and fixes older than 15 seconds before routing from them.
        guard let fix = locations.last(where: { location in
            let age = currentTime.timeIntervalSince(location.timestamp)
            return location.horizontalAccuracy.isFinite && location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 100
                && CLLocationCoordinate2DIsValid(location.coordinate)
                && age >= -5 && age <= 15
        }) else { return }
        onUpdate?(fix.coordinate)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A temporary inability to acquire satellites is retried by Core Location.
        if (error as? CLError)?.code == .locationUnknown { return }
        onFailure?(L("loc.unavailable", ("name", "Max")))
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = authorization()
        guard status != .notDetermined else { return }
        let continuations = accessContinuations
        accessContinuations = []
        continuations.forEach { $0.resume(returning: status == .authorized) }
    }
}
