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
    private var managerEffectOwners: [Int] = []
    private var ownsStartAttempt = false
    private var updatesStarted = false
    private var precisePermissionConfirmed = false
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
            return updatesStarted
        }

        let owner = advanceGeneration()
        ownsStartAttempt = true
        updatesStarted = false
        precisePermissionConfirmed = false
        acceptsFixes = false
        lastPublishedPermission = nil

        guard performManagerEffect(owner: owner, effect: {
            manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        }), ownsStartAttempt else { return activeStartResult }
        guard performManagerEffect(owner: owner, effect: {
            manager.activityType = .automotiveNavigation
        }), ownsStartAttempt else { return activeStartResult }
        guard performManagerEffect(owner: owner, effect: {
            manager.allowsBackgroundLocationUpdates = true
        }), ownsStartAttempt else { return activeStartResult }
        guard performManagerEffect(owner: owner, effect: {
            manager.showsBackgroundLocationIndicator = true
        }), ownsStartAttempt else { return activeStartResult }
        guard performManagerEffect(owner: owner, effect: {
            manager.pausesLocationUpdatesAutomatically = false
        }), ownsStartAttempt else { return activeStartResult }

        let permission = currentPermission()
        precisePermissionConfirmed = permission == .precise
        publish(permission, owner: owner)
        guard isCurrent(owner), ownsStartAttempt else { return activeStartResult }

        switch permission {
        case .denied, .reduced:
            return false

        case .notDetermined:
            guard performManagerEffect(owner: owner, effect: {
                manager.requestWhenInUseAuthorization()
            }), ownsStartAttempt else { return activeStartResult }
            let permissionAfterRequest = currentPermission()
            guard permissionAfterRequest == .notDetermined || permissionAfterRequest == .precise else {
                return false
            }
            updatesStarted = true
            acceptsFixes = precisePermissionConfirmed
            _ = performManagerEffect(owner: owner, effect: {
                manager.startUpdatingLocation()
            })

        case .precise:
            updatesStarted = true
            acceptsFixes = true
            _ = performManagerEffect(owner: owner, effect: {
                manager.startUpdatingLocation()
            })
        }

        return activeStartResult
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        let hadStartAttempt = ownsStartAttempt
        let owner = advanceGeneration()
        ownsStartAttempt = false
        updatesStarted = false
        precisePermissionConfirmed = false
        acceptsFixes = false
        lastPublishedPermission = nil

        guard performManagerEffect(owner: owner, effect: {
            manager.allowsBackgroundLocationUpdates = false
        }) else { return }
        guard performManagerEffect(owner: owner, effect: {
            manager.showsBackgroundLocationIndicator = false
        }) else { return }
        if hadStartAttempt {
            _ = performManagerEffect(owner: owner, effect: {
                manager.stopUpdatingLocation()
            })
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let callbackOwner = captureCallbackOwner()
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
        let callbackOwner = captureCallbackOwner()
        onMain { [weak self] in
            guard let self,
                  self.isCurrent(callbackOwner),
                  self.ownsStartAttempt else {
                return
            }
            let permission = self.currentPermission()
            self.precisePermissionConfirmed = permission == .precise
            self.acceptsFixes = self.precisePermissionConfirmed && self.updatesStarted
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

    private var activeStartResult: Bool {
        ownsStartAttempt && updatesStarted
    }

    private func captureCallbackOwner() -> Int {
        if Thread.isMainThread, let effectOwner = managerEffectOwners.last {
            return effectOwner
        }
        return currentGeneration()
    }

    @discardableResult
    private func performManagerEffect(owner: Int, effect: () -> Void) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        managerEffectOwners.append(owner)
        defer {
            assert(managerEffectOwners.last == owner)
            managerEffectOwners.removeLast()
        }
        effect()
        return isCurrent(owner)
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }
}
