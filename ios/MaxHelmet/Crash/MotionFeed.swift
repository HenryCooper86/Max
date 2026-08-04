import CoreMotion
import Foundation

protocol MotionStreaming: AnyObject {
    var onSample: ((CrashSample) -> Void)? { get set }
    func start()
    func stop()
}

/// Thin CoreMotion adapter: ~100 Hz device motion while a session is live.
/// No decisions here — magnitudes go straight into CrashEngine.
final class SystemMotionFeed: MotionStreaming {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private let speedProvider: () -> Double?
    var onSample: ((CrashSample) -> Void)?

    init(speedProvider: @escaping () -> Double?) {
        self.speedProvider = speedProvider
        queue.maxConcurrentOperationCount = 1
    }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 100.0
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self, let m = motion else { return }
            let a = m.userAcceleration
            let r = m.rotationRate
            let sample = CrashSample(
                t: m.timestamp,
                accelG: (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot(),
                rotationRadS: (r.x * r.x + r.y * r.y + r.z * r.z).squareRoot(),
                speedKmh: self.speedProvider()
            )
            DispatchQueue.main.async { self.onSample?(sample) }
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }
}
