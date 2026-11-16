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
        VisorFieldRow(title: "用户名", hint: "使用网页测试平台的账号登录；登录后自动获取会话令牌。") {
            TextField("用户名", text: $username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
        }
        VisorFieldRow(title: "密码", divider: viewModel.loginError != nil) {
            SecureField("密码", text: $password)
        }
        if let error = viewModel.loginError {
            VisorRow(title: error, titleColor: Visor.danger)
        }
        Button {
            // Not cleared eagerly: on failure the rider shouldn't retype it;
            // on success this form unmounts (state discarded) anyway.
            viewModel.login(username: username, password: password)
        } label: {
            Text(viewModel.loginBusy ? "登录中…" : "登录")
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
            statusText = isLoggedIn ? "尚未连接 RDK 头盔" : "请先登录账号"
        case .connecting:
            statusText = "正在连接 RDK 头盔…"
        case .unpaired:
            statusText = "尚未配对"
        case .paired:
            statusText = "已配对，等待开始骑行"
        case .helmetOffline:
            statusText = "已配对，头盔离线"
        case .ready:
            statusText = "RDK 头盔已连接"
        case .sharing:
            statusText = "正在向 RDK 头盔转发导航位置"
        case let .failed(code, _):
            statusText = code == "auth" ? "账号会话已失效，请重新登录" : "RDK 头盔连接失败，请重试"
        }

        let permissionText: String
        switch permission {
        case .notDetermined:
            permissionText = "位置权限将在开始 Helmet Ride 时请求"
        case .denied:
            permissionText = "位置权限已拒绝，请在系统设置中允许使用位置"
        case .reduced:
            permissionText = "位置精度不足，请在系统设置中开启精确位置"
        case .precise:
            permissionText = "精确位置可用"
        }

        let forwardingText: String
        if let lastForwardedAt {
            let age = max(0, Int(now.timeIntervalSince(lastForwardedAt)))
            forwardingText = "上次转发：\(age) 秒前"
        } else {
            forwardingText = "尚未转发位置"
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
            primaryActionTitle: rideOwned ? "停止 Helmet Ride" : "开始 Helmet Ride",
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
        VisorGroup(title: "账号") {
            if viewModel.isLoggedIn {
                VisorRow(
                    title: viewModel.authDisplayName.isEmpty ? viewModel.authUsername : viewModel.authDisplayName,
                    subtitle: "@\(viewModel.authUsername) · \(viewModel.authRole == "admin" ? "管理员" : "测试员")",
                    divider: false
                ) {
                    Button("退出登录") { viewModel.logout() }
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
            title: "助手",
            footer: viewModel.voiceHealth?.switching == true ? "切换语音后端会重新开始当前会话。" : nil
        ) {
            VisorRow(title: "名称", divider: true) {
                Text(Visor.assistantName).visorFont(.subhead).foregroundStyle(Visor.textSecondary)
            }
            VisorRow(title: "设备", divider: Visor.wakePhrase != nil || viewModel.voiceHealth != nil) {
                Label(Visor.deviceKind.noun, systemImage: Visor.deviceKind.symbol)
                    .visorFont(.subhead)
                    .foregroundStyle(Visor.textSecondary)
            }
            if let wake = Visor.wakePhrase {
                VisorRow(title: "唤醒词", divider: viewModel.voiceHealth != nil) {
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
                    VisorRow(title: "语音后端", divider: false) {
                        Text(voice.activeLabel).visorFont(.subhead).foregroundStyle(Visor.textSecondary)
                    }
                }
            }
        }
    }

    // MARK: rider voice preferences

    private var voiceGroup: some View {
        VisorGroup(title: "语音") {
            VisorSegmentedRow(
                title: "声音",
                options: VoiceGender.allCases.map { VisorSegmentOption(value: $0, label: $0.label) },
                selection: state.voiceGender
            ) { viewModel.setVoiceGender($0) }
            VisorSegmentedRow(
                title: "语气",
                options: VoicePersonality.allCases.map { VisorSegmentOption(value: $0, label: $0.label) },
                selection: state.voicePersonality
            ) { viewModel.setVoicePersonality($0) }
            VisorSegmentedRow(
                title: "模式",
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
        VisorGroup(title: "连接") {
            if state.handsFree {
                VisorRow(title: "当前服务器", subtitle: viewModel.relayURL)
                VisorRow(subtitle: "结束免提后可修改服务器地址。", divider: false)
            } else {
                VisorFieldRow(title: "语音中继地址（ws:// 或 wss://）") {
                    TextField("语音中继地址", text: $viewModel.relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                #if DEBUG
                VisorFieldRow(
                    title: "认证令牌",
                    hint: "网页登录后点「复制令牌（App 用）」获取；开放模式可留空",
                    divider: true
                ) {
                    SecureField("认证令牌", text: $viewModel.authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                VisorToggleRow(title: "信任自签名证书（仅调试）", isOn: $viewModel.allowSelfSigned, divider: false)
                #else
                VisorFieldRow(
                    title: "认证令牌",
                    hint: "网页登录后点「复制令牌（App 用）」获取；开放模式可留空",
                    divider: false
                ) {
                    SecureField("认证令牌", text: $viewModel.authToken)
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
        return VisorGroup(title: "RDK 头盔") {
            VisorRow(title: companion.statusText, subtitle: "\(companion.permissionText)\n\(companion.forwardingText)")
                .accessibilityElement(children: .combine)
                .accessibilityLabel("RDK 头盔状态：\(companion.statusText)。\(companion.permissionText)。\(companion.forwardingText)")

            // Nearby helmets found via Bonjour — a discovered beacon's token
            // stands in for the six-digit code below.
            ForEach(companion.discoveredHelmets) { helmet in
                VisorRow(title: "\(Visor.assistantName) 头盔", subtitle: "附近") {
                    Button("配对") { viewModel.pairDiscoveredHelmet(token: helmet.token) }
                        .buttonStyle(.visor(.secondary, fullWidth: false))
                        .disabled(!companion.isPairEnabledForDiscovery)
                }
            }
            if companion.isAwaitingHelmetConfirm {
                // Must stay in step with PAIR_CONFIRM_PROMPT in
                // server/companion-registry.ts: a bare 确认 is too short for the
                // ASR to finalize, and riders reach for this phone's button
                // unless told the confirmation is spoken at the helmet.
                VisorRow(title: "等待头盔确认…请对头盔说\u{201C}确认配对\u{201D}，无需按键", titleColor: Visor.accent)
            }

            VisorFieldRow(title: "配对码") {
                TextField(
                    "手动输入配对码",
                    text: Binding(
                        get: { viewModel.pairCode },
                        set: { viewModel.pairCode = CompanionSettingsPresentation.filteredPairCode($0) }
                    )
                )
                .visorFont(.subhead, mono: true)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .accessibilityLabel("RDK 头盔六位配对码")
            }

            VStack(spacing: Visor.Space.s2) {
                Button("配对头盔") { viewModel.pairHelmet() }
                    .buttonStyle(.visor(.secondary))
                    .disabled(!companion.isPairEnabled)
                    .accessibilityHint("只建立配对，不会开始位置转发")

                Button(companion.primaryActionTitle) {
                    if viewModel.helmetRideOwned {
                        viewModel.stopHelmetRide()
                    } else {
                        viewModel.startHelmetRide()
                    }
                }
                .buttonStyle(.visor(.primary))
                .disabled(!companion.isPrimaryActionEnabled)
                .accessibilityHint(viewModel.helmetRideOwned ? "停止向 RDK 头盔转发位置" : "从前台开始导航位置转发")

                if companion.showsUnpair {
                    Button("取消配对", role: .destructive) { showUnpairConfirmation = true }
                        .buttonStyle(.visor(.destructive))
                        .disabled(!companion.isUnpairEnabled)
                        .confirmationDialog("取消 RDK 头盔配对？", isPresented: $showUnpairConfirmation) {
                            Button("取消配对", role: .destructive) { viewModel.unpairHelmet() }
                            Button("保留配对", role: .cancel) {}
                        } message: {
                            Text("Helmet Ride 会先停止，之后需要新的六位配对码才能重新连接。")
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
        VisorGroup(title: "紧急求助") {
            VisorFieldRow(title: "紧急联系人号码") {
                TextField("+86 …", text: $viewModel.crashContactNumber)
                    .keyboardType(.phonePad)
                    .disabled(state.handsFree)   // never mid-session
                    .onSubmit { viewModel.resolveCrashContactIfNeeded() }
            }
            VisorToggleRow(
                title: "事故升级时通知紧急联系人",
                subtitle: "号码仅在升级时发送到服务器",
                isOn: $viewModel.crashRelayOptIn
            )
            .disabled(state.handsFree)
            VisorSegmentedRow(
                title: "警报界面拨打",
                options: [
                    VisorSegmentOption(value: "120", label: "120"),
                    VisorSegmentOption(value: "contact", label: "紧急联系人")
                ],
                selection: viewModel.crashCallTarget
            ) { viewModel.crashCallTarget = $0 }
            VisorToggleRow(
                title: "仅记录模式",
                subtitle: "只记录检测，不报警 — 采集误报数据用",
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
        VisorGroup(title: "骑行情报") {
            if let weather = state.weather {
                VisorRow(title: weather.description, subtitle: "风速 \(weather.windSpeedKmh) km/h · \(weather.riderAdvice)") {
                    HStack(spacing: Visor.Space.s2) {
                        Text("\(weather.temperatureC)°")
                            .visorFont(.title, .semibold, mono: true)
                            .foregroundStyle(Visor.text)
                        Text(weather.riskLevel == .critical ? "高风险" : weather.riskLevel == .caution ? "注意" : "正常")
                            .visorFont(.caption, .bold)
                            .foregroundStyle(hazardColor(weather.riskLevel))
                    }
                }
            } else {
                VisorRow(title: "天气", subtitle: "激活后接入定位天气")
            }
            VisorRow(title: "路线") {
                Text("\(state.rideContext.speedKmh) km/h · \(state.rideContext.routePhase)")
                    .visorFont(.subhead, mono: true)
                    .foregroundStyle(Visor.textSecondary)
            }
            VisorRow(divider: false) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        VisorChip(label: state.sessionMemory.language == "zh" ? "中文" : "English")
                        VisorChip(label: responseModeLabel(state.sessionMemory.responseMode))
                        VisorChip(label: state.sessionMemory.lastIntent ?? "待识别")
                        if let destination = state.sessionMemory.destination {
                            VisorChip(label: destination, tint: Visor.accent)
                        }
                        VisorChip(label: "电量 \(state.rideContext.batteryPct)%", mono: true)
                    }
                }
            }
        }
    }

    // MARK: demo scenarios (ADAS hazard injection)

    private var demoGroup: some View {
        VisorGroup(title: "演示场景") {
            VisorSegmentedRow(
                title: "场景",
                options: DemoScenario.allCases.map {
                    VisorSegmentOption(value: $0, label: $0.label, tint: hazardColor($0.hazard))
                },
                selection: state.rideContext.scenario,
                divider: state.provider == "mock"
            ) { viewModel.setScenario($0) }
            // Guided tour of every scenario — mock provider only, like the web.
            if state.provider == "mock" {
                VisorToggleRow(
                    title: "巡游演示",
                    subtitle: state.guidedDemo ? "巡游中" : nil,
                    isOn: Binding(get: { state.guidedDemo }, set: { viewModel.setGuidedDemo($0) }),
                    divider: false
                )
            }
        }
    }

    // MARK: QA attribution

    private var qaGroup: some View {
        VisorGroup(
            title: "QA 任务归因",
            footer: "从网页管理台的 Release runs 复制任务标识。下一次会话会按构建、平台和任务进入发布证据矩阵。"
        ) {
            Group {
                qaField("Campaign ID", $viewModel.testingCampaignId)
                qaField("Test case ID", $viewModel.testingTestCaseId)
                qaField("Run ID（可选）", $viewModel.testingRunId)
                qaField("Assignment ID（可选）", $viewModel.testingAssignmentId)
            }
            .disabled(state.handsFree)
            VisorRow(divider: false) {
                Text("iOS · build \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown") · commit \(Bundle.main.infoDictionary?["HorizonGitCommit"] as? String ?? "unknown")")
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
        return VisorGroup(title: "诊断") {
            VisorRow(title: "延迟") {
                Text("\(state.latencyMs) ms")
                    .visorFont(.subhead, .semibold, mono: true)
                    .foregroundStyle(toneColor)
            }
            if let telemetry = state.telemetry {
                VisorRow(
                    title: "时序",
                    subtitle: "ASR \(telemetry.asrMs) · 思考 \(telemetry.thinkMs) · 首音 \(telemetry.firstAudioMs) · 总计 \(telemetry.totalMs)ms"
                )
            }
            VisorRow(title: "状态", subtitle: state.statusText)
            VisorChevronRow(title: "导出日志", enabled: hasTranscript) {
                if hasTranscript { viewModel.exportTranscript() }
            }
            VisorChevronRow(title: "清空日志", titleColor: Visor.danger, enabled: hasTranscript, divider: false) {
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
        case "demo": return "演示"
        case "pipeline": return "管线"
        default: return "实时"
        }
    }

    var body: some View {
        Button(action: action) {
            VisorRow(
                title: provider.label,
                subtitle: provider.configured ? provider.description : "需要 API Key",
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
        .opacity(provider.configured ? 1 : 0.5)
        .accessibilityLabel(provider.label)
        .accessibilityValue(provider.configured ? (selected ? "已选择" : "") : "需要 API Key")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
