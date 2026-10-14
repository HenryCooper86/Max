import AVFoundation

/// Configures the shared AVAudioSession for full-duplex voice and routes to an
/// in-helmet Bluetooth headset when one is connected — the iOS counterpart of
/// android/.../AudioRouter.kt. iOS does the SCO routing for us: the
/// `.playAndRecord` category with `.allowBluetooth` automatically prefers a
/// connected hands-free profile (HFP) device. Routing is best-effort and never
/// blocks the session.
final class AudioRouter {

    /// Music and the full-duplex voice engine must coexist. Without mixing,
    /// starting Apple Music can interrupt capture and agent speech.
    static let voiceOptions: AVAudioSession.CategoryOptions = [
        // The HFP flag's original name also compiles with pre-iOS-26 SDKs.
        .allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers
    ]

    private let session = AVAudioSession.sharedInstance()
    private var activated = false

    /// True when a Bluetooth hands-free (SCO/HFP) device is the current input or output.
    var hasBluetoothHeadset: Bool {
        let route = session.currentRoute
        let bluetoothTypes: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothLE]
        let outputs = route.outputs.contains { bluetoothTypes.contains($0.portType) }
        let inputs = route.inputs.contains { bluetoothTypes.contains($0.portType) }
        return outputs || inputs
    }

    /// Activates the voice-chat audio session. Returns true when a Bluetooth
    /// headset is handling the audio after activation.
    @discardableResult
    func startVoiceRouting() -> Bool {
        guard !activated else { return hasBluetoothHeadset }
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: Self.voiceOptions
            )
            try session.setActive(true, options: [])
            activated = true
        } catch {
            activated = false
        }
        return hasBluetoothHeadset
    }

    /// Restores default audio routing.
    func stopVoiceRouting() {
        guard activated else { return }
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        activated = false
    }
}
