import SwiftUI

// Captions and ring palette ported from src/components/HelmetVisual.tsx and
// android/.../ui/AgentScreen.kt.
private let turnCaptions: [TurnState: String] = [
    .idle: "待机",
    .listening: "免提待命 · 请讲话",
    .hearing: "正在聆听…",
    .thinking: "Max 思考中…",
    .speaking: "Max 回答中"
]

private func ringColor(connected: Bool, turnState: TurnState) -> Color {
    guard connected else { return HudColors.danger }
    switch turnState {
    case .idle: return HudColors.accent
    case .listening, .hearing: return HudColors.accentCyan
    case .thinking: return HudColors.warn
    case .speaking: return HudColors.accent
    }
}

private func hazardColor(_ hazard: HazardLevel) -> Color {
    switch hazard {
    case .normal: return HudColors.accent
    case .caution: return HudColors.warn
    case .critical: return HudColors.danger
    }
}

private func connectionLabel(_ state: ConnectionState) -> String {
    switch state {
    case .offline: return "离线"
    case .connecting: return "连接中"
    case .relay: return "中继在线"
    case .provider: return "代理握手"
    case .ready: return "已就绪"
    case .degraded: return "降级"
    }
}

/// Production-clean main screen: brand header, hazard alerts, hero ring,
/// glance strip, conversation, hands-free button. Rider preferences live behind
/// the gear; all test settings live in a developer panel revealed by
/// long-pressing the Max logo (persisted across launches).
struct AgentScreen: View {
    @ObservedObject var viewModel: MainViewModel
    @ObservedObject var session: AgentSession

    private var state: AgentSession.State { session.state }

    var body: some View {
        VStack(spacing: 12) {
            HeaderBar(
                state: state,
                devMode: viewModel.devMode,
                preferencesShown: viewModel.showPreferences,
                onToggleDevMode: viewModel.toggleDevMode,
                onTogglePreferences: { viewModel.showPreferences.toggle() }
            )

            if let alert = state.hazardAlert { HazardBanner(alert: alert) }

            ScrollView {
                VStack(spacing: 14) {
                    if viewModel.showPreferences {
                        PreferencesPanel(state: state, viewModel: viewModel)
                    }

                    TurnStateRing(state: state, onTap: viewModel.toggleHandsFree)
                        .padding(.top, 6)

                    GlanceStrip(state: state)

                    if state.transcript.isEmpty {
                        Text("点按 Max 圆环开始对话")
                            .font(.system(size: 13))
                            .foregroundColor(HudColors.muted)
                            .padding(.top, 2)
                    } else {
                        ConversationCard(items: state.transcript)
                    }

                    if viewModel.devMode {
                        DevPanel(state: state, viewModel: viewModel)
                    }
                }
                .padding(.bottom, 4)
            }
            .scrollIndicators(.hidden)

            HandsFreeButton(handsFree: state.handsFree, action: viewModel.toggleHandsFree)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        // Cap the HUD width and center it so it reads as a phone-width column on
        // iPad/large screens instead of stretching edge-to-edge (matches Android
        // and the web's centered, max-width shell). iPhones are narrower than the
        // cap, so they are unaffected.
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.background.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.2), value: viewModel.showPreferences)
        .animation(.easeInOut(duration: 0.2), value: viewModel.devMode)
        .sheet(item: $viewModel.exportFile) { file in
            ActivityView(items: [file.url])
        }
    }
}

// MARK: - ADAS hazard banner

private struct HazardBanner: View {
    let alert: HazardAlert

    var body: some View {
        let color = hazardColor(alert.severity)
        HStack(spacing: 12) {
            Text(alert.directionLabel)
                .font(.system(size: 17, weight: .heavy))
                .foregroundColor(HudColors.text)
                .frame(minWidth: 56)
                .padding(.vertical, 8)
                .padding(.horizontal, 8)
                .background(color.opacity(0.22))
                .cornerRadius(10)
            VStack(alignment: .leading, spacing: 2) {
                Text("⚠️ \(alert.label)")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(HudColors.text)
                Text("\(alert.message) \(alert.advice)")
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Text("\(alert.ttcSeconds)s")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(color)
        }
        .padding(12)
        .background(color.opacity(0.12))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(color, lineWidth: 1))
        .cornerRadius(14)
    }
}

// MARK: - header

private struct HeaderBar: View {
    let state: AgentSession.State
    let devMode: Bool
    let preferencesShown: Bool
    let onToggleDevMode: () -> Void
    let onTogglePreferences: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Max")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundColor(HudColors.text)
                Text(devMode ? "摩托车头盔 AI · 开发者模式" : "摩托车头盔 AI")
                    .font(.system(size: 12))
                    .foregroundColor(devMode ? HudColors.accentCyan : HudColors.muted)
            }
            .contentShape(Rectangle())
            // Hidden gesture: long-press the logo to toggle the developer panel.
            .onLongPressGesture(minimumDuration: 0.8) {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onToggleDevMode()
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                let online = state.connection == .ready
                HStack(spacing: 6) {
                    Circle()
                        .fill(online ? HudColors.accent : HudColors.muted)
                        .frame(width: 8, height: 8)
                    Text(connectionLabel(state.connection))
                        .font(.system(size: 13)).foregroundColor(HudColors.text)
                }
                if devMode {
                    Text(providerLine)
                        .font(.system(size: 11)).foregroundColor(HudColors.muted)
                } else if state.bluetoothRouted {
                    Text("蓝牙耳机")
                        .font(.system(size: 11)).foregroundColor(HudColors.muted)
                }
            }

            Button(action: onTogglePreferences) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(preferencesShown ? HudColors.accent : HudColors.muted)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(HudColors.panelElevated))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("偏好设置")
        }
    }

    private var providerLine: String {
        let providerLabel: String
        if state.provider.isEmpty { providerLabel = "未连接" }
        else if state.isLive { providerLabel = "豆包实时语音" }
        else { providerLabel = "模拟语音" }
        let bluetooth = state.bluetoothRouted ? " · 蓝牙耳机" : ""
        let latency = state.latencyMs > 0 ? " · \(state.latencyMs)ms" : ""
        return providerLabel + bluetooth + latency
    }
}

// MARK: - rider preferences (gear)

private struct PreferencesPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HudCard {
            Text("偏好设置")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(HudColors.muted)
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

// MARK: - hero ring

private struct TurnStateRing: View {
    let state: AgentSession.State
    /// Tapping the big ring toggles hands-free — the gesture riders reach for first.
    var onTap: () -> Void
    @State private var pulse: CGFloat = 0

    private var connected: Bool {
        state.connection != .offline && state.connection != .degraded
    }

    var body: some View {
        let color = ringColor(connected: connected, turnState: state.turnState)
        let caption = connected ? (turnCaptions[state.turnState] ?? "") : "离线"

        VStack(spacing: 6) {
            ZStack {
                Canvas { context, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let baseRadius = min(size.width, size.height) * 0.36

                    func circle(_ radius: CGFloat) -> Path {
                        Path(ellipseIn: CGRect(
                            x: center.x - radius, y: center.y - radius,
                            width: radius * 2, height: radius * 2))
                    }
                    // Soft outer glow ring, breathing with the pulse animation.
                    context.fill(
                        circle(baseRadius + 22 * (0.6 + 0.4 * pulse)),
                        with: .color(color.opacity(0.10 + 0.10 * pulse)))
                    // Voice-level ring: expands as the rider speaks.
                    context.stroke(
                        circle(baseRadius + 16 * CGFloat(state.voiceLevel)),
                        with: .color(color.opacity(0.35)), lineWidth: 2)
                    // Main state ring.
                    context.stroke(circle(baseRadius), with: .color(color), lineWidth: 3.5)
                    // Inner fill.
                    context.fill(circle(baseRadius - 3), with: .color(color.opacity(0.08)))
                }
                .frame(width: 210, height: 210)

                Text(state.handsFree ? "免提中" : "Max")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundColor(color)
            }
            .contentShape(Circle())
            .onTapGesture { onTap() }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(state.handsFree ? "结束免提" : "开启免提")

            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(caption).font(.system(size: 15, weight: .medium)).foregroundColor(HudColors.text)
            }
        }
        .frame(maxWidth: .infinity)
        .onAppear {
            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: true)) {
                pulse = 1
            }
        }
    }
}

// MARK: - glance strip (speed · risk · weather · battery)

private struct GlanceStrip: View {
    let state: AgentSession.State

    var body: some View {
        let fused = state.fusedHazard
        let context = state.rideContext

        HudCard {
            HStack {
                GlanceCell(value: "\(context.speedKmh)", unit: "km/h", label: "速度")
                Spacer()
                GlanceCell(value: fused.label, label: "风险", valueColor: hazardColor(fused))
                Spacer()
                if let weather = state.weather {
                    GlanceCell(value: "\(weather.temperatureC)°", label: weather.description)
                } else {
                    GlanceCell(value: "--", label: "天气")
                }
                Spacer()
                GlanceCell(value: "\(context.batteryPct)%", label: "电量")
            }

            if fused != .normal {
                Text(fused.riderAction)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(hazardColor(fused))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
            if let weather = state.weather, weather.riskLevel != .normal {
                Text(weather.riderAdvice)
                    .font(.system(size: 12))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct GlanceCell: View {
    let value: String
    var unit: String = ""
    let label: String
    var valueColor: Color = HudColors.text

    var body: some View {
        VStack(spacing: 2) {
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                Text(value)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(valueColor)
                if !unit.isEmpty {
                    Text(unit).font(.system(size: 10)).foregroundColor(HudColors.muted)
                }
            }
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(HudColors.muted)
                .lineLimit(1)
        }
    }
}

// MARK: - conversation

private struct ConversationCard: View {
    let items: [TranscriptItem]

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        HudCard {
            HStack {
                Text("对话")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(HudColors.muted)
                Spacer()
                Text("\(items.count)")
                    .font(.system(size: 11)).foregroundColor(HudColors.muted)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(items) { item in
                            ChatBubble(item: item, time: timeFormatter.string(from: item.at))
                                .id(item.id)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .frame(height: 250)
                .scrollIndicators(.hidden)
                .onChange(of: items.count) { _, _ in
                    if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            .padding(.top, 2)
        }
    }
}

private struct ChatBubble: View {
    let item: TranscriptItem
    let time: String

    private var isRider: Bool { item.speaker == .rider }

    var body: some View {
        HStack {
            if isRider { Spacer(minLength: 40) }
            VStack(alignment: isRider ? .trailing : .leading, spacing: 3) {
                Text(item.text)
                    .font(.system(size: 14))
                    .foregroundColor(HudColors.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(isRider ? HudColors.rider.opacity(0.16) : HudColors.panelElevated)
                    )
                HStack(spacing: 5) {
                    Text(isRider ? "骑手" : "Max")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(isRider ? HudColors.rider : HudColors.accent)
                    Text(time).font(.system(size: 10)).foregroundColor(HudColors.muted)
                    if !item.final {
                        Text("…").font(.system(size: 10)).foregroundColor(HudColors.muted)
                    }
                }
            }
            if !isRider { Spacer(minLength: 40) }
        }
    }
}

// MARK: - developer panel (long-press the logo)

private struct DevPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HudCard(borderColor: HudColors.accentCyan.opacity(0.4)) {
            HStack {
                Text("开发者模式")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(HudColors.accentCyan)
                Spacer()
                HudChip(label: "导出日志", selected: !state.transcript.isEmpty, selectedColor: HudColors.accentCyan) {
                    if !state.transcript.isEmpty { viewModel.exportTranscript() }
                }
            }

            Text(state.statusText)
                .font(.system(size: 12))
                .foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)

            ChipRow(label: "场景") {
                ForEach(DemoScenario.allCases, id: \.self) { scenario in
                    HudChip(
                        label: scenario.label,
                        selected: state.rideContext.scenario == scenario,
                        selectedColor: hazardColor(scenario.hazard)
                    ) { viewModel.setScenario(scenario) }
                }
            }

            // latencyTone in src/main.tsx: <140 good, <280 warn, else alert.
            let toneColor: Color = state.latencyMs < 140
                ? HudColors.accent
                : (state.latencyMs < 280 ? HudColors.warn : HudColors.danger)
            HStack {
                Text("延迟").font(.system(size: 11)).foregroundColor(HudColors.muted)
                Text("\(state.latencyMs)ms")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(toneColor)
                Spacer()
                if let telemetry = state.telemetry {
                    Text("ASR \(telemetry.asrMs) · 思考 \(telemetry.thinkMs) · 首音 \(telemetry.firstAudioMs) · 总计 \(telemetry.totalMs)ms")
                        .font(.system(size: 11)).foregroundColor(HudColors.muted)
                }
            }
            .padding(.top, 2)

            if !state.handsFree {
                TextField("语音中继地址（ws:// 或 wss://）", text: $viewModel.relayURL)
                    .font(.system(size: 14))
                    .foregroundColor(HudColors.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(HudColors.panelElevated))

                HStack {
                    Text("信任自签名证书（测试服务器）")
                        .font(.system(size: 12)).foregroundColor(HudColors.muted)
                    Spacer()
                    Toggle("", isOn: $viewModel.allowSelfSigned)
                        .labelsHidden()
                        .tint(HudColors.accent)
                }
            }
        }
    }
}

// MARK: - hands-free button

private struct HandsFreeButton: View {
    let handsFree: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(handsFree ? "结束免提" : "开启免提")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(handsFree ? HudColors.text : HudColors.onAccent)
                .padding(.vertical, 15)
                .frame(maxWidth: .infinity)
                .background(Capsule().fill(handsFree ? HudColors.danger : HudColors.accent))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - shared card scaffolding

private struct HudCard<Content: View>: View {
    var borderColor: Color = .clear
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(HudColors.panel))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(borderColor, lineWidth: 1))
    }
}

// MARK: - share sheet (transcript export)

private struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
