import CoreLocation
import UIKit
import SwiftUI

/// A fixed HUD viewport, independent of phone layout, pan and zoom.
/// Uses the existing map consent and key; renders only while foregrounded.
@MainActor
final class HUDMapSource: NSObject, CLLocationManagerDelegate {
    static let shared = HUDMapSource()
    private let compass = CLLocationManager()
    private var heading: Double?
    private var active = false
    static let viewport = CGSize(width: 800, height: 600)
    private var guidance: GuidanceState?
    private var foreground = true
    #if !targetEnvironment(simulator)
    private var map: MAMapView?
    private var renderer: AMapRouteMap.Coordinator?
    #endif

    func update(_ guidance: GuidanceState?) {
        self.guidance = guidance
        render()
    }

    func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        #if !targetEnvironment(simulator)
        map?.renderringDisabled = !foreground
        #endif
        if foreground { render() }
    }

    private func render() {
        guard active, foreground, UIApplication.shared.applicationState == .active,
              let guidance, let model = AMapRouteDisplayModel.make(guidance: guidance, followsRider: true) else { return }
        #if !targetEnvironment(simulator)
        guard let consent = AMapAcceptedConsent(decision: AMapConsentStore().decision),
              let key = AMapConfiguration().apiKey,
              AMapSDKBootstrapper.shared.prepare(consent: consent, apiKey: key, configuration: liveAMapSDKPrivacyConfiguration()) else { return }
        if map == nil {
            let view = MAMapView(frame: CGRect(origin: .zero, size: Self.viewport))
            let coordinator = AMapRouteMap.Coordinator(loadFailed: .constant(false))
            coordinator.configure(interactive: false, followsRider: true)
            view.delegate = coordinator
            view.isUserInteractionEnabled = false
            view.showsUserLocation = false
            view.isShowsLabels = true
            view.showsScale = true
            view.isRotateEnabled = false
            view.isRotateCameraEnabled = false
            // The SDK needs a window for annotation/control layout. Keep this
            // fixed viewport beneath the app root, outside the phone's UI layout.
            guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })?.windows.first(where: { $0.isKeyWindow }) else { return }
            view.accessibilityElementsHidden = true
            window.insertSubview(view, at: 0)
            view.layoutIfNeeded()
            renderer = coordinator
            map = view
        }
        if let map {
            renderer?.render(model, on: map)
            map.rotationDegree = CGFloat(heading ?? 0)
        }
        #endif
    }

    override init() {
        super.init()
        compass.delegate = self
        compass.headingFilter = 3
    }

    func start() {
        active = true
        foreground = UIApplication.shared.applicationState == .active
        render()
        if CLLocationManager.headingAvailable() { compass.startUpdatingHeading() }
    }

    func stop() {
        active = false
        compass.stopUpdatingHeading()
        heading = nil
        #if !targetEnvironment(simulator)
        if let map { renderer?.clear(on: map); map.delegate = nil; map.removeFromSuperview() }
        map = nil
        renderer = nil
        #endif
    }

    static func filteredHeading(previous: Double?, next: Double) -> Double {
        guard let previous else { return next }
        let delta = (next - previous + 540).truncatingRemainder(dividingBy: 360) - 180
        return (previous + delta * 0.35 + 360).truncatingRemainder(dividingBy: 360)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        let degrees = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        guard newHeading.headingAccuracy >= 0, newHeading.headingAccuracy <= 25,
              abs(newHeading.timestamp.timeIntervalSinceNow) < 3,
              degrees.isFinite, degrees >= 0, degrees < 360 else { return }
        Task { @MainActor [weak self] in
            guard let self, self.active else { return }
            let filtered = Self.filteredHeading(previous: self.heading, next: degrees)
            self.heading = filtered
            #if !targetEnvironment(simulator)
            if self.foreground, UIApplication.shared.applicationState == .active, let map = self.map {
                map.setRotationDegree(CGFloat(filtered), animated: true, duration: 0.2)
            }
            #endif
        }
    }

    func snapshot(_ completion: @escaping (Data?) -> Void) {
        guard active, foreground, UIApplication.shared.applicationState == .active else { completion(nil); return }
        render()
        #if !targetEnvironment(simulator)
        guard let map else { completion(nil); return }
        let orientation = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?.interfaceOrientation
        switch orientation {
        case .landscapeLeft: compass.headingOrientation = .landscapeLeft
        case .landscapeRight: compass.headingOrientation = .landscapeRight
        case .portraitUpsideDown: compass.headingOrientation = .portraitUpsideDown
        default: compass.headingOrientation = .portrait
        }
        map.takeSnapshot(in: map.bounds, timeoutInterval: 0.8) { image, state in
            guard state == 1, let image else { completion(nil); return }
            // Bound bandwidth and retain the entire view, including provider attribution.
            let scale = min(image.scale, 960 / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            let data = resized.jpegData(compressionQuality: 0.65)
            completion(data.flatMap { $0.count <= 180_000 ? $0 : nil })
        }
        #else
        completion(nil)
        #endif
    }
}
