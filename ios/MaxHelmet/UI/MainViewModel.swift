import SwiftUI
import Combine

/// Bridges the process-wide AgentSession and rider preferences to the SwiftUI HUD.
/// The iOS counterpart of android/.../ui/MainViewModel.kt.
final class MainViewModel: ObservableObject {

    /// On the iOS Simulator, `localhost` reaches the host machine where the relay
    /// listens on :8787. On a physical device, `localhost` is the phone itself, so
    /// default to the shared AWS Lightsail test relay (self-signed wss://) instead.
    /// Either default can be overridden in the HUD's 语音中继地址 field.
    static let defaultRelayURL: String = {
        #if targetEnvironment(simulator)
        return "ws://localhost:8787/agent"
        #else
        return "wss://3.35.135.136/agent"
        #endif
    }()

    /// The Lightsail test relay terminates TLS with a self-signed certificate, so a
    /// physical device must opt into trusting it on first launch; the simulator talks
    /// plain ws:// to localhost and needs no exception.
    static let defaultAllowSelfSigned: Bool = {
        #if targetEnvironment(simulator)
        return false
        #else
        return true
        #endif
    }()

    private enum Keys {
        static let relayURL = "relay_url"
        static let allowSelfSigned = "allow_self_signed"
        static let devMode = "dev_mode"
    }

    let session = AgentSession.shared
    private let defaults = UserDefaults.standard

    @Published var relayURL: String {
        didSet { defaults.set(relayURL, forKey: Keys.relayURL) }
    }

    /// Trust the test relay's self-signed certificate for wss:// (prototype only).
    @Published var allowSelfSigned: Bool {
        didSet { defaults.set(allowSelfSigned, forKey: Keys.allowSelfSigned) }
    }

    /// A transcript export ready to share. Wrapping the URL keeps it usable with
    /// SwiftUI's `.sheet(item:)` without a retroactive Identifiable conformance.
    struct ExportFile: Identifiable {
        let id = UUID()
        let url: URL
    }

    /// Set when the rider exports the transcript; the view presents a share sheet.
    @Published var exportFile: ExportFile?

    /// Developer mode reveals the test settings (relay URL, self-signed trust,
    /// demo scenarios, telemetry, raw status, log export). Toggled by
    /// long-pressing the Max logo; persisted so demos survive relaunch.
    @Published var devMode: Bool {
        didSet { defaults.set(devMode, forKey: Keys.devMode) }
    }

    /// Rider preferences panel (voice / tone / ride mode), toggled by the gear.
    @Published var showPreferences = false

    /// Captions overlay under the orb. Off by default for the clean voice-mode
    /// look; toggled by the 字幕 button (like ChatGPT's optional captions).
    @Published var showCaptions = false

    /// Developer panel sheet, opened from the wrench (only shown when devMode is on).
    @Published var showDevPanel = false

    init() {
        relayURL = defaults.string(forKey: Keys.relayURL) ?? Self.defaultRelayURL
        allowSelfSigned = defaults.object(forKey: Keys.allowSelfSigned) as? Bool ?? Self.defaultAllowSelfSigned
        devMode = defaults.bool(forKey: Keys.devMode)
    }

    func toggleDevMode() {
        devMode.toggle()
    }

    /// One toggle, like the web HUD's 开启免提 / 结束免提 button. On iOS, microphone
    /// (and best-effort location) permission prompts are surfaced by the system on
    /// first use; background audio keeps the session alive when backgrounded.
    func toggleHandsFree() {
        if session.state.handsFree {
            session.stop()
        } else {
            session.start(url: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
                          allowSelfSignedTls: allowSelfSigned)
        }
    }

    /// Mutes/unmutes the mic mid-session (bottom mute control).
    func toggleMute() { session.toggleMute() }

    func setVoiceGender(_ gender: VoiceGender) { session.setVoiceGender(gender) }
    func setVoicePersonality(_ personality: VoicePersonality) { session.setVoicePersonality(personality) }
    func setRideMode(_ mode: RideMode) { session.setRideMode(mode) }
    func setScenario(_ scenario: DemoScenario) { session.setScenario(scenario) }

    /// Exports the conversation log as JSON to a temp file and triggers the share
    /// sheet — the iOS counterpart of exportTranscriptLog's file download.
    func exportTranscript() {
        let transcript = session.state.transcript
        guard !transcript.isEmpty else { return }

        let json = session.buildTranscriptExport()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let stamp = formatter.string(from: Date())

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("max-session-log-\(stamp).json")
        do {
            try json.data(using: .utf8)?.write(to: file)
            exportFile = ExportFile(url: file)
        } catch {
            // Best-effort; nothing to share on failure.
        }
    }
}
