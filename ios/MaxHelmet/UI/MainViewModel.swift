import SwiftUI
import Combine
import CoreLocation

protocol CompanionClientControlling: AnyObject {
    var onState: ((CompanionConnectionState) -> Void)? { get set }
    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool)
    func pair(code: String)
    func startRide()
    func stopRide()
    func unpair()
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
    @Published var sessionToken: String {
        didSet { persistSecret(Keys.sessionToken, sessionToken) }
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
        endCompanionAccountSession()
        authLogout(
            relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSigned
        )
        sessionToken = ""
        authUserId = ""
        authUsername = ""
        authDisplayName = ""
        authRole = ""
        loginError = nil
        pendingHandsFreeRetry = false
        voiceActions.selectTranscriptOwner(nil)
        if voiceActions.isHandsFree() { voiceActions.stop() }
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
        self.monotonicNow = monotonicNow
        self.wallClock = wallClock
        self.schedule = schedule
        self.voiceActions = voiceActions

        relayURL = defaults.string(forKey: Keys.relayURL) ?? Self.defaultRelayURL
        authToken = initialAuthToken
        sessionToken = initialSessionToken
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

    func startHelmetRide() {
        onMain { [weak self] in self?.performStartHelmetRide() }
    }

    func stopHelmetRide() {
        onMain { [weak self] in
            guard let self, self.rideOwned || self.helmetRideActive else { return }
            self.terminateOwnedRide(sendStop: true)
        }
    }

    func unpairHelmet() {
        onMain { [weak self] in self?.performUnpairHelmet() }
    }

    private func performPairHelmet() {
        dispatchPrecondition(condition: .onQueue(.main))
        let code = pairCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hasAccountSession,
              isSixASCIIDigitCode(code),
              !rideOwned,
              canPair(from: companionState) else {
            return
        }

        let owner = advanceCompanionGeneration()
        bindCompanionState(owner: owner)
        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        guard ownsCompanionGeneration(owner), hasAccountSession, !rideOwned else { return }
        companionClient.pair(code: code)
    }

    private func performStartHelmetRide() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard hasAccountSession,
              !rideOwned,
              !helmetRideActive,
              canStartRide(from: companionState) else {
            return
        }

        let owner = advanceCompanionGeneration()
        rideOwned = true
        helmetRideActive = false
        lastForwardedAt = nil
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        bindCompanionState(owner: owner)
        bindLocationStream(owner: owner)

        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        guard ownsRide(owner) else { return }

        companionClient.startRide()
        guard ownsRide(owner) else { return }

        let foregroundStartAccepted = locationStream.startFromForeground()
        guard ownsRide(owner) else { return }
        guard foregroundStartAccepted,
              companionPermission != .denied,
              companionPermission != .reduced else {
            terminateOwnedRide(sendStop: true)
            return
        }

        helmetRideActive = true
    }

    private func performUnpairHelmet() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard hasAccountSession, canUnpair(from: companionState) || rideOwned else { return }

        if rideOwned || helmetRideActive {
            terminateOwnedRide(sendStop: true)
        } else {
            invalidateRideWithoutSocketStop()
            locationStream.stop()
        }
        companionClient.unpair()
        pairCode = ""
    }

    private func bindCompanionState(owner: Int) {
        companionClient.onState = { [weak self] state in
            self?.onMain { [weak self] in self?.handleCompanionState(state, owner: owner) }
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

    private func handleCompanionState(_ state: CompanionConnectionState, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsCompanionGeneration(owner) else { return }
        if !hasAccountSession, state != .signedOut { return }

        companionState = state
        guard ownsCompanionGeneration(owner) else { return }

        switch state {
        case .failed(code: "auth", detail: _):
            if rideOwned || helmetRideActive {
                terminateOwnedRide(sendStop: true)
            } else {
                let replacementOwner = advanceCompanionGeneration()
                bindCompanionState(owner: replacementOwner)
            }
        case .unpaired:
            if rideOwned || helmetRideActive {
                terminateOwnedRide(sendStop: true)
            }
        default:
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

    private func handleLocation(_ location: CLLocation, owner: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), helmetRideActive, companionPermission == .precise else { return }

        let now = monotonicNow()
        guard ownsRide(owner) else { return }
        if let fix = fixThrottle.accept(location, now: now) {
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
        nextFlushTicket &+= 1
        let ticket = nextFlushTicket
        scheduledFlushTicket = ticket
        let delay = max(0, 1 - (now - lastThrottleEmissionTime))
        schedule({ [weak self] in
            self?.onMain { [weak self] in self?.flushNewest(owner: owner, ticket: ticket) }
        }, delay)
    }

    private func flushNewest(owner: Int, ticket: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard ownsRide(owner), scheduledFlushTicket == ticket else { return }
        scheduledFlushTicket = nil
        let now = monotonicNow()
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
    private func terminateOwnedRide(sendStop: Bool) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let owner = advanceCompanionGeneration()
        rideOwned = false
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        locationStream.onFix = nil
        locationStream.onPermission = nil
        bindCompanionState(owner: owner)

        locationStream.stop()
        if sendStop { companionClient.stopRide() }
        guard ownsCompanionGeneration(owner) else { return owner }
        helmetRideActive = false
        return owner
    }

    private func invalidateRideWithoutSocketStop() {
        let owner = advanceCompanionGeneration()
        rideOwned = false
        helmetRideActive = false
        fixThrottle.reset()
        lastThrottleEmissionTime = nil
        scheduledFlushTicket = nil
        locationStream.onFix = nil
        locationStream.onPermission = nil
        bindCompanionState(owner: owner)
    }

    private func endCompanionAccountSession() {
        dispatchPrecondition(condition: .onQueue(.main))
        if rideOwned || helmetRideActive {
            terminateOwnedRide(sendStop: true)
        } else {
            invalidateRideWithoutSocketStop()
            locationStream.stop()
        }
        companionClient.disconnect()
        let owner = advanceCompanionGeneration()
        bindCompanionState(owner: owner)
        companionState = .signedOut
    }

    private func advanceCompanionGeneration() -> Int {
        companionGeneration &+= 1
        return companionGeneration
    }

    private func ownsCompanionGeneration(_ owner: Int) -> Bool {
        companionGeneration == owner
    }

    private func ownsRide(_ owner: Int) -> Bool {
        rideOwned && ownsCompanionGeneration(owner)
    }

    private var hasAccountSession: Bool {
        !authUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sessionToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
