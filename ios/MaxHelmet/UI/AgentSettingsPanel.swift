import SwiftUI

// MARK: - settings sheet scaffold

struct SettingsSheet<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Visor.Space.s6) {
                VisorSheetHeader(title: title) { dismiss() }
                content
            }
            .padding(.horizontal, Visor.Space.s4)
            .padding(.top, Visor.Space.s5)
            .padding(.bottom, Visor.Space.s8)
        }
        .background(Visor.bg)
        .tint(Visor.accent)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Visor.bg)
        .presentationCornerRadius(Visor.Radius.sheet)
    }
}

// MARK: - inline login form (settings → 账号)

private struct LoginFields: View {
    @ObservedObject var viewModel: MainViewModel
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VisorFieldRow(title: L("set.user"), hint: L("set.login.hint")) {
            TextField(L("set.user"), text: $username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
        }
        VisorFieldRow(title: L("set.pass"), divider: viewModel.loginError != nil) {
            SecureField(L("set.pass"), text: $password)
        }
        if let error = viewModel.loginError {
            VisorRow(title: error, titleColor: Visor.danger)
        }
        Button {
            // Not cleared eagerly: on failure the rider shouldn't retype it;
            // on success this form unmounts (state discarded) anyway.
            viewModel.login(username: username, password: password)
        } label: {
            Text(viewModel.loginBusy ? L("set.login.busy") : L("set.login"))
        }
        .buttonStyle(.visor(.primary))
        .disabled(viewModel.loginBusy)
        .padding(Visor.Space.s3)
    }
}

struct CompanionSettingsPresentation: Equatable {
    let statusText: String
    let permissionText: String
    let forwardingText: String
    let primaryActionTitle: String
    let isPairEnabled: Bool
    let isPrimaryActionEnabled: Bool
    let showsUnpair: Bool
    let isUnpairEnabled: Bool
    /// Helmets currently visible via Bonjour discovery (Task 11).
    let discoveredHelmets: [DiscoveredHelmet]
    let isAwaitingHelmetConfirm: Bool
    /// Same gates as `isPairEnabled` minus `exactCode` — a discovered helmet's
    /// token stands in for the six-digit code, so the manual field's contents
    /// don't matter here.
    let isPairEnabledForDiscovery: Bool

    var renderedStrings: [String] {
        [statusText, permissionText, forwardingText, primaryActionTitle]
    }

    static func filteredPairCode(_ input: String) -> String {
        String(input.unicodeScalars.filter { (48...57).contains($0.value) }.prefix(6))
    }

    static func make(
        isLoggedIn: Bool,
        pairCode: String,
        connectionState: CompanionConnectionState,
        rideOwned: Bool,
        permission: CompanionLocationPermission,
        lastForwardedAt: Date?,
        now: Date,
        discoveredHelmets: [DiscoveredHelmet] = [],
        isAwaitingHelmetConfirm: Bool = false
    ) -> CompanionSettingsPresentation {
        let statusText: String
        switch connectionState {
        case .signedOut:
            statusText = isLoggedIn ? L("rdk.st.notConnected") : L("rdk.st.signIn")
        case .connecting:
            statusText = L("rdk.st.connecting")
        case .unpaired:
            statusText = L("rdk.st.unpaired")
        case .paired:
            statusText = L("rdk.st.paired")
        case .helmetOffline:
            statusText = L("rdk.st.pairedOffline")
        case .ready:
            statusText = L("rdk.st.ready")
        case .sharing:
            statusText = L("rdk.st.sharing")
        case let .failed(code, _):
            statusText = code == "auth" ? L("rdk.st.authFailed") : L("rdk.st.failed")
        }

        let permissionText: String
        switch permission {
        case .notDetermined:
            permissionText = L("rdk.perm.undetermined")
        case .denied:
            permissionText = L("rdk.perm.denied")
        case .reduced:
            permissionText = L("rdk.perm.reduced")
        case .precise:
            permissionText = L("rdk.perm.precise")
        }

        let forwardingText: String
        if let lastForwardedAt {
            let age = max(0, Int(now.timeIntervalSince(lastForwardedAt)))
            forwardingText = L("rdk.fwd.last", ("n", String(age)))
        } else {
            forwardingText = L("rdk.fwd.none")
        }

        let paired: Bool
        let startable: Bool
        let pairingState: Bool
        let busy: Bool
        switch connectionState {
        case .paired, .ready:
            paired = true
            startable = true
            pairingState = false
            busy = false
        case .helmetOffline:
            paired = true
            startable = false
            pairingState = false
            busy = false
        case .sharing:
            paired = true
            startable = false
            pairingState = false
            busy = true
        case .connecting:
            paired = false
            startable = false
            pairingState = false
            busy = true
        case .signedOut, .unpaired:
            paired = false
            startable = false
            pairingState = true
            busy = false
        case let .failed(code, _):
            paired = false
            // A non-auth failure is a dead transport, not a lost binding: the
            // companion socket is ride-scoped and never reconnects on its own,
            // so starting a ride is exactly how a rider recovers. Leaving this
            // false is what made "请重试" a lie. An auth failure is different —
            // only logging in again fixes it.
            startable = code != "auth"
            pairingState = code != "auth"
            busy = false
        }

        let exactCode = pairCode.unicodeScalars.count == 6
            && pairCode.unicodeScalars.allSatisfy { (48...57).contains($0.value) }
        return CompanionSettingsPresentation(
            statusText: statusText,
            permissionText: permissionText,
            forwardingText: forwardingText,
            primaryActionTitle: rideOwned ? L("set.rdk.stop") : L("set.rdk.start"),
            isPairEnabled: isLoggedIn && exactCode && pairingState && !rideOwned && !busy,
            isPrimaryActionEnabled: rideOwned || (isLoggedIn && startable && !busy),
            showsUnpair: paired,
            isUnpairEnabled: paired && !rideOwned && !busy,
            discoveredHelmets: discoveredHelmets,
            isAwaitingHelmetConfirm: isAwaitingHelmetConfirm,
            isPairEnabledForDiscovery: isLoggedIn && pairingState && !rideOwned && !busy
        )
    }
}

// MARK: - settings (account · assistant · voice · connection · demo · diagnostics)

struct SettingsPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel
    @State private var showUnpairConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: Visor.Space.s6) {
            accountGroup
            assistantGroup
            appearanceGroup
            voiceGroup
            connectionGroup
            companionGroup
            emergencyGroup
            rideGroup
            demoGroup
            qaGroup
            diagnosticsGroup
        }
        .onAppear { viewModel.refreshRelayHealth() }
    }

    // MARK: account

    /// Sign in with the same username/password as the web HUD; the session
    /// token then rides the /agent URL automatically. The manual 认证令牌 field
    /// in 连接 stays as the operator fallback.
    private var accountGroup: some View {
        VisorGroup(title: L("set.account")) {
            if viewModel.isLoggedIn {
                VisorRow(
                    title: viewModel.authDisplayName.isEmpty ? viewModel.authUsername : viewModel.authDisplayName,
                    subtitle: "@\(viewModel.authUsername) · \(viewModel.authRole == "admin" ? L("set.role.admin") : L("set.role.tester"))",
                    divider: false
                ) {
                    Button(L("set.logout")) { viewModel.logout() }
                        .buttonStyle(.visor(.destructive, fullWidth: false))
                }
            } else {
                LoginFields(viewModel: viewModel)
            }
        }
    }

    // MARK: assistant (branding + voice backend)

    private var assistantGroup: some View {
        VisorGroup(
            title: L("set.assistant"),
            footer: viewModel.voiceHealth?.switching == true ? L("set.assistant.footer") : nil
        ) {
            VisorRow(title: L("set.name"), divider: true) {
                HStack(spacing: Visor.Space.s2) {
                    AssistantMarkView(size: 28)
                    Text(Visor.assistantName).visorFont(.subhead).foregroundStyle(Visor.textSecondary)
                }
            }
            VisorRow(title: L("set.device"), divider: Visor.wakePhrase != nil || viewModel.voiceHealth != nil) {
                Label(VisorTheme.shared.deviceDisplayName, systemImage: Visor.deviceKind.symbol)
                    .visorFont(.subhead)
                    .foregroundStyle(Visor.textSecondary)
            }
            if let wake = Visor.wakePhrase {
                VisorRow(title: L("set.wake"), divider: viewModel.voiceHealth != nil) {
                    Text("“\(wake)”").visorFont(.subhead).foregroundStyle(Visor.textSecondary)
                }
            }
            if let voice = viewModel.voiceHealth {
                if voice.switching {
                    let selected = state.voiceProvider ?? voice.active
                    ForEach(Array(voice.providers.enumerated()), id: \.element.id) { index, provider in
                        VoiceProviderRow(
                            provider: provider,
                            selected: provider.id == selected,
                            divider: index < voice.providers.count - 1
                        ) { viewModel.setVoiceProvider(provider.id) }
                    }
                } else {
                    VisorRow(title: L("set.backend"), divider: false) {
                        Text(voice.activeLabel).visorFont(.subhead).foregroundStyle(Visor.textSecondary)
                    }
                }
            }
        }
    }

    // MARK: appearance (design template + voice display)

    private var appearanceGroup: some View {
        let theme = VisorTheme.shared
        let pinned = !theme.canSwitchTemplate
        return VisorGroup(
            title: L("set.appearance"),
            footer: pinned ? L("set.appearance.pinned") : nil
        ) {
            VisorSegmentedRow(
                title: L("set.lang"),
                options: [
                    VisorSegmentOption(value: AppLanguageChoice.system, label: L("set.lang.system")),
                    VisorSegmentOption(value: AppLanguageChoice.zh, label: L("set.lang.zh")),
                    VisorSegmentOption(value: AppLanguageChoice.en, label: L("set.lang.en"))
                ],
                selection: theme.languageChoice
            ) { choice in
                let before = theme.language
                theme.selectLanguage(choice)
                if theme.language != before { AgentSession.shared.languageChanged() }
            }
            Text(L("set.lang.footer"))
                .visorFont(.caption)
                .foregroundStyle(Visor.textTertiary)
                .padding(.horizontal, Visor.Space.s4)
                .padding(.bottom, Visor.Space.s2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if pinned {
                let current = theme.template
                VisorRow(title: current.label, subtitle: current.descriptionText) {
                    VisorChip(label: L("set.pinned"))
                }
                VisorRow(title: L("set.viz"), divider: false) {
                    HStack(spacing: Visor.Space.s2) {
                        VisualizerPreview(style: theme.visualizer, size: CGSize(width: 44, height: 24))
                        VisorChip(label: theme.visualizer.label)
                    }
                }
            } else {
                ForEach(Array(VisorTemplate.all.enumerated()), id: \.element.id) { _, template in
                    TemplateRow(template: template, selected: template.id == theme.template.id) {
                        theme.selectTemplate(template.id)
                    }
                }
                VisorRow(title: L("set.viz"), divider: false)
                VisualizerPicker(selected: theme.visualizer) { theme.selectVisualizer($0) }
            }
        }
    }

    // MARK: rider voice preferences

    private var voiceGroup: some View {
        VisorGroup(title: L("set.voice")) {
            VisorSegmentedRow(
                title: L("set.voice.sound"),
                options: VoiceGender.allCases.map { VisorSegmentOption(value: $0, label: $0.label) },
                selection: state.voiceGender
            ) { viewModel.setVoiceGender($0) }
            VisorSegmentedRow(
                title: L("set.voice.style"),
                options: VoicePersonality.allCases.map { VisorSegmentOption(value: $0, label: $0.label) },
                selection: state.voicePersonality
            ) { viewModel.setVoicePersonality($0) }
            VisorSegmentedRow(
                title: L("set.voice.mode"),
                options: RideMode.allCases.map {
                    VisorSegmentOption(value: $0, label: $0.label, tint: $0 == .emergency ? Visor.danger : nil)
                },
                selection: state.rideContext.mode,
                divider: false
            ) { viewModel.setRideMode($0) }
        }
    }

    // MARK: server / relay connection

    private var connectionGroup: some View {
        VisorGroup(title: L("set.connection")) {
            if state.handsFree {
                VisorRow(title: L("set.server.current"), subtitle: viewModel.relayURL)
                VisorRow(subtitle: L("set.server.locked"), divider: false)
            } else {
                VisorFieldRow(title: L("set.relay.field")) {
                    TextField(L("set.relay.placeholder"), text: $viewModel.relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                #if DEBUG
                VisorFieldRow(
                    title: L("set.token"),
                    hint: L("set.token.hint"),
                    divider: true
                ) {
                    SecureField(L("set.token"), text: $viewModel.authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                VisorToggleRow(title: L("set.selfSigned"), isOn: $viewModel.allowSelfSigned, divider: false)
                #else
                VisorFieldRow(
                    title: L("set.token"),
                    hint: L("set.token.hint"),
                    divider: false
                ) {
                    SecureField(L("set.token"), text: $viewModel.authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                #endif
            }
        }
    }

    // MARK: RDK companion

    private var companionGroup: some View {
        let companion = CompanionSettingsPresentation.make(
            isLoggedIn: viewModel.isLoggedIn,
            pairCode: viewModel.pairCode,
            connectionState: viewModel.companionState,
            rideOwned: viewModel.helmetRideOwned,
            permission: viewModel.companionPermission,
            lastForwardedAt: viewModel.lastForwardedAt,
            now: Date(),
            discoveredHelmets: viewModel.discoveredHelmets,
            isAwaitingHelmetConfirm: viewModel.isAwaitingHelmetConfirm
        )
        return VisorGroup(title: L("set.rdk")) {
            VisorRow(title: companion.statusText, subtitle: "\(companion.permissionText)\n\(companion.forwardingText)")
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("set.rdk.a11y", ("status", companion.statusText), ("permission", companion.permissionText), ("forwarding", companion.forwardingText)))

            // Nearby helmets found via Bonjour — a discovered beacon's token
            // stands in for the six-digit code below.
            ForEach(companion.discoveredHelmets) { helmet in
                VisorRow(title: L("set.rdk.nearbyTitle", ("name", Visor.assistantName)), subtitle: L("set.rdk.nearby")) {
                    Button(L("set.rdk.pair")) { viewModel.pairDiscoveredHelmet(token: helmet.token) }
                        .buttonStyle(.visor(.secondary, fullWidth: false))
                        .disabled(!companion.isPairEnabledForDiscovery)
                }
            }
            if companion.isAwaitingHelmetConfirm {
                // Must stay in step with PAIR_CONFIRM_PROMPT in
                // server/companion-registry.ts: a bare 确认 is too short for the
                // ASR to finalize, and riders reach for this phone's button
                // unless told the confirmation is spoken at the helmet.
                VisorRow(title: L("set.rdk.awaiting"), titleColor: Visor.accent)
            }

            VisorFieldRow(title: L("set.rdk.code")) {
                TextField(
                    L("set.rdk.codePlaceholder"),
                    text: Binding(
                        get: { viewModel.pairCode },
                        set: { viewModel.pairCode = CompanionSettingsPresentation.filteredPairCode($0) }
                    )
                )
                .visorFont(.subhead, mono: true)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .accessibilityLabel(L("set.rdk.codeA11y"))
            }

            VStack(spacing: Visor.Space.s2) {
                Button(L("set.rdk.pairHelmet")) { viewModel.pairHelmet() }
                    .buttonStyle(.visor(.secondary))
                    .disabled(!companion.isPairEnabled)
                    .accessibilityHint(L("set.rdk.pairHint"))

                Button(companion.primaryActionTitle) {
                    if viewModel.helmetRideOwned {
                        viewModel.stopHelmetRide()
                    } else {
                        viewModel.startHelmetRide()
                    }
                }
                .buttonStyle(.visor(.primary))
                .disabled(!companion.isPrimaryActionEnabled)
                .accessibilityHint(viewModel.helmetRideOwned ? L("set.rdk.stopHint") : L("set.rdk.startHint"))

                if companion.showsUnpair {
                    Button(L("set.rdk.unpair"), role: .destructive) { showUnpairConfirmation = true }
                        .buttonStyle(.visor(.destructive))
                        .disabled(!companion.isUnpairEnabled)
                        .confirmationDialog(L("set.rdk.unpairTitle"), isPresented: $showUnpairConfirmation) {
                            Button(L("set.rdk.unpair"), role: .destructive) { viewModel.unpairHelmet() }
                            Button(L("set.rdk.keep"), role: .cancel) {}
                        } message: {
                            Text(L("set.rdk.unpairMsg"))
                        }
                }
            }
            .padding(Visor.Space.s3)
        }
        // Scanning is scoped to this section's on-screen lifetime — starts
        // when the settings sheet (and thus this group) appears, stops when
        // it's dismissed. No background radio use.
        .onAppear {
            viewModel.syncCompanionStateIfNeeded()
            viewModel.startHelmetDiscovery()
        }
        .onDisappear { viewModel.stopHelmetDiscovery() }
    }

    // MARK: crash detection

    /// Emergency contact, relay opt-in, alarm-view call target, and a log-only
    /// mode for collecting false-positive data.
    private var emergencyGroup: some View {
        VisorGroup(title: L("set.emergency")) {
            VisorFieldRow(title: L("set.emergency.number")) {
                TextField("+86 …", text: $viewModel.crashContactNumber)
                    .keyboardType(.phonePad)
                    .disabled(state.handsFree)   // never mid-session
                    .onSubmit { viewModel.resolveCrashContactIfNeeded() }
            }
            VisorToggleRow(
                title: L("set.emergency.notify"),
                subtitle: L("set.emergency.notifySub"),
                isOn: $viewModel.crashRelayOptIn
            )
            .disabled(state.handsFree)
            VisorSegmentedRow(
                title: L("set.emergency.callTarget"),
                options: [
                    VisorSegmentOption(value: "120", label: "120"),
                    VisorSegmentOption(value: "contact", label: L("set.emergency.contact"))
                ],
                selection: viewModel.crashCallTarget
            ) { viewModel.crashCallTarget = $0 }
            VisorToggleRow(
                title: L("set.emergency.logOnly"),
                subtitle: L("set.emergency.logOnlySub"),
                isOn: $viewModel.crashLogOnly,
                divider: false
            )
            .disabled(state.handsFree)
        }
    }

    // MARK: live ride intelligence

    /// Weather, route, and session memory. The data already flows over the
    /// protocol (weather / ride.context / session.memory events).
    private var rideGroup: some View {
        VisorGroup(title: L("set.ride")) {
            if let weather = state.weather {
                VisorRow(title: weather.description, subtitle: L("set.ride.wind", ("v", String(weather.windSpeedKmh)), ("advice", weather.riderAdvice))) {
                    HStack(spacing: Visor.Space.s2) {
                        Text("\(weather.temperatureC)°")
                            .visorFont(.title, .semibold, mono: true)
                            .foregroundStyle(Visor.text)
                        Text(weather.riskLevel == .critical ? L("set.ride.high") : weather.riskLevel == .caution ? L("set.ride.caution") : L("set.ride.normal"))
                            .visorFont(.caption, .bold)
                            .foregroundStyle(hazardColor(weather.riskLevel))
                    }
                }
            } else {
                VisorRow(title: L("set.weather"), subtitle: L("set.weather.pending"))
            }
            VisorRow(title: L("set.route")) {
                Text("\(state.rideContext.speedKmh.map(String.init) ?? "—") km/h · \(state.rideContext.routePhase)")
                    .visorFont(.subhead, mono: true)
                    .foregroundStyle(Visor.textSecondary)
            }
            VisorRow(divider: false) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        VisorChip(label: state.sessionMemory.language == "zh" ? "中文" : "English")
                        VisorChip(label: responseModeLabel(state.sessionMemory.responseMode))
                        VisorChip(label: state.sessionMemory.lastIntent ?? L("set.intent.pending"))
                        if let destination = state.sessionMemory.destination {
                            VisorChip(label: destination, tint: Visor.accent)
                        }
                        VisorChip(label: L("set.battery", ("n", String(state.rideContext.batteryPct))), mono: true)
                    }
                }
            }
        }
    }

    // MARK: demo scenarios (ADAS hazard injection)

    private var demoGroup: some View {
        VisorGroup(title: L("set.demo")) {
            VisorSegmentedRow(
                title: L("set.demo.scenario"),
                options: DemoScenario.allCases.map {
                    VisorSegmentOption(value: $0, label: $0.label, tint: hazardColor($0.hazard))
                },
                selection: state.rideContext.scenario,
                divider: state.provider == "mock"
            ) { viewModel.setScenario($0) }
            // Guided tour of every scenario — mock provider only, like the web.
            if state.provider == "mock" {
                VisorToggleRow(
                    title: L("set.demo.tour"),
                    subtitle: state.guidedDemo ? L("set.demo.touring") : nil,
                    isOn: Binding(get: { state.guidedDemo }, set: { viewModel.setGuidedDemo($0) }),
                    divider: false
                )
            }
        }
    }

    // MARK: QA attribution

    private var qaGroup: some View {
        VisorGroup(
            title: L("set.qa"),
            footer: L("set.qa.footer")
        ) {
            Group {
                qaField("Campaign ID", $viewModel.testingCampaignId)
                qaField("Test case ID", $viewModel.testingTestCaseId)
                qaField(L("set.qa.run"), $viewModel.testingRunId)
                qaField(L("set.qa.assignment"), $viewModel.testingAssignmentId)
            }
            .disabled(state.handsFree)
            VisorRow(divider: false) {
                Text("iOS · build \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown") · commit \(Bundle.main.infoDictionary?["MaxGitCommit"] as? String ?? "unknown")")
                    .visorFont(.caption, mono: true)
                    .foregroundStyle(Visor.textTertiary)
            }
        }
    }

    private func qaField(_ title: String, _ text: Binding<String>) -> some View {
        VisorFieldRow(title: title) {
            TextField(title, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
        }
    }

    // MARK: diagnostics

    /// Latency, telemetry, transcript export, raw status.
    private var diagnosticsGroup: some View {
        let toneColor: Color = state.latencyMs < 140
            ? Visor.ok
            : (state.latencyMs < 280 ? Visor.warn : Visor.danger)
        let hasTranscript = !state.transcript.isEmpty
        return VisorGroup(title: L("set.diag")) {
            VisorRow(title: L("set.diag.latency")) {
                Text("\(state.latencyMs) ms")
                    .visorFont(.subhead, .semibold, mono: true)
                    .foregroundStyle(toneColor)
            }
            if let telemetry = state.telemetry {
                VisorRow(
                    title: L("set.diag.timing"),
                    subtitle: L("set.diag.timingValue", ("asr", String(telemetry.asrMs)), ("think", String(telemetry.thinkMs)), ("first", String(telemetry.firstAudioMs)), ("total", String(telemetry.totalMs)))
                )
            }
            VisorRow(title: L("set.diag.status"), subtitle: state.statusText)
            if let agent = state.activeAgent {
                VisorRow(title: L("set.diag.agent"), subtitle: agent)
            }
            if let warning = state.protocolWarning {
                VisorRow(title: L("set.diag.protocol"), subtitle: warning)
            }
            VisorChevronRow(title: L("set.diag.export"), enabled: hasTranscript) {
                if hasTranscript { viewModel.exportTranscript() }
            }
            VisorChevronRow(title: L("set.diag.clear"), titleColor: Visor.danger, enabled: hasTranscript, divider: false) {
                if hasTranscript { viewModel.clearTranscript() }
            }
        }
    }
}

// MARK: - voice backend row

private struct VoiceProviderRow: View {
    let provider: VoiceProviderInfo
    let selected: Bool
    let divider: Bool
    let action: () -> Void

    private var kindLabel: String {
        switch provider.kind {
        case "demo": return L("set.kind.demo")
        case "pipeline": return L("set.kind.pipeline")
        default: return L("set.kind.live")
        }
    }

    var body: some View {
        Button(action: action) {
            VisorRow(
                title: provider.label,
                subtitle: provider.configured ? provider.description : L("set.needsKey"),
                divider: divider
            ) {
                HStack(spacing: Visor.Space.s2) {
                    VisorChip(label: kindLabel)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 18))
                        .foregroundStyle(selected ? Visor.accent : Visor.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!provider.configured)
        .opacity(provider.configured ? 1 : Visor.disabledOpacity)
        .accessibilityLabel(provider.label)
        .accessibilityValue(provider.configured ? (selected ? L("common.selected") : "") : L("set.needsKey"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - appearance pickers

/// One template: a small swatch, the name, a one-line description.
private struct TemplateRow: View {
    let template: VisorTemplate
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Visor.Space.s3) {
                TemplateSwatch(template: template)
                VStack(alignment: .leading, spacing: 2) {
                    Text(template.label).visorFont(.subhead, .semibold).foregroundStyle(Visor.text)
                    Text(template.descriptionText)
                        .visorFont(.caption)
                        .foregroundStyle(Visor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Visor.Space.s2)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(selected ? Visor.accent : Visor.textTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Visor.Space.s4)
            .padding(.vertical, Visor.Space.s2)
            .frame(minHeight: Visor.hit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { VisorDivider().padding(.leading, Visor.Space.s4) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("tpl.a11y", ("name", template.label), ("desc", template.descriptionText)))
        .accessibilityValue(selected ? L("common.selected") : "")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A 44x32 thumbnail of a template: its background, a surface bar, a text
/// line and the accent dot.
private struct TemplateSwatch: View {
    let template: VisorTemplate

    var body: some View {
        let sw = template.swatch
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(sw.bg.color)
            VStack(alignment: .leading, spacing: 3) {
                RoundedRectangle(cornerRadius: 2).fill(sw.text.color).frame(width: 20, height: 3)
                RoundedRectangle(cornerRadius: 3).fill(sw.surface.color).frame(width: 30, height: 8)
                Circle().fill(sw.accent.color).frame(width: 8, height: 8)
            }
            .padding(.leading, 6)
        }
        .frame(width: 44, height: 32)
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Visor.lineStrong, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

/// The five voice display styles as selectable tiles with a still preview.
private struct VisualizerPicker: View {
    let selected: VoiceVisualizer
    let onSelect: (VoiceVisualizer) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Visor.Space.s2) {
                ForEach(VoiceVisualizer.allCases) { style in
                    let on = style == selected
                    Button { onSelect(style) } label: {
                        VStack(spacing: 4) {
                            VisualizerPreview(style: style, size: CGSize(width: 64, height: 32))
                            Text(style.label)
                                .visorFont(.caption, on ? .semibold : .regular)
                                .foregroundStyle(on ? Visor.accent : Visor.textSecondary)
                        }
                        .padding(Visor.Space.s2)
                        .frame(minWidth: 76, minHeight: Visor.hit)
                        .background(on ? Visor.accentSoft : Visor.surface2,
                                    in: RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous)
                                .strokeBorder(on ? Visor.accent : Visor.line, lineWidth: Visor.hairline)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(L("set.viz.a11y", ("name", style.label)))
                    .accessibilityValue(on ? L("common.selected") : "")
                    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.horizontal, Visor.Space.s4)
            .padding(.bottom, Visor.Space.s3)
        }
    }
}

/// A tiny still frame of a voice display style (speaking state, fixed time).
///
/// The drawing lives in small, explicitly typed helpers: as one Canvas closure
/// mixing Double and CGFloat arithmetic, it took the Swift type checker longer
/// than the compiler allows and failed the build.
struct VisualizerPreview: View {
    let style: VoiceVisualizer
    let size: CGSize

    var body: some View {
        let style = self.style
        let tint = Visor.accent
        let line = Visor.textTertiary
        Canvas { context, canvas in
            Self.draw(style, in: &context, size: canvas, tint: tint, line: line)
        }
        .frame(width: size.width, height: size.height)
        .accessibilityHidden(true)
    }

    private static func draw(
        _ style: VoiceVisualizer, in context: inout GraphicsContext, size: CGSize, tint: Color, line: Color
    ) {
        let values: [Double] = Spectrum.synthesize(mode: .speaking, level: 0.5, t: 1.2)
        switch style {
        case .wave:
            drawWave(in: &context, size: size, tint: tint)
        case .bars, .mirror, .dots:
            drawColumns(style, values: values, in: &context, size: size, tint: tint, line: line)
        case .ring:
            drawRing(values: values, in: &context, size: size, tint: tint)
        }
    }

    private static func drawWave(in context: inout GraphicsContext, size: CGSize, tint: Color) {
        let w: CGFloat = size.width
        let h: CGFloat = size.height
        var path = Path()
        for i in 0...40 {
            let u: CGFloat = CGFloat(i) / 40
            let envelope: CGFloat = sin(u * .pi)
            let ripple: CGFloat = sin(u * 14)
            let y: CGFloat = h / 2 - envelope * ripple * h * 0.38
            let point = CGPoint(x: 4 + (w - 8) * u, y: y)
            if i == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        context.stroke(path, with: .color(tint), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
    }

    private static func drawColumns(
        _ style: VoiceVisualizer, values: [Double], in context: inout GraphicsContext, size: CGSize,
        tint: Color, line: Color
    ) {
        let w: CGFloat = size.width
        let h: CGFloat = size.height
        let n = 12
        let colW: CGFloat = (w - 8) / CGFloat(n)
        for i in 0..<n {
            let v = CGFloat(values[i * 2])
            let x: CGFloat = 4 + CGFloat(i) * colW
            switch style {
            case .bars:
                let bh: CGFloat = max(2, v * (h - 6))
                let rect = CGRect(x: x, y: h - 3 - bh, width: colW * 0.7, height: bh)
                context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(tint))
            case .mirror:
                let bh: CGFloat = max(2, v * (h - 6))
                let rect = CGRect(x: x, y: (h - bh) / 2, width: colW * 0.7, height: bh)
                context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(tint))
            default:
                let lit = Int((Double(v) * 5).rounded())
                let r: CGFloat = colW * 0.3
                for row in 0..<5 {
                    let y: CGFloat = h - 4 - CGFloat(row) * ((h - 8) / 5)
                    let rect = CGRect(x: x, y: y - r, width: r * 2, height: r * 2)
                    let color: Color = row < lit ? tint : line.opacity(0.35)
                    context.fill(Path(ellipseIn: rect), with: .color(color))
                }
            }
        }
    }

    private static func drawRing(values: [Double], in context: inout GraphicsContext, size: CGSize, tint: Color) {
        let w: CGFloat = size.width
        let h: CGFloat = size.height
        let center = CGPoint(x: w / 2, y: h / 2)
        let rIn: CGFloat = h * 0.2
        for k in 0..<24 {
            let a: CGFloat = CGFloat(k) / 24 * 2 * .pi
            let v = CGFloat(values[k < 12 ? k : 23 - k])
            let out: CGFloat = rIn + 2 + v * h * 0.26
            var path = Path()
            path.move(to: CGPoint(x: center.x + cos(a) * rIn, y: center.y + sin(a) * rIn))
            path.addLine(to: CGPoint(x: center.x + cos(a) * out, y: center.y + sin(a) * out))
            context.stroke(path, with: .color(tint), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
        }
    }
}
