import SwiftUI

// MARK: - settings sheet scaffold

struct SettingsSheet<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(title)
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundColor(HudColors.text)
                    Spacer()
                    Button("完成") { dismiss() }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(HudColors.accent)
                }
                content
            }
            .padding(18)
        }
        .background(HudColors.background)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(HudColors.background)
    }
}
// MARK: - inline login form (settings → 账号)

private struct LoginFields: View {
    @ObservedObject var viewModel: MainViewModel
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        Text("使用网页测试平台的账号登录；登录后自动获取会话令牌。")
            .font(.system(size: 11)).foregroundColor(HudColors.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
        TextField("用户名", text: $username)
            .font(.system(size: 14))
            .foregroundColor(HudColors.text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
        SecureField("密码", text: $password)
            .font(.system(size: 14))
            .foregroundColor(HudColors.text)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
        if let error = viewModel.loginError {
            Text(error)
                .font(.system(size: 12))
                .foregroundColor(HudColors.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button {
            // Not cleared eagerly: on failure the rider shouldn't retype it;
            // on success this form unmounts (state discarded) anyway.
            viewModel.login(username: username, password: password)
        } label: {
            Text(viewModel.loginBusy ? "登录中…" : "登录")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(HudColors.background)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.accent))
        }
        .disabled(viewModel.loginBusy)
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
            startable = false
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

// MARK: - settings (account · voice · connection · demo · diagnostics)

struct SettingsPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel
    @State private var showUnpairConfirmation = false

    var body: some View {
        // Account: sign in with the same username/password as the web HUD; the
        // session token then rides the /agent URL automatically. The manual
        // 认证令牌 field below stays as the operator fallback.
        SectionCard(title: "账号") {
            if viewModel.isLoggedIn {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(viewModel.authDisplayName.isEmpty ? viewModel.authUsername : viewModel.authDisplayName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(HudColors.text)
                        Text("@\(viewModel.authUsername) · \(viewModel.authRole == "admin" ? "管理员" : "测试员")")
                            .font(.system(size: 12))
                            .foregroundColor(HudColors.muted)
                    }
                    Spacer()
                    Button("退出登录") { viewModel.logout() }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(HudColors.danger)
                }
            } else {
                LoginFields(viewModel: viewModel)
            }
        }

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
        SectionCard(title: "RDK 头盔") {
            Text(companion.statusText)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(HudColors.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("RDK 头盔状态：\(companion.statusText)")
            Text(companion.permissionText)
                .font(.system(size: 11))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(companion.forwardingText)
                .font(.system(size: 11))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Nearby helmets found via Bonjour (Task 11) — a discovered
            // beacon's token stands in for the six-digit code below.
            if !companion.discoveredHelmets.isEmpty {
                Text("附近的头盔")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(companion.discoveredHelmets) { helmet in
                    HStack {
                        Text("Max 头盔")
                            .font(.system(size: 13))
                            .foregroundColor(HudColors.text)
                        Spacer()
                        Button("配对") { viewModel.pairDiscoveredHelmet(token: helmet.token) }
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(HudColors.accent)
                            .disabled(!companion.isPairEnabledForDiscovery)
                    }
                }
            }
            if companion.isAwaitingHelmetConfirm {
                Text("等待头盔确认…请对头盔说\u{201C}确认\u{201D}")
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            TextField(
                "手动输入配对码",
                text: Binding(
                    get: { viewModel.pairCode },
                    set: { viewModel.pairCode = CompanionSettingsPresentation.filteredPairCode($0) }
                )
            )
            .font(.system(size: 14, design: .monospaced))
            .foregroundColor(HudColors.text)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
            .accessibilityLabel("RDK 头盔六位配对码")

            Button("配对头盔") { viewModel.pairHelmet() }
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(HudColors.accent)
                .disabled(!companion.isPairEnabled)
                .accessibilityHint("只建立配对，不会开始位置转发")

            Button(companion.primaryActionTitle) {
                if viewModel.helmetRideOwned {
                    viewModel.stopHelmetRide()
                } else {
                    viewModel.startHelmetRide()
                }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundColor(HudColors.background)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.accent))
            .disabled(!companion.isPrimaryActionEnabled)
            .accessibilityHint(viewModel.helmetRideOwned ? "停止向 RDK 头盔转发位置" : "从前台开始导航位置转发")

            if companion.showsUnpair {
                Button("取消配对", role: .destructive) { showUnpairConfirmation = true }
                    .font(.system(size: 13, weight: .semibold))
                    .disabled(!companion.isUnpairEnabled)
                    .confirmationDialog("取消 RDK 头盔配对？", isPresented: $showUnpairConfirmation) {
                        Button("取消配对", role: .destructive) { viewModel.unpairHelmet() }
                        Button("保留配对", role: .cancel) {}
                    } message: {
                        Text("Helmet Ride 会先停止，之后需要新的六位配对码才能重新连接。")
                    }
            }
        }
        // Scanning is scoped to this section's on-screen lifetime — starts
        // when the settings sheet (and thus this card) appears, stops when
        // it's dismissed. No background radio use.
        .onAppear { viewModel.startHelmetDiscovery() }
        .onDisappear { viewModel.stopHelmetDiscovery() }

        // Rider voice preferences.
        SectionCard(title: "语音") {
            ChipRow(label: "声音") {
                ForEach(VoiceGender.allCases, id: \.self) { gender in
                    HudChip(label: gender.label, selected: state.voiceGender == gender) {
                        viewModel.setVoiceGender(gender)
                    }
                }
            }
            ChipRow(label: "语气") {
                ForEach(VoicePersonality.allCases, id: \.self) { personality in
                    HudChip(label: personality.label, selected: state.voicePersonality == personality) {
                        viewModel.setVoicePersonality(personality)
                    }
                }
            }
            ChipRow(label: "模式") {
                ForEach(RideMode.allCases, id: \.self) { mode in
                    HudChip(
                        label: mode.label,
                        selected: state.rideContext.mode == mode,
                        selectedColor: mode == .emergency ? HudColors.danger : HudColors.accent
                    ) { viewModel.setRideMode(mode) }
                }
            }
        }

        // Server / relay connection.
        SectionCard(title: "连接") {
            if state.handsFree {
                Text("当前服务器：\(viewModel.relayURL)")
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("结束免提后可修改服务器地址。")
                    .font(.system(size: 11))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("语音中继地址（ws:// 或 wss://）")
                    .font(.system(size: 11)).foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TextField("语音中继地址", text: $viewModel.relayURL)
                    .font(.system(size: 14))
                    .foregroundColor(HudColors.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
                Text("认证令牌（网页登录后点「复制令牌（App 用）」获取；开放模式可留空）")
                    .font(.system(size: 11)).foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                SecureField("认证令牌", text: $viewModel.authToken)
                    .font(.system(size: 14))
                    .foregroundColor(HudColors.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
                #if DEBUG
                HStack {
                    Text("信任自签名证书（仅调试）")
                        .font(.system(size: 12)).foregroundColor(HudColors.muted)
                    Spacer()
                    Toggle("", isOn: $viewModel.allowSelfSigned)
                        .labelsHidden()
                        .tint(HudColors.accent)
                }
                #endif
            }
        }

        // Crash detection: emergency contact, relay opt-in, alarm-view call
        // target, and a log-only mode for collecting false-positive data.
        SectionCard(title: "紧急求助") {
            Text("紧急联系人号码").font(.system(size: 12)).foregroundColor(HudColors.muted)
            TextField("+86 …", text: $viewModel.crashContactNumber)
                .font(.system(size: 14))
                .foregroundColor(HudColors.text)
                .keyboardType(.phonePad)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))
                .disabled(state.handsFree)   // never mid-session
                .onSubmit { viewModel.resolveCrashContactIfNeeded() }

            HStack {
                Text("事故升级时通知紧急联系人（号码仅在升级时发送到服务器）")
                    .font(.system(size: 12)).foregroundColor(HudColors.muted)
                Spacer()
                Toggle("", isOn: $viewModel.crashRelayOptIn).labelsHidden().tint(HudColors.accent)
            }
            .disabled(state.handsFree)

            ChipRow(label: "警报界面拨打") {
                HudChip(label: "120", selected: viewModel.crashCallTarget == "120", selectedColor: HudColors.accent) {
                    viewModel.crashCallTarget = "120"
                }
                HudChip(label: "紧急联系人", selected: viewModel.crashCallTarget == "contact", selectedColor: HudColors.accent) {
                    viewModel.crashCallTarget = "contact"
                }
            }

            HStack {
                Text("仅记录模式（只记录检测，不报警 — 采集误报数据用）")
                    .font(.system(size: 12)).foregroundColor(HudColors.muted)
                Spacer()
                Toggle("", isOn: $viewModel.crashLogOnly).labelsHidden().tint(HudColors.accent)
            }
            .disabled(state.handsFree)
        }

        SectionCard(title: "QA 任务归因") {
            Text("从网页管理台的 Release runs 复制任务标识。下一次会话会按构建、平台和任务进入发布证据矩阵。")
                .font(.system(size: 11))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                TextField("Campaign ID", text: $viewModel.testingCampaignId)
                TextField("Test case ID", text: $viewModel.testingTestCaseId)
                TextField("Run ID（可选）", text: $viewModel.testingRunId)
                TextField("Assignment ID（可选）", text: $viewModel.testingAssignmentId)
            }
            .font(.system(size: 13))
            .foregroundColor(HudColors.text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 9).fill(HudColors.panelElevated))
            .disabled(state.handsFree)
            Text("iOS · build \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown") · commit \(Bundle.main.infoDictionary?["HorizonGitCommit"] as? String ?? "unknown")")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        // Live ride intelligence: weather, route, and session memory. The data
        // already flows over the protocol (weather / ride.context /
        // session.memory events); this surfaces it like the web HUD instruments.
        SectionCard(title: "骑行情报") {
            if let weather = state.weather {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(weather.temperatureC)°")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundColor(HudColors.text)
                    Text(weather.description)
                        .font(.system(size: 14))
                        .foregroundColor(HudColors.text)
                    Text("风速 \(weather.windSpeedKmh) km/h")
                        .font(.system(size: 12))
                        .foregroundColor(HudColors.muted)
                    Spacer()
                    Text(weather.riskLevel == .critical ? "高风险" : weather.riskLevel == .caution ? "注意" : "正常")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(hazardColor(weather.riskLevel))
                }
                Text(weather.riderAdvice)
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("激活后接入定位天气")
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("\(state.rideContext.speedKmh) km/h · \(state.rideContext.routePhase)")
                .font(.system(size: 12))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                InfoChip(label: state.sessionMemory.language == "zh" ? "中文" : "English")
                InfoChip(label: responseModeLabel(state.sessionMemory.responseMode))
                InfoChip(label: state.sessionMemory.lastIntent ?? "待识别")
                if let destination = state.sessionMemory.destination {
                    InfoChip(label: destination, tint: HudColors.accentCyan)
                }
                Spacer(minLength: 0)
                InfoChip(label: "电量 \(state.rideContext.batteryPct)%")
            }
        }

        // Demo scenarios (ADAS hazard injection).
        SectionCard(title: "演示场景") {
            ChipRow(label: "场景") {
                ForEach(DemoScenario.allCases, id: \.self) { scenario in
                    HudChip(
                        label: scenario.label,
                        selected: state.rideContext.scenario == scenario,
                        selectedColor: hazardColor(scenario.hazard)
                    ) { viewModel.setScenario(scenario) }
                }
            }
            // Guided tour of every scenario — mock provider only, like the web.
            if state.provider == "mock" {
                ChipRow(label: "巡游") {
                    HudChip(
                        label: state.guidedDemo ? "■ 巡游中" : "▶ 巡游演示",
                        selected: state.guidedDemo,
                        selectedColor: HudColors.accentCyan
                    ) { viewModel.setGuidedDemo(!state.guidedDemo) }
                }
            }
        }

        // Diagnostics: latency, telemetry, transcript export, raw status.
        SectionCard(title: "诊断") {
            let toneColor: Color = state.latencyMs < 140
                ? HudColors.accent
                : (state.latencyMs < 280 ? HudColors.warn : HudColors.danger)
            HStack {
                Text("延迟").font(.system(size: 11)).foregroundColor(HudColors.muted)
                Text("\(state.latencyMs)ms")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(toneColor)
                Spacer()
                HudChip(label: "导出日志", selected: !state.transcript.isEmpty, selectedColor: HudColors.accentCyan) {
                    if !state.transcript.isEmpty { viewModel.exportTranscript() }
                }
                HudChip(label: "清空", selected: !state.transcript.isEmpty, selectedColor: HudColors.danger) {
                    if !state.transcript.isEmpty { viewModel.clearTranscript() }
                }
            }
            if let telemetry = state.telemetry {
                Text("ASR \(telemetry.asrMs) · 思考 \(telemetry.thinkMs) · 首音 \(telemetry.firstAudioMs) · 总计 \(telemetry.totalMs)ms")
                    .font(.system(size: 11)).foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(state.statusText)
                .font(.system(size: 12))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Small read-only status chip (session memory / battery readouts).
private struct InfoChip: View {
    let label: String
    var tint: Color = HudColors.muted

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(tint)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule().fill(HudColors.panel))
    }
}

private struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        HudCard {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(HudColors.muted)
            content
        }
    }
}

private struct ChipRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            Text(label)
                .font(.system(size: 11)).foregroundColor(HudColors.muted)
                .frame(width: 34, alignment: .leading)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) { content }
            }
        }
    }
}

private struct HudChip: View {
    let label: String
    let selected: Bool
    var selectedColor: Color = HudColors.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 13, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? selectedColor : HudColors.muted)
                .padding(.horizontal, 13)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(selected ? selectedColor.opacity(0.16) : HudColors.panelElevated)
                )
                .overlay(
                    Capsule().stroke(selected ? selectedColor.opacity(0.7) : Color.clear, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
