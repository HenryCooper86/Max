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
        static let authToken = "auth_token"
        static let sessionToken = "auth_session_token"
        static let authUsername = "auth_username"
        static let authDisplayName = "auth_display_name"
        static let authRole = "auth_role"
        static let allowSelfSigned = "allow_self_signed"
        static let devMode = "dev_mode"
    }

    let session = AgentSession.shared
    private let defaults = UserDefaults.standard
    private let authClient = AuthClient()

    @Published var relayURL: String {
        didSet { defaults.set(relayURL, forKey: Keys.relayURL) }
    }

    /// Optional shared auth token for the relay; appended to the /agent URL as
    /// `?token=…` when non-empty. Empty means the relay requires no token.
    @Published var authToken: String {
        didSet { defaults.set(authToken, forKey: Keys.authToken) }
    }

    /// Trust the test relay's self-signed certificate for wss:// (prototype only).
    @Published var allowSelfSigned: Bool {
        didSet { defaults.set(allowSelfSigned, forKey: Keys.allowSelfSigned) }
    }

    /// The login session token, stored SEPARATELY from the manual 认证令牌
    /// field so signing in/out never destroys a pasted operator relay token.
    @Published var sessionToken: String {
        didSet { defaults.set(sessionToken, forKey: Keys.sessionToken) }
    }

    /// What the WebSocket presents: the login session first (a dead one is
    /// cleared on 401 by handleAuthRequired, so it can't shadow a valid manual
    /// token for long), the manual field as fallback.
    var effectiveToken: String {
        let session = sessionToken.trimmingCharacters(in: .whitespacesAndNewlines)
        return session.isEmpty ? authToken.trimmingCharacters(in: .whitespacesAndNewlines) : session
    }

    /// Set when a 401 interrupted hands-free; a successful login then restarts
    /// the session automatically instead of demanding another helmet tap.
    private var pendingHandsFreeRetry = false

    // The signed-in account (empty when signed out). Persisted so the identity
    // row survives relaunches, like the web HUD's stored session.
    @Published var authUsername: String {
        didSet { defaults.set(authUsername, forKey: Keys.authUsername) }
    }
    @Published var authDisplayName: String {
        didSet { defaults.set(authDisplayName, forKey: Keys.authDisplayName) }
    }
    @Published var authRole: String {
        didSet { defaults.set(authRole, forKey: Keys.authRole) }
    }
    @Published var loginBusy = false
    @Published var loginError: String?

    var isLoggedIn: Bool { !authUsername.isEmpty && !sessionToken.isEmpty }

    /// A 401 from the relay: the session (if any) is dead — drop the stale
    /// identity so the login form shows, consume the flag, and open settings
    /// on the 账号 section. Called by the screen when authRequired flips on.
    func handleAuthRequired() {
        session.acknowledgeAuthRequired()
        if isLoggedIn {
            sessionToken = ""
            authUsername = ""
            authDisplayName = ""
            authRole = ""
        }
        pendingHandsFreeRetry = true
        showPreferences = true
    }

    /// POST /auth/login against the configured relay; on success the session
    /// token lands in `authToken`, so the WebSocket connect just works.
    func login(username: String, password: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !password.isEmpty else {
            loginError = "请输入用户名和密码"
            return
        }
        loginBusy = true
        loginError = nil
        authClient.login(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            username: name,
            password: password,
            allowSelfSignedTls: allowSelfSigned
        ) { [weak self] result in
            guard let self else { return }
            self.loginBusy = false
            switch result {
            case .success(let login):
                self.sessionToken = login.token
                self.authUsername = login.user.username
                self.authDisplayName = login.user.displayName
                self.authRole = login.user.role
                self.loginError = nil
                // A 401 cut the last attempt short — resume hands-free with
                // the fresh session instead of demanding another tap.
                if self.pendingHandsFreeRetry, !self.session.state.handsFree {
                    self.pendingHandsFreeRetry = false
                    self.toggleHandsFree()
                }
            case .failure(let failure):
                self.loginError = failure.message
            }
        }
    }

    /// Invalidates the session on the relay (best-effort) and drops the local
    /// identity + token. An active hands-free session is stopped — the login
    /// that authorized it just ended.
    func logout() {
        authClient.logout(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            token: sessionToken,
            allowSelfSignedTls: allowSelfSigned
        )
        sessionToken = ""
        authUsername = ""
        authDisplayName = ""
        authRole = ""
        loginError = nil
        pendingHandsFreeRetry = false
        if session.state.handsFree { session.stop() }
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
        authToken = defaults.string(forKey: Keys.authToken) ?? ""
        sessionToken = defaults.string(forKey: Keys.sessionToken) ?? ""
        authUsername = defaults.string(forKey: Keys.authUsername) ?? ""
        authDisplayName = defaults.string(forKey: Keys.authDisplayName) ?? ""
        authRole = defaults.string(forKey: Keys.authRole) ?? ""
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
            pendingHandsFreeRetry = false
            session.start(url: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
                          authToken: effectiveToken,
                          allowSelfSignedTls: allowSelfSigned,
                          testerId: authUsername.isEmpty ? "ios-native" : authUsername)
        }
    }

    /// Mutes/unmutes the mic mid-session (bottom mute control).
    func toggleMute() { session.toggleMute() }

    /// Empties the conversation log and its persisted copy (设置 → 诊断 → 清空).
    func clearTranscript() { session.clearTranscript() }

    /// Tester flags a bad turn in the captions overlay (字幕 → 有问题?).
    func flagTurn(_ item: TranscriptItem, reason: String) {
        session.sendTurnFeedback(item: item, reason: reason)
    }

    func setVoiceGender(_ gender: VoiceGender) { session.setVoiceGender(gender) }
    func setVoicePersonality(_ personality: VoicePersonality) { session.setVoicePersonality(personality) }
    func setRideMode(_ mode: RideMode) { session.setRideMode(mode) }
    func setScenario(_ scenario: DemoScenario) { session.setScenario(scenario) }
    func setGuidedDemo(_ enabled: Bool) { session.setGuidedDemo(enabled) }

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
