import SwiftUI
import Combine
import CoreLocation

protocol CompanionClientControlling: AnyObject {
    var onState: ((CompanionConnectionState) -> Void)? { get set }
    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool)
    func pair(code: String)
    func pairDiscover(token: String)
    func startRide()
    func stopRide()
    func stopRide(completion: @escaping (CompanionActionResult) -> Void)
    func unpair()
    func unpair(completion: @escaping (CompanionActionResult) -> Void)
    func sendLatest(_ fix: CompanionFix)
    func disconnect()
}

extension RDKCompanionClient: CompanionClientControlling {}

protocol CompanionLocationStreaming: AnyObject {
    var onFix: ((CLLocation) -> Void)? { get set }
    var onPermission: ((CompanionLocationPermission) -> Void)? { get set }
    func startFromForeground() -> Bool
    func stop()
}

extension CompanionLocationStream: CompanionLocationStreaming {}

struct MainViewModelVoiceActions {
    let acknowledgeAuthRequired: () -> Void
    let selectTranscriptOwner: (String?) -> Void
    let isHandsFree: () -> Bool
    let stop: () -> Void
}

/// Bridges the process-wide AgentSession and rider preferences to the SwiftUI HUD.
/// The iOS counterpart of android/.../ui/MainViewModel.kt.
final class MainViewModel: ObservableObject {
    private enum PendingUnpairPhase: Equatable {
        case stoppingLocation
        case stoppingCompanion
        case sendingUnpair
    }

    private enum RideTeardownPhase {
        case stoppingLocation
        case stoppingCompanion
    }

    private struct CompanionStatePublication {
        let ticket: Int
        let epoch: Int
        let state: CompanionConnectionState
        let publishesValue: Bool
        let completion: () -> Void
    }

    private struct CompanionTerminalAuthority {
        let epoch: Int
    }

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

    /// Debug device builds can opt into the self-signed test relay. Release builds
    /// always use normal platform certificate and hostname validation.
    static let defaultAllowSelfSigned: Bool = {
        #if DEBUG && !targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }()

    private enum Keys {
        static let relayURL = "relay_url"
        static let authToken = "auth_token"
        static let sessionToken = "auth_session_token"
        static let authUserId = "auth_user_id"
        static let authUsername = "auth_username"
        static let authDisplayName = "auth_display_name"
        static let authRole = "auth_role"
        static let allowSelfSigned = "allow_self_signed"
        static let devMode = "dev_mode"
        static let testingCampaignId = "testing_campaign_id"
        static let testingTestCaseId = "testing_test_case_id"
        static let testingRunId = "testing_run_id"
        static let testingAssignmentId = "testing_assignment_id"
        static let crashContact = "crash_contact_number"   // SecureTokenStore account, not a defaults key
        static let crashRelayOptIn = "crash_relay_opt_in"
        static let crashCallTarget = "crash_call_target"
        static let crashLogOnly = "crash_log_only"
    }

    let session = AgentSession.shared
    private let defaults: UserDefaults
    private let authClient: AuthClient?
    private let authLogout: (String, String, Bool) -> Void
    private let persistSecret: (String, String) -> Void
    private let companionClient: CompanionClientControlling
    private let locationStream: CompanionLocationStreaming
    private let helmetDiscovery: HelmetDiscovering
    private let monotonicNow: () -> TimeInterval
    private let wallClock: () -> Date
    private let schedule: (@escaping () -> Void, TimeInterval) -> Void
    private let voiceActions: MainViewModelVoiceActions

    private var companionGeneration = 0
    private var rideOwned = false
    private var fixThrottle = CompanionFixThrottle()
    private var lastThrottleEmissionTime: TimeInterval?
    private var nextFlushTicket = 0
    private var scheduledFlushTicket: Int?
    private var rideTeardownDepth = 0
    private var rideTeardownOwner: Int?
    private var rideTeardownPhase: RideTeardownPhase?
    private var pendingHelmetRideStart = false
    private var sessionTokenTransitionActive = false
    private var pendingSessionTokenIntent: String?
    private var drainingSessionTokenTransition = false
    private var companionAccountTeardownActive = false
    private var companionAccountStopOwner: Int?
    private var logoutRequestActive = false
    private var logoutRequestRelayURL = ""
    private var logoutRequestToken = ""
    private var logoutRequestAllowsSelfSigned = false
    /// A rider-initiated pair (manual code or discovery tap) is awaiting its
    /// outcome; used to consume the typed code only on a real binding.
    private var pairingSubmissionActive = false
    private var pendingUnpairOwner: Int?
    private var pendingUnpairSendOwner: Int?
    private var pendingUnpairPhase: PendingUnpairPhase?
    private var companionStatePublicationEpoch = 0
    private var nextCompanionStatePublicationTicket = 0
    private var newestCompanionStatePublicationTicket = 0
    private var companionStatePublicationActive = false
    private var companionStateAssignmentInProgress: CompanionConnectionState?
    private var pendingCompanionStatePublications: [CompanionStatePublication] = []
    private var companionTerminalAuthority: CompanionTerminalAuthority?
    private var authoritativeCompanionState: CompanionConnectionState = .signedOut

    /// Presents the Max gallery sheet.
    @Published var showGallery = false

    /// Reads the same capture store the camera handler writes to.
    lazy var galleryModel = GalleryModel(
        store: session.captureStore,
        exporter: SystemPhotoLibraryExporter()
    )

    @Published var relayURL: String {
        didSet { defaults.set(relayURL, forKey: Keys.relayURL) }
    }

    /// Optional shared auth token for the relay; appended to the /agent URL as
    /// `?token=…` when non-empty. Empty means the relay requires no token.
    @Published var authToken: String {
        didSet { persistSecret(Keys.authToken, authToken) }
    }

    /// Trust the test relay's self-signed certificate for wss:// (prototype only).
    @Published var allowSelfSigned: Bool {
        didSet { defaults.set(allowSelfSigned, forKey: Keys.allowSelfSigned) }
    }

    /// The login session token, stored SEPARATELY from the manual 认证令牌
    /// field so signing in/out never destroys a pasted operator relay token.
    @Published private var committedSessionToken: String
    var sessionToken: String {
        get { committedSessionToken }
        set { transitionSessionToken(to: newValue) }
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
    @Published var authUserId: String {
        didSet { defaults.set(authUserId, forKey: Keys.authUserId) }
    }
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

    @Published var testingCampaignId: String {
        didSet { defaults.set(testingCampaignId, forKey: Keys.testingCampaignId) }
    }
    @Published var testingTestCaseId: String {
        didSet { defaults.set(testingTestCaseId, forKey: Keys.testingTestCaseId) }
    }
    @Published var testingRunId: String {
        didSet { defaults.set(testingRunId, forKey: Keys.testingRunId) }
    }
    @Published var testingAssignmentId: String {
        didSet { defaults.set(testingAssignmentId, forKey: Keys.testingAssignmentId) }
    }

    /// Emergency contact number (or name — resolved via Contacts, see
    /// `resolveCrashContactIfNeeded`). Quasi-secret, so it lives in the
    /// Keychain via `SecureTokenStore`, not UserDefaults.
    @Published var crashContactNumber: String {
        didSet { persistSecret(Keys.crashContact, crashContactNumber) }
    }
    /// Off by default — the rider must explicitly opt in to sending the
    /// contact's number to the relay on an escalated crash.
    @Published var crashRelayOptIn: Bool {
        didSet { defaults.set(crashRelayOptIn, forKey: Keys.crashRelayOptIn) }
    }
    /// Who the crash alarm view dials: `"contact"` or `"120"`.
    @Published var crashCallTarget: String {
        didSet { defaults.set(crashCallTarget, forKey: Keys.crashCallTarget) }
    }
    /// Detect and log crash candidates without alarming or escalating —
    /// for collecting false-positive data.
    @Published var crashLogOnly: Bool {
        didSet { defaults.set(crashLogOnly, forKey: Keys.crashLogOnly) }
    }

    @Published private(set) var companionState: CompanionConnectionState = .signedOut
    @Published private(set) var helmetRideActive = false
    @Published private(set) var companionPermission: CompanionLocationPermission = .notDetermined
    @Published private(set) var lastForwardedAt: Date?
    @Published var pairCode = ""
    /// True while a discovery-pair token has been sent and the rider is
    /// waiting on the helmet's spoken 确认 (or a pair.* error/timeout).
    @Published private(set) var isAwaitingHelmetConfirm = false
    /// Helmets currently visible on the local network, refreshed by
    /// `helmetDiscovery` while the pairing section is on screen.
    @Published private(set) var discoveredHelmets: [DiscoveredHelmet] = []

    var helmetRideOwned: Bool { rideOwned }

    var isLoggedIn: Bool {
        !authUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sessionToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A 401 from the relay: the session (if any) is dead — drop the stale
    /// identity so the login form shows, consume the flag, and open settings
    /// on the 账号 section. Called by the screen when authRequired flips on.
    func handleAuthRequired() {
        voiceActions.acknowledgeAuthRequired()
        endCompanionAccountSession()
        if isLoggedIn {
            sessionToken = ""
            authUserId = ""
            authUsername = ""
            authDisplayName = ""
            authRole = ""
        }
        voiceActions.selectTranscriptOwner(nil)
        pendingHandsFreeRetry = true
        showPreferences = true
    }

    /// POST /auth/login against the configured relay; on success the account
    /// token lands in `sessionToken`, separate from the manual operator token.
    func login(username: String, password: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !password.isEmpty else {
            loginError = "请输入用户名和密码"
            return
        }
        guard let authClient else {
            loginError = "登录服务不可用"
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
                self.authUserId = login.user.id
                self.authUsername = login.user.username
                self.authDisplayName = login.user.displayName
                self.authRole = login.user.role
                self.voiceActions.selectTranscriptOwner(login.user.id)
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
        guard !logoutRequestActive else { return }
        guard isLoggedIn || ownsCompanionAccountSession else { return }
        logoutRequestActive = true
        logoutRequestRelayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        logoutRequestToken = sessionToken.trimmingCharacters(in: .whitespacesAndNewlines)
        logoutRequestAllowsSelfSigned = allowSelfSigned
        endCompanionAccountSession()
        if !companionAccountTeardownActive {
            finalizePendingLogout()
        }
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

    convenience init() {
        let defaults = UserDefaults.standard
        let authClient = AuthClient()
        let session = AgentSession.shared
        self.init(
            defaults: defaults,
            initialAuthToken: SecureTokenStore.migrate(account: Keys.authToken, defaults: defaults),
            initialSessionToken: SecureTokenStore.migrate(account: Keys.sessionToken, defaults: defaults),
            initialCrashContactNumber: SecureTokenStore.read(account: Keys.crashContact) ?? "",
            companionClient: RDKCompanionClient(),
            locationStream: CompanionLocationStream(),
            helmetDiscovery: BonjourHelmetDiscovery(),
            authClient: authClient,
            authLogout: { relayURL, token, allowSelfSigned in
                authClient.logout(relayURL: relayURL, token: token, allowSelfSignedTls: allowSelfSigned)
            },
            persistSecret: { account, value in SecureTokenStore.write(value, account: account) },
            monotonicNow: { ProcessInfo.processInfo.systemUptime },
            wallClock: Date.init,
            schedule: { callback, delay in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: callback)
            },
            voiceActions: MainViewModelVoiceActions(
                acknowledgeAuthRequired: { session.acknowledgeAuthRequired() },
                selectTranscriptOwner: { session.selectTranscriptOwner($0) },
                isHandsFree: { session.state.handsFree },
                stop: { session.stop() }
            )
        )
    }

    init(
        defaults: UserDefaults,
        initialAuthToken: String,
        initialSessionToken: String,
        initialCrashContactNumber: String = "",
        companionClient: CompanionClientControlling,
        locationStream: CompanionLocationStreaming,
        helmetDiscovery: HelmetDiscovering = BonjourHelmetDiscovery(),
        authClient: AuthClient? = nil,
        authLogout: @escaping (String, String, Bool) -> Void,
        persistSecret: @escaping (String, String) -> Void,
        monotonicNow: @escaping () -> TimeInterval,
        wallClock: @escaping () -> Date,
        schedule: @escaping (@escaping () -> Void, TimeInterval) -> Void,
        voiceActions: MainViewModelVoiceActions
    ) {
        self.defaults = defaults
        self.authClient = authClient
        self.authLogout = authLogout
        self.persistSecret = persistSecret
        self.companionClient = companionClient
        self.locationStream = locationStream
        self.helmetDiscovery = helmetDiscovery
        self.monotonicNow = monotonicNow
        self.wallClock = wallClock
        self.schedule = schedule
        self.voiceActions = voiceActions

        relayURL = defaults.string(forKey: Keys.relayURL) ?? Self.defaultRelayURL
        authToken = initialAuthToken
        committedSessionToken = initialSessionToken
        authUserId = defaults.string(forKey: Keys.authUserId) ?? ""
        authUsername = defaults.string(forKey: Keys.authUsername) ?? ""
        authDisplayName = defaults.string(forKey: Keys.authDisplayName) ?? ""
        authRole = defaults.string(forKey: Keys.authRole) ?? ""
        #if DEBUG
        allowSelfSigned = defaults.object(forKey: Keys.allowSelfSigned) as? Bool ?? Self.defaultAllowSelfSigned
        #else
        allowSelfSigned = false
        #endif
        devMode = defaults.bool(forKey: Keys.devMode)
        testingCampaignId = defaults.string(forKey: Keys.testingCampaignId) ?? "release-readiness"
        testingTestCaseId = defaults.string(forKey: Keys.testingTestCaseId) ?? "baseline-live-session"
        testingRunId = defaults.string(forKey: Keys.testingRunId) ?? ""
        testingAssignmentId = defaults.string(forKey: Keys.testingAssignmentId) ?? ""
        crashContactNumber = initialCrashContactNumber
        crashRelayOptIn = defaults.bool(forKey: Keys.crashRelayOptIn)          // default OFF — the privacy carve-out is opt-in
        crashCallTarget = defaults.string(forKey: Keys.crashCallTarget) ?? "120"
        crashLogOnly = defaults.bool(forKey: Keys.crashLogOnly)
        voiceActions.selectTranscriptOwner(isLoggedIn && !authUserId.isEmpty ? authUserId : nil)

        bindCompanionState(owner: companionGeneration)

        self.helmetDiscovery.onUpdate = { [weak self] helmets in
            self?.onMain { [weak self] in self?.discoveredHelmets = helmets }
        }

        session.crashSettingsProvider = { [weak self] in
            guard let self else { return CrashSettings(contactNumber: nil, relayOptIn: false, callTarget: "120", logOnly: false) }
            let number = self.crashContactNumber.trimmingCharacters(in: .whitespaces)
            return CrashSettings(
                contactNumber: number.isEmpty ? nil : number,
                relayOptIn: self.crashRelayOptIn,
                callTarget: self.crashCallTarget,
                logOnly: self.crashLogOnly
            )
        }
    }

    func pairHelmet() {
        onMain { [weak self] in self?.performPairHelmet() }
    }

    /// Ask the relay what it knows, when the app knows nothing.
    ///
    /// Companion state is not persisted, so a relaunched app starts at
    /// `.signedOut` while the relay may still hold a binding, leaving the
    /// rider with nothing to pair to (see the spec for the board's discovery
    /// behaviour once paired). Connecting is enough: the relay syncs the
    /// binding on attach.
    func syncCompanionStateIfNeeded() {
        onMain { [weak self] in self?.performSyncCompanionState() }
    }

    /// Pairs via a discovered helmet's beacon token (Bonjour, Task 11) rather
    /// than the six-digit HUD code — same lifecycle action, different message.
    func pairDiscoveredHelmet(token: String) {
        onMain { [weak self] in self?.performPairDiscoverHelmet(token: token) }
    }

    /// Starts the local-network scan for nearby helmet beacons. Owned by the
    /// pairing section's lifetime — call from `onAppear`; never runs in the
    /// background.
    func startHelmetDiscovery() {
        onMain { [weak self] in self?.helmetDiscovery.start() }
    }

    /// Stops the scan and clears `discoveredHelmets` (via the discovery's own
    /// `onUpdate([])` on stop). Call from the pairing section's `onDisappear`.
    func stopHelmetDiscovery() {
        onMain { [weak self] in self?.helmetDiscovery.stop() }
    }

    /// Rider-facing copy for `companion.error` codes introduced by discovery
    /// pairing; `nil` for codes the existing status/error paths already cover
    /// (e.g. "auth", "connection") so callers can fall back to their copy.
    static func companionErrorCopy(code: String) -> String? {
        switch code {
        case "pair.busy": return "头盔正忙，请稍后再试"
        case "pair.declined": return "头盔侧已取消配对"
        case "pair.timeout": return "确认超时，请重试"
        default: return nil
        }
    }

    func startHelmetRide() {
        onMain { [weak self] in self?.performStartHelmetRide() }
    }

    func stopHelmetRide() {
        onMain { [weak self] in
            self?.performStopHelmetRide()
        }
    }

    func unpairHelmet() {
        onMain { [weak self] in self?.performUnpairHelmet() }
    }

    private func performPairHelmet() {
        dispatchPrecondition(condition: .onQueue(.main))
        let code = pairCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionTokenTransitionActive,
              !companionAccountTeardownActive,
              pendingUnpairOwner == nil,
              hasAccountSession,
              isSixASCIIDigitCode(code),
              !rideOwned,
              canPair(from: authoritativeCompanionState) else {
            return
        }

        let owner = advanceCompanionGeneration()
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: owner)
        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        guard ownsCompanionGeneration(owner), hasAccountSession, !rideOwned else { return }
        pairingSubmissionActive = true
        companionClient.pair(code: code)
    }

    private func performSyncCompanionState() {
        dispatchPrecondition(condition: .onQueue(.main))
        // `.signedOut` is the only state that cannot have come from the relay.
        // Anything else was pushed by it and is either correct or a failure the
        // rider can already act on, so re-syncing would reconnect for nothing.
        guard !sessionTokenTransitionActive,
              !companionAccountTeardownActive,
              pendingUnpairOwner == nil,
              hasAccountSession,
              !rideOwned,
              authoritativeCompanionState == .signedOut else {
            return
        }

        let owner = advanceCompanionGeneration()
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: owner)
        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        // Nothing follows the connect. The relay answers with `ready`,
        // `helmetOffline`, or `unpaired` — never `paired` — so an `unpaired`
        // answer retires the transport, but a bound answer (`ready` /
        // `helmetOffline`) leaves this socket open: `closePairOnlySocketIfIdle`
        // only fires on a `paired` transport state, which this path can never
        // reach. Closing it properly is a known follow-up that touches the
        // shared pair-only path (see the spec).
    }

    private func performPairDiscoverHelmet(token: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !sessionTokenTransitionActive,
              !companionAccountTeardownActive,
              pendingUnpairOwner == nil,
              hasAccountSession,
              RDKCompanionProtocol.pairDiscoverMessage(token: token) != nil,
              !rideOwned,
              canPair(from: authoritativeCompanionState) else {
            return
        }

        let owner = advanceCompanionGeneration()
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: owner)
        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        guard ownsCompanionGeneration(owner), hasAccountSession, !rideOwned else { return }
        isAwaitingHelmetConfirm = true
        pairingSubmissionActive = true
        companionClient.pairDiscover(token: token)
    }

    private func performStartHelmetRide() {
        dispatchPrecondition(condition: .onQueue(.main))
        if rideTeardownDepth > 0 || sessionTokenTransitionActive || companionAccountTeardownActive {
            pendingHelmetRideStart = true
            return
        }
        guard pendingUnpairOwner == nil else { return }
        guard hasAccountSession,
              !rideOwned,
              !helmetRideActive,
              canStartRide(from: authoritativeCompanionState) else {
            return
        }
        settleRideTeardownForNewStart()

        let owner = advanceCompanionGeneration()
        rideOwned = true
        helmetRideActive = false
        lastForwardedAt = nil
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: owner)
        bindLocationStream(owner: owner)

        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        guard ownsRide(owner), canContinueStart(from: authoritativeCompanionState) else {
            abortOwnedStart(owner: owner, clientRideStarted: false)
            return
        }

        companionClient.startRide()
        guard ownsRide(owner), canContinueStart(from: authoritativeCompanionState) else {
            abortOwnedStart(owner: owner, clientRideStarted: true)
            return
        }

        let foregroundStartAccepted = locationStream.startFromForeground()
        guard ownsRide(owner), canContinueStart(from: authoritativeCompanionState) else {
            abortOwnedStart(owner: owner, clientRideStarted: true)
            return
        }
        guard foregroundStartAccepted,
              companionPermission != .denied,
              companionPermission != .reduced else {
            terminateOwnedRide(sendStop: true)
            return
        }

        helmetRideActive = true
    }

    private func performStopHelmetRide() {
        dispatchPrecondition(condition: .onQueue(.main))
        if rideTeardownDepth > 0 || sessionTokenTransitionActive || companionAccountTeardownActive {
            pendingHelmetRideStart = false
            return
        }
        guard rideOwned || helmetRideActive else { return }
        terminateOwnedRide(sendStop: true, resumePendingStart: true)
    }

    private func performUnpairHelmet() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard pendingUnpairOwner == nil,
              !sessionTokenTransitionActive,
              !companionAccountTeardownActive,
              hasAccountSession,
              canUnpair(from: authoritativeCompanionState) || rideOwned else {
            return
        }
        let pairOnlySocketWasClosed: Bool
        if case .paired = authoritativeCompanionState {
            pairOnlySocketWasClosed = !rideOwned && !helmetRideActive
        } else {
            pairOnlySocketWasClosed = false
        }

        let shouldStopRide = rideOwned || helmetRideActive
        let owner = invalidateRideWithoutSocketStop()
        pendingUnpairOwner = owner
        pendingUnpairSendOwner = nil
        pendingUnpairPhase = .stoppingLocation
        rideTeardownDepth += 1
        locationStream.stop()
        rideTeardownDepth -= 1
        pendingHelmetRideStart = false
        guard ownsPendingUnpair(owner),
              hasAccountSession || companionAccountTeardownActive else {
            cancelPendingUnpairTransaction()
            return
        }

        if shouldStopRide {
            pendingUnpairPhase = .stoppingCompanion
            companionClient.stopRide { [weak self] result in
                self?.onMain { [weak self] in
                    self?.handleUnpairStopResult(
                        result,
                        owner: owner,
                        reconnectBeforeUnpair: false
                    )
                }
            }
        } else if companionAccountTeardownActive {
            cancelPendingUnpairTransaction()
            finishCompanionAccountTeardown()
        } else {
            continueUnpair(owner: owner, reconnectBeforeUnpair: pairOnlySocketWasClosed)
        }
    }

    private func handleUnpairStopResult(
        _ result: CompanionActionResult,
        owner: Int,
        reconnectBeforeUnpair: Bool
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsPendingUnpair(owner) else { return }
        if companionAccountTeardownActive {
            cancelPendingUnpairTransaction()
            finishCompanionAccountTeardown()
            return
        }
        guard result == .accepted, canSendUnpair(from: authoritativeCompanionState) else {
            cancelPendingUnpairTransaction()
            return
        }
        continueUnpair(owner: owner, reconnectBeforeUnpair: reconnectBeforeUnpair)
    }

    private func continueUnpair(owner: Int, reconnectBeforeUnpair: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsPendingUnpair(owner), hasAccountSession else { return }
        if reconnectBeforeUnpair {
            advanceCompanionStatePublicationEpoch()
            bindCompanionState(owner: owner)
            companionClient.connect(
                relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
                sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
                allowSelfSignedTLS: allowSelfSigned
            )
            guard ownsPendingUnpair(owner), hasAccountSession else { return }
        }
        guard canSendUnpair(from: authoritativeCompanionState) else {
            cancelPendingUnpairTransaction()
            return
        }
        pendingUnpairPhase = .sendingUnpair
        pendingUnpairSendOwner = owner
        companionClient.unpair { [weak self] result in
            self?.onMain { [weak self] in self?.finishUnpair(result, owner: owner) }
        }
    }

    private func finishUnpair(_ result: CompanionActionResult, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsPendingUnpair(owner),
              pendingUnpairSendOwner == owner,
              pendingUnpairPhase == .sendingUnpair else {
            return
        }
        cancelPendingUnpairTransaction()
        guard result == .accepted, canCompleteUnpair(from: authoritativeCompanionState) else { return }
        pairCode = ""
    }

    private func bindCompanionState(owner: Int) {
        let publicationEpoch = companionStatePublicationEpoch
        companionClient.onState = { [weak self] state in
            self?.onMain { [weak self] in
                self?.handleCompanionState(
                    state,
                    owner: owner,
                    publicationEpoch: publicationEpoch
                )
            }
        }
    }

    private func bindLocationStream(owner: Int) {
        locationStream.onPermission = { [weak self] permission in
            self?.onMain { [weak self] in self?.handlePermission(permission, owner: owner) }
        }
        locationStream.onFix = { [weak self] location in
            self?.onMain { [weak self] in self?.handleLocation(location, owner: owner) }
        }
    }

    private func handleCompanionState(
        _ state: CompanionConnectionState,
        owner: Int,
        publicationEpoch: Int
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsCompanionGeneration(owner),
              ownsCompanionStatePublicationEpoch(publicationEpoch) else {
            return
        }
        if !hasAccountSession, state != .signedOut { return }

        publishCompanionState(
            state,
            owner: owner,
            publicationEpoch: publicationEpoch
        ) { [weak self] in
            self?.handleCommittedCompanionState(state)
        }
    }

    private func handleCommittedCompanionState(_ state: CompanionConnectionState) {
        dispatchPrecondition(condition: .onQueue(.main))
        if resolvesPairingAction(state) {
            isAwaitingHelmetConfirm = false
            // A rider-initiated pairing that reached a binding consumes the
            // typed code. Leaving it in the field arms a replay: a
            // disconnected app is not `.paired`, so the pairing controls
            // re-enable, and each tap re-pairs an already-bound helmet with a
            // stale code — the relay answers `pair.code` and the client drops
            // the socket (bench 2026-08-12: five such cycles in 54 s).
            // Scoped to an in-flight submission so an ordinary status resync
            // never wipes what the rider is typing, and to a bound outcome so
            // a rejected code stays put to be corrected.
            if pairingSubmissionActive {
                pairingSubmissionActive = false
                if isBound(state) { pairCode = "" }
            }
        }

        let terminalState = isCompanionTerminal(state)
        if interruptsCompanionAction(state) {
            if companionAccountTeardownActive {
                switch pendingUnpairPhase {
                case .stoppingLocation:
                    return
                case .stoppingCompanion:
                    finishJoinedUnpairAccountTeardown()
                    return
                case .sendingUnpair, nil:
                    break
                }
                if companionAccountStopOwner != nil || rideTeardownPhase != nil {
                    companionAccountStopOwner = nil
                    settleRideTeardown()
                    finishCompanionAccountTeardown()
                    return
                }
            } else if rideTeardownPhase != nil {
                settleRideTeardown()
            }
        }

        if terminalState {
            settleRideTeardown()
        }

        switch state {
        case .failed(code: "auth", detail: _):
            if rideOwned || helmetRideActive {
                terminateOwnedRide(sendStop: true)
            } else {
                let replacementOwner = advanceCompanionGeneration()
                bindCompanionState(owner: replacementOwner)
            }
        case .unpaired:
            if let owner = pendingUnpairOwner,
               pendingUnpairSendOwner == owner,
               pendingUnpairPhase == .sendingUnpair,
               ownsPendingUnpair(owner) {
                cancelPendingUnpairTransaction()
                pairCode = ""
            } else if pendingUnpairOwner != nil {
                cancelPendingUnpairTransaction()
            }
            if rideOwned || helmetRideActive {
                terminateOwnedRide(sendStop: true)
            }
        default:
            if case .failed = state {
                cancelPendingUnpairTransaction()
            }
            break
        }
    }

    private func handlePermission(_ permission: CompanionLocationPermission, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner) else { return }
        companionPermission = permission
        guard ownsRide(owner) else { return }
        if permission == .denied || permission == .reduced {
            terminateOwnedRide(sendStop: true)
        }
    }

    /// How old a fix may be before the phone stops bothering to send it.
    ///
    /// The relay drops anything past its own staleness window with
    /// `location.timestamp`, so forwarding a stale fix spends the rider's
    /// per-second rate budget on a rejection. Kept well inside that window so
    /// transit time can never push an otherwise-good fix over the line, and
    /// far above the ~1 s cadence of live updates so only genuinely cached
    /// samples are caught.
    private static let maximumFixAge: TimeInterval = 5

    private func handleLocation(_ location: CLLocation, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), helmetRideActive, companionPermission == .precise else { return }

        // CoreLocation's first callbacks after a cold start routinely deliver a
        // CACHED fix minutes old — on the 2026-08-12 bench that was two sends,
        // two relay rejections, and then nothing. A negative age (a fix stamped
        // ahead of this clock) is left to the relay, which owns that boundary.
        let age = wallClock().timeIntervalSince(location.timestamp)
        guard age.isFinite, age <= Self.maximumFixAge else { return }

        let now = monotonicNow()
        guard ownsRide(owner) else { return }
        if let fix = fixThrottle.accept(location, now: now) {
            scheduledFlushTicket = nil
            lastThrottleEmissionTime = now
            forward(fix, owner: owner)
            return
        }

        guard now.isFinite,
              let lastThrottleEmissionTime,
              now >= lastThrottleEmissionTime,
              scheduledFlushTicket == nil else {
            return
        }
        scheduleNewestFlush(owner: owner, delay: max(0, 1 - (now - lastThrottleEmissionTime)))
    }

    private func scheduleNewestFlush(owner: Int, delay: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), scheduledFlushTicket == nil else { return }
        nextFlushTicket &+= 1
        let ticket = nextFlushTicket
        scheduledFlushTicket = ticket
        schedule({ [weak self] in
            self?.onMain { [weak self] in self?.flushNewest(owner: owner, ticket: ticket) }
        }, delay)
    }

    private func flushNewest(owner: Int, ticket: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), scheduledFlushTicket == ticket else { return }
        let now = monotonicNow()
        guard now.isFinite, let lastEmissionTime = lastThrottleEmissionTime else {
            scheduledFlushTicket = nil
            return
        }
        let elapsed = now - lastEmissionTime
        if elapsed < 1 {
            scheduledFlushTicket = nil
            scheduleNewestFlush(owner: owner, delay: max(0, 1 - elapsed))
            return
        }
        scheduledFlushTicket = nil
        guard ownsRide(owner), let fix = fixThrottle.flushNewest(now: now) else { return }
        lastThrottleEmissionTime = now
        forward(fix, owner: owner)
    }

    private func forward(_ fix: CompanionFix, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), helmetRideActive, companionPermission == .precise else { return }
        companionClient.sendLatest(fix)
        guard ownsRide(owner), helmetRideActive else { return }
        let forwardedAt = wallClock()
        guard ownsRide(owner), helmetRideActive else { return }
        lastForwardedAt = forwardedAt
    }

    @discardableResult
    private func terminateOwnedRide(sendStop: Bool, resumePendingStart: Bool = false) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let owner = advanceCompanionGeneration()
        rideOwned = false
        helmetRideActive = false
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        locationStream.onFix = nil
        locationStream.onPermission = nil
        bindCompanionState(owner: owner)

        rideTeardownOwner = owner
        rideTeardownPhase = .stoppingLocation
        rideTeardownDepth += 1
        defer {
            rideTeardownDepth -= 1
            if rideTeardownDepth == 0 {
                let shouldResume = resumePendingStart && pendingHelmetRideStart
                pendingHelmetRideStart = false
                if shouldResume { performStartHelmetRide() }
            }
        }
        locationStream.stop()
        guard ownsCompanionGeneration(owner) else {
            if rideTeardownOwner == owner {
                rideTeardownOwner = nil
                rideTeardownPhase = nil
            }
            return owner
        }
        if sendStop {
            rideTeardownPhase = .stoppingCompanion
            companionClient.stopRide { [weak self] _ in
                self?.onMain { [weak self] in self?.handleRideTeardownStop(owner: owner) }
            }
        } else {
            rideTeardownOwner = nil
            rideTeardownPhase = nil
            if companionAccountTeardownActive {
                finishCompanionAccountTeardown()
            }
        }
        return owner
    }

    private func handleRideTeardownStop(owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard rideTeardownOwner == owner else { return }
        settleRideTeardown()
        if companionAccountTeardownActive {
            finishCompanionAccountTeardown()
        }
    }

    private func settleRideTeardownForNewStart() {
        guard rideTeardownPhase != nil else { return }
        settleRideTeardown()
    }

    private func settleRideTeardown() {
        rideTeardownOwner = nil
        rideTeardownPhase = nil
    }

    private func abortOwnedStart(owner: Int, clientRideStarted: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner) else { return }
        if clientRideStarted {
            terminateOwnedRide(sendStop: true)
        } else {
            _ = invalidateRideWithoutSocketStop()
        }
    }

    @discardableResult
    private func invalidateRideWithoutSocketStop() -> Int {
        let owner = advanceCompanionGeneration()
        rideOwned = false
        helmetRideActive = false
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        locationStream.onFix = nil
        locationStream.onPermission = nil
        bindCompanionState(owner: owner)
        return owner
    }

    private func endCompanionAccountSession() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !companionAccountTeardownActive else { return }
        companionAccountTeardownActive = true
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: companionGeneration)

        switch pendingUnpairPhase {
        case .stoppingLocation, .stoppingCompanion:
            return
        case .sendingUnpair:
            cancelPendingUnpairTransaction()
            finishCompanionAccountTeardown()
            return
        case nil:
            break
        }

        if rideTeardownPhase != nil {
            return
        }

        let shouldStopCompanion = rideOwned || helmetRideActive
        let owner = invalidateRideWithoutSocketStop()
        companionAccountStopOwner = shouldStopCompanion ? owner : nil
        locationStream.stop()
        guard companionAccountTeardownActive else { return }

        if shouldStopCompanion {
            companionClient.stopRide { [weak self] _ in
                self?.onMain { [weak self] in self?.handleCompanionAccountStop(owner: owner) }
            }
        } else {
            finishCompanionAccountTeardown()
        }
    }

    private func handleCompanionAccountStop(owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard companionAccountTeardownActive, companionAccountStopOwner == owner else { return }
        companionAccountStopOwner = nil
        finishCompanionAccountTeardown()
    }

    private func finishCompanionAccountTeardown() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard companionAccountTeardownActive else { return }
        companionAccountStopOwner = nil
        cancelPendingUnpairTransaction()
        let owner = advanceCompanionGeneration()
        advanceCompanionStatePublicationEpoch()
        companionClient.disconnect()
        guard ownsCompanionGeneration(owner), companionAccountTeardownActive else { return }
        bindCompanionState(owner: owner)
        publishCompanionState(.signedOut, owner: owner, coalescesIdenticalState: true) { [weak self] in
            self?.finishCompanionAccountTeardownAfterState(owner: owner)
        }
    }

    private func finishCompanionAccountTeardownAfterState(owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsCompanionGeneration(owner), companionAccountTeardownActive else { return }
        companionAccountTeardownActive = false
        // This path publishes .signedOut directly (its own completion), bypassing
        // handleCommittedCompanionState's funnel — clear both pairing-action
        // flags here too. `pairingSubmissionActive` matters as much as its
        // sibling: left set, it survives the teardown into an unrelated session,
        // where the next resolving-and-bound state consumes whatever code is in
        // the field by then.
        isAwaitingHelmetConfirm = false
        pairingSubmissionActive = false

        finalizePendingLogout()
        if sessionTokenTransitionActive {
            drainSessionTokenTransition()
        } else {
            pendingHelmetRideStart = false
        }
    }

    private func publishCompanionState(
        _ state: CompanionConnectionState,
        owner: Int,
        publicationEpoch: Int? = nil,
        coalescesIdenticalState: Bool = false,
        completion: @escaping () -> Void = {}
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsCompanionGeneration(owner) else { return }
        let publicationEpoch = publicationEpoch ?? companionStatePublicationEpoch
        guard ownsCompanionStatePublicationEpoch(publicationEpoch) else { return }
        if !hasAccountSession, state != .signedOut { return }
        let terminalState = isCompanionTerminal(state)
        if let companionTerminalAuthority,
           companionTerminalAuthority.epoch == publicationEpoch,
           !terminalState {
            return
        }
        let publishesValue: Bool
        if coalescesIdenticalState {
            if let companionStateAssignmentInProgress {
                publishesValue = companionStateAssignmentInProgress != state
            } else {
                publishesValue = companionState != state
            }
        } else {
            publishesValue = true
        }
        if terminalState {
            companionTerminalAuthority = CompanionTerminalAuthority(epoch: publicationEpoch)
        }
        authoritativeCompanionState = state
        nextCompanionStatePublicationTicket &+= 1
        let publication = CompanionStatePublication(
            ticket: nextCompanionStatePublicationTicket,
            epoch: publicationEpoch,
            state: state,
            publishesValue: publishesValue,
            completion: completion
        )
        newestCompanionStatePublicationTicket = publication.ticket
        pendingCompanionStatePublications.append(publication)
        guard !companionStatePublicationActive else { return }

        companionStatePublicationActive = true
        defer { companionStatePublicationActive = false }
        while !pendingCompanionStatePublications.isEmpty {
            let next = pendingCompanionStatePublications.removeFirst()
            guard ownsCompanionStatePublicationEpoch(next.epoch) else { continue }
            if !hasAccountSession, next.state != .signedOut { continue }

            if next.publishesValue {
                companionStateAssignmentInProgress = next.state
                companionState = next.state
                companionStateAssignmentInProgress = nil
            }
            guard next.ticket == newestCompanionStatePublicationTicket,
                  ownsCompanionStatePublicationEpoch(next.epoch) else {
                continue
            }
            next.completion()
        }
    }

    private func transitionSessionToken(to newToken: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        pendingSessionTokenIntent = newToken
        if !sessionTokenTransitionActive {
            sessionTokenTransitionActive = true
        }
        drainSessionTokenTransition()
    }

    private func drainSessionTokenTransition() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard sessionTokenTransitionActive,
              !drainingSessionTokenTransition,
              !companionAccountTeardownActive else {
            return
        }

        drainingSessionTokenTransition = true
        defer { drainingSessionTokenTransition = false }
        while sessionTokenTransitionActive, let intent = pendingSessionTokenIntent {
            pendingSessionTokenIntent = nil
            let oldAccount = committedSessionToken.trimmingCharacters(in: .whitespacesAndNewlines)
            let newAccount = intent.trimmingCharacters(in: .whitespacesAndNewlines)
            if oldAccount != newAccount, ownsCompanionAccountSession {
                endCompanionAccountSession()
                if companionAccountTeardownActive {
                    if pendingSessionTokenIntent == nil {
                        pendingSessionTokenIntent = intent
                    }
                    return
                }
                guard sessionTokenTransitionActive else { return }
            }
            guard pendingSessionTokenIntent == nil else { continue }
            committedSessionToken = intent
            persistSecret(Keys.sessionToken, intent)
        }

        guard sessionTokenTransitionActive, pendingSessionTokenIntent == nil else { return }
        sessionTokenTransitionActive = false
        let shouldStart = pendingHelmetRideStart
        pendingHelmetRideStart = false
        if shouldStart { performStartHelmetRide() }
    }

    private func finalizePendingLogout() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard logoutRequestActive, !companionAccountTeardownActive else { return }

        authLogout(logoutRequestRelayURL, logoutRequestToken, logoutRequestAllowsSelfSigned)
        pendingSessionTokenIntent = nil
        sessionTokenTransitionActive = false
        committedSessionToken = ""
        persistSecret(Keys.sessionToken, "")
        authUserId = ""
        authUsername = ""
        authDisplayName = ""
        authRole = ""
        loginError = nil
        pendingHandsFreeRetry = false
        pendingHelmetRideStart = false
        voiceActions.selectTranscriptOwner(nil)
        if voiceActions.isHandsFree() { voiceActions.stop() }

        logoutRequestActive = false
        logoutRequestRelayURL = ""
        logoutRequestToken = ""
        logoutRequestAllowsSelfSigned = false
    }

    private func advanceCompanionGeneration() -> Int {
        companionGeneration &+= 1
        if let pendingUnpairOwner, pendingUnpairOwner != companionGeneration {
            cancelPendingUnpairTransaction()
        }
        return companionGeneration
    }

    private func ownsCompanionGeneration(_ owner: Int) -> Bool {
        companionGeneration == owner
    }

    private func advanceCompanionStatePublicationEpoch() {
        companionStatePublicationEpoch &+= 1
        companionTerminalAuthority = nil
    }

    private func ownsCompanionStatePublicationEpoch(_ epoch: Int) -> Bool {
        companionStatePublicationEpoch == epoch
    }

    private func ownsRide(_ owner: Int) -> Bool {
        rideOwned && ownsCompanionGeneration(owner)
    }

    private func ownsPendingUnpair(_ owner: Int) -> Bool {
        pendingUnpairOwner == owner && ownsCompanionGeneration(owner)
    }

    private func cancelPendingUnpairTransaction() {
        pendingUnpairOwner = nil
        pendingUnpairSendOwner = nil
        pendingUnpairPhase = nil
    }

    private func finishJoinedUnpairAccountTeardown() {
        cancelPendingUnpairTransaction()
        finishCompanionAccountTeardown()
    }

    private func interruptsCompanionAction(_ state: CompanionConnectionState) -> Bool {
        if state == .unpaired { return true }
        if case .failed = state { return true }
        return false
    }

    /// States and errors that RESOLVE a pairing action (code or discovery) one
    /// way or another, so the 等待头盔确认 row may stop waiting.
    ///
    /// `.connecting` and `.unpaired` are not resolutions: after a discovery tap
    /// the wire order is the transport's own `.connecting` and then the relay's
    /// attach-time `unpaired` sync for the still-unbound account — both land
    /// about a second into the helmet's 30 s confirm window. (The client defers
    /// that sync while a bind attempt is pending, so it normally never commits
    /// here at all; this funnel stays honest either way.)
    private func resolvesPairingAction(_ state: CompanionConnectionState) -> Bool {
        switch state {
        case .connecting, .unpaired:
            return false
        case .signedOut, .paired, .helmetOffline, .ready, .sharing, .failed:
            return true
        }
    }

    /// The helmet is bound as far as the relay is concerned.
    private func isBound(_ state: CompanionConnectionState) -> Bool {
        switch state {
        case .paired, .helmetOffline, .ready, .sharing:
            return true
        case .signedOut, .connecting, .unpaired, .failed:
            return false
        }
    }

    private func isCompanionTerminal(_ state: CompanionConnectionState) -> Bool {
        if state == .unpaired { return true }
        if case let .failed(code, _) = state { return code == "auth" }
        return false
    }

    private var hasAccountSession: Bool {
        !authUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sessionToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var ownsCompanionAccountSession: Bool {
        rideOwned || helmetRideActive || authoritativeCompanionState != .signedOut
    }

    private func canPair(from state: CompanionConnectionState) -> Bool {
        switch state {
        case .signedOut, .unpaired:
            return true
        case let .failed(code, _):
            return code != "auth"
        default:
            return false
        }
    }

    private func canStartRide(from state: CompanionConnectionState) -> Bool {
        switch state {
        case .paired, .ready:
            return true
        // Recovering from a dropped transport (board reboot, relay restart,
        // network blip). `connect()` reopens the socket and the relay replays
        // the authoritative binding, so `canContinueStart` still refuses if the
        // helmet turns out to be genuinely unpaired. An auth failure stays
        // terminal — only a fresh login clears it.
        case let .failed(code, _):
            return code != "auth"
        default:
            return false
        }
    }

    private func canContinueStart(from state: CompanionConnectionState) -> Bool {
        switch state {
        case .paired, .connecting, .ready, .sharing:
            return true
        default:
            return false
        }
    }

    private func canUnpair(from state: CompanionConnectionState) -> Bool {
        switch state {
        case .paired, .helmetOffline, .ready, .sharing:
            return true
        default:
            return false
        }
    }

    private func canSendUnpair(from state: CompanionConnectionState) -> Bool {
        switch state {
        case .signedOut, .failed:
            return false
        default:
            return true
        }
    }

    private func canCompleteUnpair(from state: CompanionConnectionState) -> Bool {
        canSendUnpair(from: state) || state == .unpaired
    }

    private func isSixASCIIDigitCode(_ code: String) -> Bool {
        let scalars = code.unicodeScalars
        return scalars.count == 6 && scalars.allSatisfy { (48...57).contains($0.value) }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
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
                          testerId: authUsername.isEmpty ? "ios-native" : authUsername,
                          testingCampaignId: testingCampaignId,
                          testingTestCaseId: testingTestCaseId,
                          testingRunId: testingRunId,
                          testingAssignmentId: testingAssignmentId)
        }
    }

    /// Mutes/unmutes the mic mid-session (bottom mute control).
    func toggleMute() { session.toggleMute() }

    /// A name in the contact field resolves to its number via Contacts, the
    /// same resolver the dial action uses. Numbers pass through untouched.
    func resolveCrashContactIfNeeded() {
        let raw = crashContactNumber.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, raw.rangeOfCharacter(from: .decimalDigits) == nil else { return }
        Task { @MainActor in
            let resolver = SystemContactResolver()
            guard await resolver.isAuthorized(), let number = await resolver.number(matching: raw) else { return }
            self.crashContactNumber = number
        }
    }

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
