import SwiftUI

// Captions and palette ported from src/components/HelmetVisual.tsx and
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

/// The glow's hue follows the session: a calm green invites a tap when idle,
/// amber while connecting, then the per-turn ring color once live. The fused
/// hazard (ride + weather, see State.fusedHazard) overrides the conversational
/// palette — safety tint always wins, mirroring the web HelmetVisual.
private func orbColor(_ state: AgentSession.State) -> Color {
    if state.fusedHazard != .normal { return hazardColor(state.fusedHazard) }
    guard state.handsFree else { return HudColors.accent }
    switch state.connection {
    case .offline, .degraded: return HudColors.danger
    case .connecting, .provider: return HudColors.warn
    case .relay, .ready: return ringColor(connected: true, turnState: state.turnState)
    }
}

/// The single line under the helmet — the only words on the clean screen.
/// An elevated fused hazard prefixes the caption with the safety call-out.
private func orbCaption(_ state: AgentSession.State) -> String {
    let base: String
    if !state.handsFree {
        base = "点按头盔，开始对话"
    } else if state.micMuted {
        base = "麦克风已静音"
    } else if state.connection == .ready {
        base = turnCaptions[state.turnState] ?? ""
    } else {
        base = connectionLabel(state.connection)
    }
    switch state.fusedHazard {
    case .normal: return base
    case .caution: return "注意路况 · " + base
    case .critical: return "高风险 · 优先安全 · " + base
    }
}

/// Pure voice-mode main screen, in the spirit of ChatGPT's voice mode: a dark
/// glow with the helmet centerpiece breathing and glowing with the conversation,
/// a single status caption, and minimal controls. The safety-critical ADAS hazard
/// banner pins to the top. All rider + test settings live in the gear sheet;
/// captions are optional under the helmet.
struct AgentScreen: View {
    @ObservedObject var viewModel: MainViewModel
    @ObservedObject var session: AgentSession

    private var state: AgentSession.State { session.state }

    var body: some View {
        let color = orbColor(state)

        ZStack {
            BackgroundGlow(color: color)

            VStack(spacing: 14) {
                StatusPill(state: state)

                if let alert = state.hazardAlert {
                    HazardBanner(alert: alert).padding(.horizontal, 4)
                }

                Spacer(minLength: 8)

                HelmetVisual(
                    color: color,
                    turnState: state.turnState,
                    voiceLevel: state.voiceLevel,
                    dimmed: state.micMuted,
                    hazard: state.fusedHazard,
                    onTap: viewModel.toggleHandsFree
                )

                CaptionLine(text: orbCaption(state))

                Spacer(minLength: 8)

                if viewModel.showCaptions {
                    CaptionsOverlay(
                        items: state.transcript,
                        canFlag: { state.canFlagTurn($0) },
                        onFlag: { item, reason in viewModel.flagTurn(item, reason: reason) }
                    )
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
        // The relay requires a login (HTTP 401): open the settings sheet on the
        // 账号 section so the rider can sign in right where the fix is.
        .onChange(of: state.authRequired) { _, required in
            // Handles the stale-identity case too: a 401 while "logged in"
            // means the stored session died server-side — the view model drops
            // it so the login form (not the identity row) is what opens.
            if required { viewModel.handleAuthRequired() }
        }
        .sheet(isPresented: $viewModel.showPreferences) {
            SettingsSheet(title: "设置") {
                SettingsPanel(state: state, viewModel: viewModel)
            }
            // Attached to the settings sheet so 导出日志 (tapped from inside it)
            // can present the share sheet stacked on top — a second .sheet on the
            // main screen would be blocked while the settings sheet is up.
            .sheet(item: $viewModel.exportFile) { file in
                ActivityView(items: [file.url])
            }
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

// MARK: - top status pill

private struct StatusPill: View {
    let state: AgentSession.State

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
            if state.bluetoothRouted {
                Image(systemName: "headphones")
                    .font(.system(size: 11))
                    .foregroundColor(HudColors.muted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Capsule().fill(HudColors.panelElevated.opacity(0.7)))
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

// MARK: - helmet centerpiece

/// The brand helmet (shell + chin + visor + status dots), ported from the web
/// HelmetVisual SVG. A state-tinted halo behind it breathes with the turn state
/// and ripples outward with the rider's voice; the visor glows while Max listens
/// or speaks. Tapping it toggles hands-free.
private struct HelmetVisual: View {
    let color: Color
    let turnState: TurnState
    let voiceLevel: Float
    let dimmed: Bool
    /// Fused ride + weather hazard; critical adds a ~0.9s opacity pulse.
    let hazard: HazardLevel
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
        case .idle: return 0.03
        case .listening, .hearing: return 0.06
        case .thinking: return 0.08
        case .speaking: return 0.10
        }
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let level = Double(max(0, min(1, voiceLevel)))
            let breathe = 0.5 + 0.5 * sin(t * breatheSpeed)
            let pulse = pulseAmplitude * breathe + 0.06 * level
            // Critical hazard: a subtle ~0.9s opacity pulse so the danger tint
            // visibly throbs without competing with the hazard banner.
            let hazardPulse = hazard == .critical
                ? 0.86 + 0.14 * (0.5 + 0.5 * sin(t * (2 * .pi / 0.9)))
                : 1.0

            Canvas { context, size in
                drawHelmet(
                    in: &context, size: size, color: color, level: level,
                    breathe: breathe, pulse: pulse,
                    listening: turnState == .listening || turnState == .hearing,
                    speaking: turnState == .speaking
                )
            }
            .opacity(hazardPulse)
        }
        .frame(width: 300, height: 300)
        .opacity(dimmed ? 0.55 : 1)
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(turnState == .idle ? "开启免提" : "结束免提")
    }
}

// Helmet SVG paths (viewBox 0 0 420 270), copied from src/components/HelmetVisual.tsx.
private let helmetShellPath = "M54 161c4-81 68-132 151-132 93 0 159 61 166 149 2 24-11 45-34 54-45 17-126 26-204 8-50-12-81-39-79-79Z"
private let helmetChinPath = "M220 167c40 4 82 0 126-12-5 28-18 46-40 54-31 11-66 17-103 17 17-17 22-36 17-59Z"
private let helmetVisorPath = "M155 88h155c22 0 40 18 40 40v13c-48 18-106 25-178 21-27-1-49-24-49-51 0-13 11-23 32-23Z"

private func drawHelmet(
    in context: inout GraphicsContext, size: CGSize, color: Color, level: Double,
    breathe: Double, pulse: Double, listening: Bool, speaking: Bool
) {
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    // Clamp every glow radius to fit inside the canvas so the radial gradient
    // fades fully to clear before the edge — otherwise the bounded canvas clips
    // the growing glow into hard rectangular cuts at the top and bottom.
    let maxR = min(size.width, size.height) / 2

    // Halo — soft state-tinted bloom behind the helmet.
    let haloR = min(size.width * 0.34 * (1.0 + 0.16 * breathe + 0.45 * level), maxR)
    context.fill(
        Path(ellipseIn: CGRect(x: center.x - haloR, y: center.y - haloR, width: haloR * 2, height: haloR * 2)),
        with: .radialGradient(
            Gradient(colors: [color.opacity(0.42 + 0.12 * level), .clear]),
            center: center, startRadius: 6, endRadius: haloR
        )
    )
    // Voice ripple — expands as the rider speaks.
    let rippleR = min(size.width * 0.30 * (0.92 + 0.5 * level), maxR * 0.95)
    context.stroke(
        Path(ellipseIn: CGRect(x: center.x - rippleR, y: center.y - rippleR, width: rippleR * 2, height: rippleR * 2)),
        with: .color(color.opacity(0.12 + 0.5 * level)), lineWidth: 2
    )

    // Helmet, scaled to fit and breathing about the canvas center.
    let baseScale = size.width / 420 * 0.74
    let s = baseScale * (1.0 + pulse)
    context.translateBy(x: (size.width - 420 * s) / 2, y: (size.height - 270 * s) / 2)
    context.scaleBy(x: s, y: s)

    context.fill(
        svgPath(helmetShellPath),
        with: .linearGradient(
            Gradient(colors: [Color(hex: 0xF6F9F6), Color(hex: 0xCDD6D1), Color(hex: 0x8B9893)]),
            startPoint: CGPoint(x: 120, y: 28), endPoint: CGPoint(x: 150, y: 215)
        )
    )
    // Top rim light — lifts the shell off the background with volume (mirrors the
    // web shellSheen gradient in HelmetVisual.tsx).
    context.fill(
        svgPath(helmetShellPath),
        with: .linearGradient(
            Gradient(colors: [Color.white.opacity(0.5), Color.clear]),
            startPoint: CGPoint(x: 210, y: 28), endPoint: CGPoint(x: 210, y: 120)
        )
    )
    context.fill(
        svgPath(helmetChinPath),
        with: .linearGradient(
            Gradient(colors: [Color(hex: 0x8B9B97), Color(hex: 0x5D6B68)]),
            startPoint: CGPoint(x: 283, y: 160), endPoint: CGPoint(x: 283, y: 240)
        )
    )
    let visor = svgPath(helmetVisorPath)
    context.fill(
        visor,
        with: .linearGradient(
            Gradient(colors: [Color(hex: 0x54787E), Color(hex: 0x22393D), Color(hex: 0x0A1A1F)]),
            startPoint: CGPoint(x: 232, y: 88), endPoint: CGPoint(x: 232, y: 165)
        )
    )
    // Visor state glow — tints the visor while Max listens or speaks.
    let visorGlow = (speaking ? 0.42 : (listening ? 0.30 : 0.10)) * (0.55 + 0.45 * level)
    context.fill(visor, with: .color(color.opacity(visorGlow)))
    // Visor glare highlight.
    context.fill(
        Path(ellipseIn: CGRect(x: 206 - 58, y: 106 - 11, width: 116, height: 22)),
        with: .color(.white.opacity(0.12))
    )
    // Crisp glassy streak across the upper visor (mirrors web visorSpec).
    context.fill(
        Path(ellipseIn: CGRect(x: 190 - 44, y: 99 - 3.4, width: 88, height: 6.8)),
        with: .color(.white.opacity(0.5))
    )
    // Mic + status dots.
    context.fill(
        Path(ellipseIn: CGRect(x: 258 - 9, y: 205 - 9, width: 18, height: 18)),
        with: .color(listening ? HudColors.accentCyan : HudColors.muted)
    )
    context.fill(
        Path(ellipseIn: CGRect(x: 282 - 9, y: 205 - 9, width: 18, height: 18)),
        with: .color(color)
    )
}

// MARK: - minimal SVG path parser (supports M/m L/l H/h V/v C/c Z)

private func svgPath(_ d: String) -> Path {
    var path = Path()
    let tokens = svgTokens(d)
    var i = 0
    var current = CGPoint.zero
    var start = CGPoint.zero
    var cmd: Character = " "

    func num(_ k: Int) -> CGFloat {
        guard k < tokens.count, case let .number(v) = tokens[k] else { return 0 }
        return v
    }

    while i < tokens.count {
        switch tokens[i] {
        case .command(let c):
            cmd = c
            i += 1
            if c == "Z" || c == "z" {
                path.closeSubpath()
                current = start
            }
        case .number:
            switch cmd {
            case "M":
                current = CGPoint(x: num(i), y: num(i + 1)); i += 2
                start = current; path.move(to: current); cmd = "L"
            case "m":
                current = CGPoint(x: current.x + num(i), y: current.y + num(i + 1)); i += 2
                start = current; path.move(to: current); cmd = "l"
            case "L":
                current = CGPoint(x: num(i), y: num(i + 1)); i += 2; path.addLine(to: current)
            case "l":
                current = CGPoint(x: current.x + num(i), y: current.y + num(i + 1)); i += 2; path.addLine(to: current)
            case "H": current = CGPoint(x: num(i), y: current.y); i += 1; path.addLine(to: current)
            case "h": current = CGPoint(x: current.x + num(i), y: current.y); i += 1; path.addLine(to: current)
            case "V": current = CGPoint(x: current.x, y: num(i)); i += 1; path.addLine(to: current)
            case "v": current = CGPoint(x: current.x, y: current.y + num(i)); i += 1; path.addLine(to: current)
            case "C":
                let c1 = CGPoint(x: num(i), y: num(i + 1))
                let c2 = CGPoint(x: num(i + 2), y: num(i + 3))
                let end = CGPoint(x: num(i + 4), y: num(i + 5)); i += 6
                path.addCurve(to: end, control1: c1, control2: c2); current = end
            case "c":
                let c1 = CGPoint(x: current.x + num(i), y: current.y + num(i + 1))
                let c2 = CGPoint(x: current.x + num(i + 2), y: current.y + num(i + 3))
                let end = CGPoint(x: current.x + num(i + 4), y: current.y + num(i + 5)); i += 6
                path.addCurve(to: end, control1: c1, control2: c2); current = end
            default:
                i += 1
            }
        }
    }
    return path
}

private enum SVGToken { case command(Character); case number(CGFloat) }

private func svgTokens(_ s: String) -> [SVGToken] {
    var out: [SVGToken] = []
    let chars = Array(s)
    let n = chars.count
    let commands = Set("MmLlHhVvCcSsQqTtAaZz")
    var i = 0
    while i < n {
        let c = chars[i]
        if c == " " || c == "," || c == "\n" || c == "\t" { i += 1; continue }
        if commands.contains(c) { out.append(.command(c)); i += 1; continue }
        var j = i
        if chars[j] == "+" || chars[j] == "-" { j += 1 }
        while j < n && chars[j].isNumber { j += 1 }
        if j < n && chars[j] == "." { j += 1; while j < n && chars[j].isNumber { j += 1 } }
        if j < n && (chars[j] == "e" || chars[j] == "E") {
            j += 1
            if j < n && (chars[j] == "+" || chars[j] == "-") { j += 1 }
            while j < n && chars[j].isNumber { j += 1 }
        }
        if j > i, let v = Double(String(chars[i..<j])) {
            out.append(.number(CGFloat(v)))
            i = j
        } else {
            i += 1
        }
    }
    return out
}

// MARK: - caption line

private struct CaptionLine: View {
    let text: String

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
    let canFlag: (TranscriptItem) -> Bool
    let onFlag: (TranscriptItem, String) -> Void

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
                                ChatBubble(
                                    item: item,
                                    time: timeFormatter.string(from: item.at),
                                    flaggable: canFlag(item),
                                    onFlag: { reason in onFlag(item, reason) }
                                )
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

// MARK: - secondary controls (字幕 · 设置)

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

            PillToggle(icon: "gearshape.fill", label: "设置", on: false) {
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

// MARK: - settings (account · voice · connection · demo · diagnostics)

private struct SettingsPanel: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

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
                TextField("认证令牌", text: $viewModel.authToken)
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

// MARK: - conversation bubble (used by the captions overlay)

private struct ChatBubble: View {
    let item: TranscriptItem
    let time: String
    var flaggable = false
    var onFlag: (String) -> Void = { _ in }

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
                    if let feedback = item.feedback {
                        Text("⚑ \(feedback)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(HudColors.danger)
                    } else if flaggable {
                        // One tap opens the preset reasons — no typing mid-ride.
                        Menu {
                            ForEach(turnFlagReasons, id: \.self) { reason in
                                Button(reason) { onFlag(reason) }
                            }
                        } label: {
                            Text("有问题?")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(HudColors.danger.opacity(0.85))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .overlay(
                                    Capsule().stroke(HudColors.danger.opacity(0.4), lineWidth: 1)
                                )
                        }
                    }
                }
            }
            if !isRider { Spacer(minLength: 40) }
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
