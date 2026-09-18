import CoreLocation
import UIKit

/// Uses the existing, consented map view, including its labels and attribution.
/// Never creates a second location or map provider session.
@MainActor
final class HUDMapSource: NSObject, CLLocationManagerDelegate {
    static let shared = HUDMapSource()
    private let compass = CLLocationManager()
    private var heading: Double?
    private var active = false
    #if !targetEnvironment(simulator)
    private let maps = NSHashTable<MAMapView>.weakObjects()
    func register(_ map: MAMapView) { maps.add(map) }
    func unregister(_ map: MAMapView) { maps.remove(map) }
    #endif

    override init() {
        super.init()
        compass.delegate = self
        compass.headingFilter = 3
    }

    func start() {
        active = true
        if CLLocationManager.headingAvailable() { compass.startUpdatingHeading() }
    }

    func stop() {
        active = false
        compass.stopUpdatingHeading()
        heading = nil
        #if !targetEnvironment(simulator)
        for map in maps.allObjects { map.rotationDegree = 0 }
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
            for map in self.maps.allObjects where map.window != nil {
                map.setRotationDegree(CGFloat(filtered), animated: true, duration: 0.2)
            }
            #endif
        }
    }

    func snapshot(_ completion: @escaping (Data?) -> Void) {
        guard active else { completion(nil); return }
        #if !targetEnvironment(simulator)
        // Prefer the large navigation-details map over the underlying card.
        guard let map = maps.allObjects.filter({ !$0.isHidden && $0.window != nil && $0.bounds.width > 10 && $0.bounds.height > 10 })
            .max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
            completion(nil); return
        }
        switch map.window?.windowScene?.interfaceOrientation {
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
