import SwiftUI
import Combine

/// Bridges the process-wide AgentSession and rider preferences to the SwiftUI HUD.
/// The iOS counterpart of android/.../ui/MainViewModel.kt.
final class MainViewModel: ObservableObject {

    /// On the iOS Simulator, `localhost` reaches the host machine where the relay
    /// listens on :8787. On a physical device, replace the host with the dev
    /// machine's LAN IP or the wss:// test server.
    static let defaultRelayURL = "ws://localhost:8787/agent"

    private enum Keys {
        static let relayURL = "relay_url"
        static let allowSelfSigned = "allow_self_signed"
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

    init() {
        relayURL = defaults.string(forKey: Keys.relayURL) ?? Self.defaultRelayURL
        allowSelfSigned = defaults.bool(forKey: Keys.allowSelfSigned)
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
