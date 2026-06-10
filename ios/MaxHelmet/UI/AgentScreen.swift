import SwiftUI

// Captions and orb palette ported from src/components/HelmetVisual.tsx and
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

/// The orb's hue follows the session: a calm green invites a tap when idle,
/// amber while connecting, then the per-turn ring color once live.
private func orbColor(_ state: AgentSession.State) -> Color {
    guard state.handsFree else { return HudColors.accent }
    switch state.connection {
    case .offline, .degraded: return HudColors.danger
    case .connecting, .provider: return HudColors.warn
    case .relay, .ready: return ringColor(connected: true, turnState: state.turnState)
    }
}

/// The single line under the orb — the only words on the clean screen.
private func orbCaption(_ state: AgentSession.State) -> String {
    guard state.handsFree else { return "点按光球，开始对话" }
    if state.micMuted { return "麦克风已静音" }
    switch state.connection {
    case .ready: return turnCaptions[state.turnState] ?? ""
    default: return connectionLabel(state.connection)
    }
}

/// Pure voice-mode main screen, in the spirit of ChatGPT's voice mode: a dark
/// glow, one big animated orb that breathes with the conversation and swells
/// with the rider's voice, a single status caption, and minimal controls. The
/// safety-critical ADAS hazard banner still pins to the top. Rider preferences
/// and the developer panel open as sheets; captions are optional under the orb.
struct AgentScreen: View {
    @ObservedObject var viewModel: MainViewModel
    @ObservedObject var session: AgentSession

    private var state: AgentSession.State { session.state }

    var body: some View {
        let color = orbColor(state)

        ZStack {
            BackgroundGlow(color: color)

            VStack(spacing: 14) {
                StatusPill(
                    state: state,
                    devMode: viewModel.devMode,
                    onLongPress: {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        viewModel.toggleDevMode()
                    }
                )

                if let alert = state.hazardAlert {
                    HazardBanner(alert: alert).padding(.horizontal, 4)
                }

                Spacer(minLength: 8)

                VoiceOrb(
                    color: color,
                    turnState: state.turnState,
                    voiceLevel: state.voiceLevel,
                    dimmed: state.micMuted,
                    onTap: viewModel.toggleHandsFree
                )

                CaptionLine(text: orbCaption(state), color: color)

                Spacer(minLength: 8)

                if viewModel.showCaptions {
                    CaptionsOverlay(items: state.transcript)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                SecondaryControls(viewModel: viewModel)

                PrimaryControls(state: state, viewModel: viewModel)
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 18)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.background.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.25), value: viewModel.showCaptions)
        .animation(.easeInOut(duration: 0.25), value: state.micMuted)
        .sheet(isPresented: $viewModel.showPreferences) {
            SettingsSheet(title: "偏好设置", detent: .medium) {
                PreferencesPanel(state: state, viewModel: viewModel)
            }
        }
        .sheet(isPresented: $viewModel.showDevPanel) {
            SettingsSheet(title: "开发者模式", detent: .large) {
                DevPanel(state: state, viewModel: viewModel)
            }
        }
        .sheet(item: $viewModel.exportFile) { file in
            ActivityView(items: [file.url])
        }
    }
}

// MARK: - background glow

private struct BackgroundGlow: View {
    let color: Color

    var body: some View {
        RadialGradient(
            gradient: Gradient(colors: [color.opacity(0.20), .clear]),
            center: .center,
            startRadius: 0,
            endRadius: 420
        )
        .blur(radius: 50)
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.6), value: color)
    }
}

// MARK: - top status pill (long-press toggles the developer panel)

private struct StatusPill: View {
    let state: AgentSession.State
    let devMode: Bool
    let onLongPress: () -> Void

    var body: some View {
        let online = state.connection == .ready
        HStack(spacing: 8) {
            Circle()
                .fill(online ? HudColors.accent : HudColors.muted)
                .frame(width: 7, height: 7)
            Text("Max")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundColor(HudColors.text)
            Text("·").foregroundColor(HudColors.muted)
            Text(connectionLabel(state.connection))
                .font(.system(size: 13))
                .foregroundColor(HudColors.muted)
            if devMode {
                Text("· 开发者")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(HudColors.accentCyan)
            }
            if state.bluetoothRouted {
                Image(systemName: "headphones")
                    .font(.system(size: 11))
                    .foregroundColor(HudColors.muted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Capsule().fill(HudColors.panelElevated.opacity(0.7)))
        .contentShape(Capsule())
        // Hidden gesture: long-press the status pill to toggle developer mode.
        .onLongPressGesture(minimumDuration: 0.8, perform: onLongPress)
    }
}

// MARK: - ADAS hazard banner (safety-critical: kept on every screen)

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

// MARK: - voice orb

/// A glowing, breathing sphere that reacts to the session: it breathes faster
/// while thinking, ripples outward with the rider's voice level, and shows a
/// rotating shimmer while Max thinks. Tapping it toggles hands-free.
private struct VoiceOrb: View {
    let color: Color
    let turnState: TurnState
    let voiceLevel: Float
    let dimmed: Bool
    var onTap: () -> Void

    private var breatheSpeed: Double {
        switch turnState {
        case .idle: return 0.9
        case .listening, .hearing: return 1.7
        case .thinking: return 2.7
        case .speaking: return 2.1
        }
    }

    private var pulseAmplitude: Double {
        switch turnState {
        case .idle: return 0.05
        case .listening, .hearing: return 0.10
        case .thinking: return 0.14
        case .speaking: return 0.17
        }
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let level = Double(max(0, min(1, voiceLevel)))
            let breathe = 0.5 + 0.5 * sin(t * breatheSpeed)          // 0…1
            let pulse = pulseAmplitude * breathe + 0.28 * level       // swell
            let coreScale = 1.0 + pulse

            ZStack {
                // Outer halo — soft colored bloom.
                Circle()
                    .fill(
                        RadialGradient(
                            gradient: Gradient(colors: [color.opacity(0.42), .clear]),
                            center: .center, startRadius: 8, endRadius: 150
                        )
                    )
                    .scaleEffect(1.18 + 0.16 * breathe + 0.30 * level)
                    .blur(radius: 22)

                // Voice ripple — expands as the rider speaks.
                Circle()
                    .stroke(color.opacity(0.5), lineWidth: 2)
                    .scaleEffect(0.82 + 0.55 * level + 0.08 * breathe)
                    .opacity(0.15 + 0.7 * level)

                // Core sphere — offset highlight reads as a lit orb.
                Circle()
                    .fill(
                        RadialGradient(
                            gradient: Gradient(colors: [
                                Color.white.opacity(0.92),
                                color,
                                color.opacity(0.72)
                            ]),
                            center: UnitPoint(x: 0.40, y: 0.34),
                            startRadius: 3, endRadius: 118
                        )
                    )
                    .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 1))
                    .scaleEffect(coreScale)
                    .shadow(color: color.opacity(0.55), radius: 28)

                // Thinking shimmer — a rotating highlight arc.
                if turnState == .thinking {
                    Circle()
                        .trim(from: 0, to: 0.28)
                        .stroke(
                            Color.white.opacity(0.55),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round)
                        )
                        .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 2) * 180))
                        .scaleEffect(coreScale * 1.04)
                }
            }
        }
        .frame(width: 250, height: 250)
        .opacity(dimmed ? 0.5 : 1)
        .contentShape(Circle())
        .onTapGesture { onTap() }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(turnState == .idle ? "开启免提" : "结束免提")
    }
}

// MARK: - caption line

private struct CaptionLine: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 18, weight: .medium, design: .rounded))
            .foregroundColor(HudColors.text)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .animation(.easeInOut(duration: 0.2), value: text)
    }
}

// MARK: - optional captions overlay (字幕)

private struct CaptionsOverlay: View {
    let items: [TranscriptItem]

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if items.isEmpty {
                Text("暂无字幕")
                    .font(.system(size: 13))
                    .foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 18)
            } else {
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
                    .frame(height: 190)
                    .scrollIndicators(.hidden)
                    .onChange(of: items.count) { _, _ in
                        if let last = items.last {
                            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18).fill(HudColors.panel))
    }
}

// MARK: - secondary controls (字幕 · 偏好 · 开发者)

private struct SecondaryControls: View {
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HStack(spacing: 10) {
            PillToggle(
                icon: "captions.bubble",
                label: "字幕",
                on: viewModel.showCaptions
            ) { viewModel.showCaptions.toggle() }

            Spacer(minLength: 0)

            if viewModel.devMode {
                PillToggle(icon: "wrench.and.screwdriver", label: "开发", on: false) {
                    viewModel.showDevPanel = true
                }
            }

            PillToggle(icon: "gearshape.fill", label: "偏好", on: false) {
                viewModel.showPreferences = true
            }
        }
    }
}

private struct PillToggle: View {
    let icon: String
    let label: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 13, weight: .semibold))
                Text(label).font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(on ? HudColors.accent : HudColors.muted)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                Capsule().fill(on ? HudColors.accent.opacity(0.16) : HudColors.panelElevated)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - primary controls (start · mute · end)

private struct PrimaryControls: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        Group {
            if state.handsFree {
                HStack(spacing: 44) {
                    CircleControl(
                        icon: state.micMuted ? "mic.slash.fill" : "mic.fill",
                        tint: state.micMuted ? HudColors.warn : HudColors.text,
                        background: HudColors.panelElevated,
                        label: state.micMuted ? "取消静音" : "静音",
                        action: viewModel.toggleMute
                    )
                    CircleControl(
                        icon: "xmark",
                        tint: .white,
                        background: HudColors.danger,
                        label: "结束",
                        action: viewModel.toggleHandsFree
                    )
                }
            } else {
                CircleControl(
                    icon: "mic.fill",
                    tint: HudColors.onAccent,
                    background: HudColors.accent,
                    diameter: 76,
                    label: "开始",
                    action: viewModel.toggleHandsFree
                )
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 2)
    }
}

private struct CircleControl: View {
    let icon: String
    let tint: Color
    let background: Color
    var diameter: CGFloat = 64
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                ZStack {
                    Circle().fill(background).frame(width: diameter, height: diameter)
                    Image(systemName: icon)
                        .font(.system(size: diameter * 0.34, weight: .semibold))
                        .foregroundColor(tint)
                }
                Text(label).font(.system(size: 12)).foregroundColor(HudColors.muted)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - settings sheet scaffold

private struct SettingsSheet<Content: View>: View {
    let title: String
    let detent: PresentationDetent
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
        .presentationDetents([detent])
        .presentationDragIndicator(.visible)
        .presentationBackground(HudColors.background)
    }
}

// MARK: - rider preferences

private struct PreferencesPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HudCard {
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

// MARK: - conversation bubble (used by the captions overlay)

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

// MARK: - developer panel (open from the wrench when developer mode is on)

private struct DevPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HudCard(borderColor: HudColors.accentCyan.opacity(0.4)) {
            HStack {
                Text("会话与遥测")
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

// MARK: - shared card scaffolding

private struct HudCard<Content: View>: View {
    var borderColor: Color = .clear
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(HudColors.panelElevated))
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
