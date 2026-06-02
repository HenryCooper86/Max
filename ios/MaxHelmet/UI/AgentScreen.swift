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

struct AgentScreen: View {
    @ObservedObject var viewModel: MainViewModel
    @ObservedObject var session: AgentSession

    private var state: AgentSession.State { session.state }

    var body: some View {
        VStack(spacing: 10) {
            HeaderBar(state: state)

            ScrollView {
                VStack(spacing: 12) {
                    RiderControls(state: state, viewModel: viewModel)
                    TurnStateRing(state: state)
                    Text(state.statusText)
                        .font(.system(size: 13))
                        .foregroundColor(HudColors.muted)
                    RidePulseCard(state: state)
                    if let weather = state.weather { WeatherCard(weather: weather) }
                    TelemetryCard(latencyMs: state.latencyMs, telemetry: state.telemetry)
                    TranscriptCard(items: state.transcript) { viewModel.exportTranscript() }
                }
                .padding(.bottom, 4)
            }

            BottomControls(state: state, viewModel: viewModel)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HudColors.background.ignoresSafeArea())
        .sheet(item: $viewModel.exportFile) { file in
            ActivityView(items: [file.url])
        }
    }
}

// MARK: - header

private struct HeaderBar: View {
    let state: AgentSession.State

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("MAX").font(.system(size: 22, weight: .bold)).foregroundColor(HudColors.text)
                Text("摩托车头盔 AI").font(.system(size: 12)).foregroundColor(HudColors.muted)
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
                Text(providerLine)
                    .font(.system(size: 11)).foregroundColor(HudColors.muted)
            }
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

// MARK: - rider controls

private struct RiderControls: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ChipRow(label: "声音") {
                ForEach(VoiceGender.allCases, id: \.self) { gender in
                    HudChip(label: gender.label, selected: state.voiceGender == gender) {
                        viewModel.setVoiceGender(gender)
                    }
                }
                Spacer().frame(width: 4)
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
            ChipRow(label: "场景") {
                ForEach(DemoScenario.allCases, id: \.self) { scenario in
                    HudChip(
                        label: scenario.label,
                        selected: state.rideContext.scenario == scenario,
                        selectedColor: hazardColor(scenario.hazard)
                    ) { viewModel.setScenario(scenario) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                .font(.system(size: 13))
                .foregroundColor(selected ? selectedColor : HudColors.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(selected ? selectedColor.opacity(0.18) : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(selected ? selectedColor : HudColors.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - helmet ring

private struct TurnStateRing: View {
    let state: AgentSession.State
    @State private var pulse: CGFloat = 0

    private var connected: Bool {
        state.connection != .offline && state.connection != .degraded
    }

    var body: some View {
        let color = ringColor(connected: connected, turnState: state.turnState)
        let caption = connected ? (turnCaptions[state.turnState] ?? "") : "离线"

        VStack(spacing: 2) {
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
                        circle(baseRadius + 18 * (0.6 + 0.4 * pulse)),
                        with: .color(color.opacity(0.12 + 0.10 * pulse)))
                    // Voice-level ring: expands as the rider speaks.
                    context.stroke(
                        circle(baseRadius + 14 * CGFloat(state.voiceLevel)),
                        with: .color(color.opacity(0.35)), lineWidth: 2)
                    // Main state ring.
                    context.stroke(circle(baseRadius), with: .color(color), lineWidth: 4)
                    // Inner fill.
                    context.fill(circle(baseRadius - 3), with: .color(color.opacity(0.10)))
                }
                .frame(width: 170, height: 170)

                Text(state.handsFree ? "免提中" : "MAX")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(color)
            }
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(caption).font(.system(size: 15)).foregroundColor(HudColors.text)
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

// MARK: - 态势摘要 (ride pulse)

private struct RidePulseCard: View {
    let state: AgentSession.State

    var body: some View {
        let fused = state.fusedHazard
        let color = hazardColor(fused)
        let context = state.rideContext
        let memory = state.sessionMemory

        HudCard(borderColor: color.opacity(0.5)) {
            CardHeader(title: "态势摘要", value: fused.label, valueColor: color)
            Text(fused.riderAction)
                .font(.system(size: 15, weight: .bold)).foregroundColor(HudColors.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(context.glanceableFocus)
                .font(.system(size: 12)).foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack {
                PulseCell(value: context.mode.label, label: "模式")
                Spacer()
                PulseCell(value: context.scenario.label, label: "场景")
                Spacer()
                PulseCell(value: networkLabel(context.network), label: "网络")
                Spacer()
                PulseCell(value: "\(context.batteryPct)%", label: "电量")
            }
            .padding(.top, 4)

            HStack(alignment: .bottom, spacing: 4) {
                Text("\(context.speedKmh)")
                    .font(.system(size: 26, weight: .bold)).foregroundColor(HudColors.text)
                Text("km/h").font(.system(size: 12)).foregroundColor(HudColors.muted).padding(.bottom, 3)
                Text(context.routePhase)
                    .font(.system(size: 12)).foregroundColor(HudColors.muted).padding(.bottom, 3)
                    .padding(.leading, 8)
                Spacer()
            }
            .padding(.top, 4)

            HStack(spacing: 6) {
                MemoryChip(label: memory.language == "zh" ? "中文" : "English")
                MemoryChip(label: responseModeLabel(memory.responseMode))
                MemoryChip(label: memory.lastIntent ?? "待识别")
                if let destination = memory.destination { MemoryChip(label: destination) }
            }
        }
    }
}

private struct PulseCell: View {
    let value: String
    let label: String
    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(.system(size: 14, weight: .bold)).foregroundColor(HudColors.text)
            Text(label).font(.system(size: 11)).foregroundColor(HudColors.muted)
        }
    }
}

private struct MemoryChip: View {
    let label: String
    var body: some View {
        Text(label)
            .font(.system(size: 11)).foregroundColor(HudColors.muted)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(HudColors.border.opacity(0.3)))
    }
}

// MARK: - weather

private struct WeatherCard: View {
    let weather: Weather
    var body: some View {
        let riskColor = hazardColor(weather.riskLevel)
        HudCard {
            CardHeader(title: "实时天气", value: weather.riskLevel.label, valueColor: riskColor)
            HStack(alignment: .bottom, spacing: 8) {
                Text("\(weather.temperatureC)°")
                    .font(.system(size: 26, weight: .bold)).foregroundColor(HudColors.text)
                Text(weather.description)
                    .font(.system(size: 14)).foregroundColor(HudColors.text).padding(.bottom, 3)
                Text("风速 \(weather.windSpeedKmh) km/h")
                    .font(.system(size: 12)).foregroundColor(HudColors.muted).padding(.bottom, 3)
                Spacer()
            }
            Text(weather.riderAdvice)
                .font(.system(size: 12)).foregroundColor(HudColors.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - telemetry

private struct TelemetryCard: View {
    let latencyMs: Int
    let telemetry: Telemetry?

    var body: some View {
        // latencyTone in src/main.tsx: <140 good, <280 warn, else alert.
        let toneColor: Color = latencyMs < 140 ? HudColors.accent : (latencyMs < 280 ? HudColors.warn : HudColors.danger)
        HudCard {
            CardHeader(title: "延迟", value: "\(latencyMs)ms", valueColor: toneColor)
            if let telemetry {
                HStack {
                    PulseCell(value: "\(telemetry.asrMs)ms", label: "ASR")
                    Spacer()
                    PulseCell(value: "\(telemetry.thinkMs)ms", label: "思考")
                    Spacer()
                    PulseCell(value: "\(telemetry.firstAudioMs)ms", label: "首音")
                    Spacer()
                    PulseCell(value: "\(telemetry.totalMs)ms", label: "总计")
                }
                .padding(.top, 4)
            }
        }
    }
}

// MARK: - transcript

private struct TranscriptCard: View {
    let items: [TranscriptItem]
    let onExport: () -> Void

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    var body: some View {
        HudCard {
            HStack {
                Text("对话记录").font(.system(size: 12)).foregroundColor(HudColors.muted)
                Spacer()
                if !items.isEmpty {
                    Text("实时 · \(items.count)").font(.system(size: 11)).foregroundColor(HudColors.muted)
                }
                HudChip(label: "导出日志", selected: !items.isEmpty, selectedColor: HudColors.accentCyan) {
                    if !items.isEmpty { onExport() }
                }
            }

            if items.isEmpty {
                Text("开启免提后，对话会显示在这里。")
                    .font(.system(size: 13)).foregroundColor(HudColors.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(items) { item in
                                TranscriptRow(item: item, time: timeFormatter.string(from: item.at))
                                    .id(item.id)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 240)
                    .onChange(of: items.count) { _, _ in
                        if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
                .padding(.top, 4)
            }
        }
    }
}

private struct TranscriptRow: View {
    let item: TranscriptItem
    let time: String

    var body: some View {
        let speakerColor = item.speaker == .rider ? HudColors.rider : HudColors.accent
        let speakerLabel = item.speaker == .rider ? "骑手" : "Max"
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(speakerLabel)
                    .font(.system(size: 12, weight: .bold)).foregroundColor(speakerColor)
                Text(time).font(.system(size: 10)).foregroundColor(HudColors.muted)
                if !item.final { Text("…").font(.system(size: 12)).foregroundColor(HudColors.muted) }
            }
            Text(item.text).font(.system(size: 14)).foregroundColor(HudColors.text)
        }
    }
}

// MARK: - bottom controls

private struct BottomControls: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        VStack(spacing: 8) {
            if !state.handsFree {
                TextField("语音中继地址（ws:// 或 wss://）", text: $viewModel.relayURL)
                    .font(.system(size: 14))
                    .foregroundColor(HudColors.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .padding(12)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(HudColors.border, lineWidth: 1))

                HStack {
                    Text("信任自签名证书（测试服务器）")
                        .font(.system(size: 12)).foregroundColor(HudColors.muted)
                    Spacer()
                    Toggle("", isOn: $viewModel.allowSelfSigned)
                        .labelsHidden()
                        .tint(HudColors.accent)
                }
            }

            Button(action: viewModel.toggleHandsFree) {
                Text(state.handsFree ? "结束免提" : "开启免提")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(state.handsFree ? HudColors.text : HudColors.onAccent)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 12)
                        .fill(state.handsFree ? HudColors.danger : HudColors.accent))
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - shared card scaffolding

private struct HudCard<Content: View>: View {
    var borderColor: Color = HudColors.border
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(HudColors.panel))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(borderColor, lineWidth: 1))
    }
}

private struct CardHeader: View {
    let title: String
    let value: String
    let valueColor: Color
    var body: some View {
        HStack {
            Text(title).font(.system(size: 12)).foregroundColor(HudColors.muted)
            Spacer()
            Text(value).font(.system(size: 13, weight: .bold)).foregroundColor(valueColor)
        }
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
