import CoreLocation
import UIKit

enum CompanionLocationPermission: Equatable {
    case notDetermined
    case denied
    case reduced
    case precise
}

protocol CompanionLocationManaging: AnyObject {
    var desiredAccuracy: CLLocationAccuracy { get set }
    var activityType: CLActivityType { get set }
    var allowsBackgroundLocationUpdates: Bool { get set }
    var showsBackgroundLocationIndicator: Bool { get set }
    var pausesLocationUpdatesAutomatically: Bool { get set }
    func requestWhenInUseAuthorization()
    func startUpdatingLocation()
    func stopUpdatingLocation()
}

extension CLLocationManager: CompanionLocationManaging {}

final class CompanionLocationStream: NSObject, CLLocationManagerDelegate {
    var onFix: ((CLLocation) -> Void)?
    var onPermission: ((CompanionLocationPermission) -> Void)?

    private let manager: CompanionLocationManaging
    private let applicationState: () -> UIApplication.State
    private let authorizationStatus: () -> CLAuthorizationStatus
    private let accuracyAuthorization: () -> CLAccuracyAuthorization
    private let generationLock = NSLock()

    private var generation = 0
    private var ownsStartAttempt = false
    private var updatesStarted = false
    private var acceptsFixes = false
    private var lastPublishedPermission: CompanionLocationPermission?

    override convenience init() {
        let manager = CLLocationManager()
        self.init(
            manager: manager,
            applicationState: { UIApplication.shared.applicationState },
            authorizationStatus: { manager.authorizationStatus },
            accuracyAuthorization: { manager.accuracyAuthorization }
        )
    }

    init(
        manager: CompanionLocationManaging,
        applicationState: @escaping () -> UIApplication.State,
        authorizationStatus: @escaping () -> CLAuthorizationStatus,
        accuracyAuthorization: @escaping () -> CLAccuracyAuthorization
    ) {
        self.manager = manager
        self.applicationState = applicationState
        self.authorizationStatus = authorizationStatus
        self.accuracyAuthorization = accuracyAuthorization
        super.init()
        (manager as? CLLocationManager)?.delegate = self
    }

    func startFromForeground() -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard applicationState() == .active else { return false }
        if ownsStartAttempt {
            return acceptsFixes
        }

        let owner = advanceGeneration()
        ownsStartAttempt = true
        updatesStarted = false
        acceptsFixes = false
        lastPublishedPermission = nil

        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .automotiveNavigation
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.pausesLocationUpdatesAutomatically = false

        let permission = currentPermission()
        publish(permission, owner: owner)
        guard isCurrent(owner), ownsStartAttempt else { return acceptsFixes }

        switch permission {
        case .denied, .reduced:
            return false

        case .notDetermined:
            manager.requestWhenInUseAuthorization()
            guard isCurrent(owner), ownsStartAttempt else { return acceptsFixes }
            let permissionAfterRequest = currentPermission()
            guard permissionAfterRequest == .notDetermined || permissionAfterRequest == .precise else {
                return false
            }
            updatesStarted = true
            acceptsFixes = true
            manager.startUpdatingLocation()

        case .precise:
            updatesStarted = true
            acceptsFixes = true
            manager.startUpdatingLocation()
        }

        return isCurrent(owner) && ownsStartAttempt && acceptsFixes
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        let hadStartAttempt = ownsStartAttempt
        _ = advanceGeneration()
        ownsStartAttempt = false
        updatesStarted = false
        acceptsFixes = false
        lastPublishedPermission = nil

        manager.allowsBackgroundLocationUpdates = false
        manager.showsBackgroundLocationIndicator = false
        if hadStartAttempt {
            manager.stopUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let callbackOwner = currentGeneration()
        onMain { [weak self] in
            guard let self,
                  self.isCurrent(callbackOwner),
                  self.ownsStartAttempt,
                  self.acceptsFixes,
                  let newest = locations.last else {
                return
            }
            self.onFix?(newest)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let callbackOwner = currentGeneration()
        onMain { [weak self] in
            guard let self,
                  self.isCurrent(callbackOwner),
                  self.ownsStartAttempt else {
                return
            }
            let permission = self.currentPermission()
            self.acceptsFixes = permission == .precise && self.updatesStarted
            self.publish(permission, owner: callbackOwner)
        }
    }

    private func currentPermission() -> CompanionLocationPermission {
        switch authorizationStatus() {
        case .notDetermined:
            return .notDetermined
        case .denied, .restricted:
            return .denied
        case .authorizedAlways, .authorizedWhenInUse:
            return accuracyAuthorization() == .fullAccuracy ? .precise : .reduced
        @unknown default:
            return .denied
        }
    }

    private func publish(_ permission: CompanionLocationPermission, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard isCurrent(owner), ownsStartAttempt, lastPublishedPermission != permission else { return }
        lastPublishedPermission = permission
        onPermission?(permission)
    }

    private func advanceGeneration() -> Int {
        generationLock.lock()
        generation &+= 1
        let value = generation
        generationLock.unlock()
        return value
    }

    private func currentGeneration() -> Int {
        generationLock.lock()
        let value = generation
        generationLock.unlock()
        return value
    }

    private func isCurrent(_ owner: Int) -> Bool {
        currentGeneration() == owner
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }
}
