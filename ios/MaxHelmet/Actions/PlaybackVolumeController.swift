import Foundation

/// Max's own playback gain. Deliberately not system volume: iOS has no public
/// API to set that, and "Max，大声一点" means Max's voice, not the phone's.
protocol PlaybackGain {
    var level: Float { get }
    func setLevel(_ level: Float)
}

struct PlaybackVolumeController: DeviceActionHandler {
    /// PcmPlayer's shipped gain is 2.0, so the range must straddle it — a
    /// maximum of 2.0 would leave "大声一点" with nowhere to go. The soft
    /// limiter downstream keeps 4.0 from clipping at the helmet speaker.
    static let minimumLevel: Float = 0.5
    static let maximumLevel: Float = 4.0
    static let step: Float = 0.5

    private let gain: PlaybackGain

    init(gain: PlaybackGain) {
        self.gain = gain
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .volumeSet(direction) = action else { return .unsupported("action.mismatch") }
        let delta = direction == .up ? Self.step : -Self.step
        let next = min(Self.maximumLevel, max(Self.minimumLevel, gain.level + delta))
        gain.setLevel(next)
        return .ok
    }
}
