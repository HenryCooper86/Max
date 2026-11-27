import AVFoundation

/// The slice of AVAudioSession the router drives, so activation decisions can
/// be tested without audio hardware.
protocol VoiceAudioSessionControlling: AnyObject {
    var category: AVAudioSession.Category { get }
    var mode: AVAudioSession.Mode { get }
    var categoryOptions: AVAudioSession.CategoryOptions { get }
    /// True when a Bluetooth hands-free (SCO/HFP) or LE device is the current input or output.
    var bluetoothRouteActive: Bool { get }
    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: VoiceAudioSessionControlling {
    var bluetoothRouteActive: Bool {
        let route = currentRoute
        let bluetoothTypes: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothLE]
        return route.outputs.contains { bluetoothTypes.contains($0.portType) }
            || route.inputs.contains { bluetoothTypes.contains($0.portType) }
    }
}

/// Configures the shared AVAudioSession for full-duplex voice and routes to an
/// in-helmet Bluetooth headset when one is connected — the iOS counterpart of
/// android/.../AudioRouter.kt. iOS does the SCO routing for us: the
/// `.playAndRecord` category with the Bluetooth hands-free (HFP) option
/// automatically prefers a connected hands-free profile device. Routing is
/// best-effort and never blocks the session.
final class AudioRouter {

    /// `.allowBluetoothHFP` by value. That name exists only in the iOS 18.2 SDK
    /// and later; the name before it, `allowBluetooth`, is deprecated — and
    /// warns — from that SDK on. The flag is 0x4 on every SDK.
    private static let bluetoothHFP = AVAudioSession.CategoryOptions(rawValue: 0x4)

    /// Music and the full-duplex voice engine must coexist. Without mixing,
    /// starting Apple Music can interrupt capture and agent speech.
    static let voiceOptions: AVAudioSession.CategoryOptions = [
        AudioRouter.bluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers
    ]

    private let session: VoiceAudioSessionControlling
    private var activated = false

    init(session: VoiceAudioSessionControlling = AVAudioSession.sharedInstance()) {
        self.session = session
    }

    /// True when a Bluetooth hands-free (SCO/HFP) device is the current input or output.
    var hasBluetoothHeadset: Bool { session.bluetoothRouteActive }

    /// Activates the voice-chat audio session. Returns true when a Bluetooth
    /// headset is handling the audio after activation.
    @discardableResult
    func startVoiceRouting() -> Bool {
        guard !activated else { return hasBluetoothHeadset }
        activated = applyVoiceConfiguration()
        return hasBluetoothHeadset
    }

    /// Re-applies the voice configuration after an interruption, a route
    /// change or a media-services reset. The category is only set again when
    /// something changed it: setting it posts a categoryChange route
    /// notification, and doing that on every route change would feed itself.
    /// Returns false while the system still refuses to activate (for example a
    /// phone call is still holding the audio).
    @discardableResult
    func reassertVoiceRouting(forceCategory: Bool = false) -> Bool {
        activated = applyVoiceConfiguration(forceCategory: forceCategory)
        return activated
    }

    /// Restores default audio routing.
    func stopVoiceRouting() {
        guard activated else { return }
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        activated = false
    }

    private func applyVoiceConfiguration(forceCategory: Bool = false) -> Bool {
        do {
            let intact = session.category == .playAndRecord
                && session.mode == .voiceChat
                && session.categoryOptions.isSuperset(of: Self.voiceOptions)
            if forceCategory || !intact {
                try session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.voiceOptions)
            }
            try session.setActive(true, options: [])
            return true
        } catch {
            return false
        }
    }
}
