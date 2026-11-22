import Foundation

// On a hot day a phone in a handlebar mount, screen on, navigating and filming,
// can throttle and then shut itself down, and crash detection goes with it.
// The camera is the one big heat source the app controls, so it is what gives
// way first. The voice session and crash detection are never shed here.

enum DeviceHeat: Int, Comparable {
    case nominal, fair, serious, critical

    init(_ state: ProcessInfo.ThermalState) {
        switch state {
        case .nominal: self = .nominal
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        @unknown default: self = .serious
        }
    }

    static func < (lhs: DeviceHeat, rhs: DeviceHeat) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// Why a piece of camera work is refused; the raw value is the device.result
/// reason the relay turns into speech.
enum CaptureRefusal: String, Equatable {
    case hot = "device.hot"
    case lowPower = "device.powerSave"

    var reason: String { rawValue }

    /// Sent as `denied`, like `unsafe.speed`: the phone chose not to, nothing
    /// broke. Shared with the Android app.
    var result: DeviceActionResult { .denied(reason) }
}

/// What camera work the phone can afford right now. nil means allowed.
struct CapturePolicy: Equatable {
    var videoRecording: CaptureRefusal?
    var photo: CaptureRefusal?
    /// Frame extraction for gallery.describe (up to eight full decodes).
    var visionFrames: CaptureRefusal?
    /// Turning on the torch or starting music (play, next, previous).
    var extras: CaptureRefusal?
    /// Critical heat: also stop decorative work such as HUD animation.
    var shedNonEssential = false

    static let unrestricted = CapturePolicy()
}

/// Serious heat stops the sustained load (video, multi-frame decoding) but
/// keeps a one-shot photo; critical heat stops every camera use. Low Power
/// Mode is the rider asking for less drain, so it only refuses new video.
func capturePolicy(heat: DeviceHeat, lowPowerMode: Bool) -> CapturePolicy {
    switch heat {
    case .critical:
        return CapturePolicy(videoRecording: .hot, photo: .hot, visionFrames: .hot, extras: .hot, shedNonEssential: true)
    case .serious:
        return CapturePolicy(videoRecording: .hot, photo: nil, visionFrames: .hot)
    case .nominal, .fair:
        return lowPowerMode ? CapturePolicy(videoRecording: .lowPower) : .unrestricted
    }
}

enum ThermalAnnouncement: Equatable {
    case hot, critical, cooled, lowPower

    var messageKey: String {
        switch self {
        case .hot: return "thermal.hot"
        case .critical: return "thermal.critical"
        case .cooled: return "thermal.cooled"
        case .lowPower: return "thermal.lowPower"
        }
    }

    /// Spoken lines interrupt the ride, so only the warnings that change what
    /// Max can do are spoken; the rest go to the HUD.
    var spoken: Bool { self == .hot || self == .critical }
}

/// The torch and music refusals the Android app applies (DeviceLoad's
/// loadRefusal), for the actions that exist on iOS. Camera and gallery work is
/// refused by their own handlers. Turning the torch off and pausing music are
/// never refused: they are how load is shed.
func loadRefusal(for action: DeviceAction, policy: CapturePolicy) -> DeviceActionResult? {
    guard let refusal = policy.extras else { return nil }
    switch action {
    case let .torchSet(on) where on:
        return refusal.result
    case let .musicControl(control, _) where control != .pause:
        return refusal.result
    default:
        return nil
    }
}

@MainActor
protocol OwnMusicStopping: AnyObject {
    /// Stops music Max itself is playing; leaves other apps' music alone.
    func stopOwnPlayback()
}

@MainActor
protocol HUDCastStopping: AnyObject {
    func stop()
}

/// Entering critical heat sheds what the Android app sheds (shedLoad): the
/// torch goes off, music Max started stops, and HUD casting stops. Voice,
/// crash detection and guidance keep running.
@MainActor
func shedExtrasForHeat(_ policy: CapturePolicy, torch: TorchCapableDevice, music: OwnMusicStopping, hudCast: HUDCastStopping) {
    guard policy.extras != nil else { return }
    music.stopOwnPlayback()
    hudCast.stop()
    if torch.hasTorch { try? torch.setTorch(on: false) }
}

@MainActor
protocol ThermalStateSource: AnyObject {
    var heat: DeviceHeat { get }
    var lowPowerMode: Bool { get }
    func start(_ onChange: @escaping @MainActor () -> Void)
    func stop()
}

/// ProcessInfo's thermal state and Low Power Mode. Both notifications arrive on
/// arbitrary threads; changes are delivered on main.
final class SystemThermalStateSource: ThermalStateSource {
    private let processInfo: ProcessInfo
    private let center: NotificationCenter
    private var observers: [NSObjectProtocol] = []

    init(processInfo: ProcessInfo = .processInfo, center: NotificationCenter = .default) {
        self.processInfo = processInfo
        self.center = center
    }

    var heat: DeviceHeat { DeviceHeat(processInfo.thermalState) }
    var lowPowerMode: Bool { processInfo.isLowPowerModeEnabled }

    func start(_ onChange: @escaping @MainActor () -> Void) {
        stop()
        observers = [ProcessInfo.thermalStateDidChangeNotification, .NSProcessInfoPowerStateDidChange].map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { onChange() }
            }
        }
    }

    func stop() {
        observers.forEach(center.removeObserver)
        observers.removeAll()
    }
}

/// Lets the gallery handler, which runs off the main actor, read the current
/// policy without hopping threads.
final class CapturePolicyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var current = CapturePolicy.unrestricted

    var value: CapturePolicy {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
}

@MainActor
final class ThermalGovernor {
    /// The same warning is not repeated within this long: iOS's thermal state
    /// can hover at a boundary, and a rider told twice a minute stops listening.
    static let quietPeriod: TimeInterval = 300

    private(set) var policy = CapturePolicy.unrestricted
    let snapshot = CapturePolicyBox()
    var onPolicyChange: ((CapturePolicy) -> Void)?
    var onAnnouncement: ((ThermalAnnouncement) -> Void)?

    private let source: ThermalStateSource
    private let now: () -> TimeInterval
    private var heat: DeviceHeat = .nominal
    private var lowPowerMode = false
    private var lastAnnounced: [ThermalAnnouncement: TimeInterval] = [:]
    /// Whether the rider was told about the current hot spell, so "cooled down"
    /// is only said after a warning they actually heard.
    private var warnedThisSpell = false

    init(source: ThermalStateSource, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.source = source
        self.now = now
    }

    func start() {
        source.start { [weak self] in self?.refresh() }
        refresh()
    }

    func stop() {
        source.stop()
    }

    private func refresh() {
        let newHeat = source.heat
        let newLowPower = source.lowPowerMode
        let oldHeat = heat
        let oldLowPower = lowPowerMode
        heat = newHeat
        lowPowerMode = newLowPower

        if newHeat == .critical && oldHeat < .critical {
            announce(.critical)
        } else if newHeat == .serious && oldHeat < .serious {
            announce(.hot)
        } else if newHeat < .serious && oldHeat >= .serious {
            if warnedThisSpell { onAnnouncement?(.cooled) }
            warnedThisSpell = false
        }
        if newLowPower && !oldLowPower && newHeat < .serious {
            announce(.lowPower)
        }

        let newPolicy = capturePolicy(heat: newHeat, lowPowerMode: newLowPower)
        guard newPolicy != policy else { return }
        policy = newPolicy
        snapshot.value = newPolicy
        onPolicyChange?(newPolicy)
    }

    private func announce(_ announcement: ThermalAnnouncement) {
        let time = now()
        if let last = lastAnnounced[announcement], time - last < Self.quietPeriod { return }
        lastAnnounced[announcement] = time
        if announcement == .hot || announcement == .critical { warnedThisSpell = true }
        onAnnouncement?(announcement)
    }
}
