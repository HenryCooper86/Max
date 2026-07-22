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
    guard connected else { return HudColors.danger2 }
    switch turnState {
    // Green = live/ready for every conversational state; amber = thinking. The
    // cyan "listening" hue is retired (mirrors the web Night Instrument palette).
    case .idle: return HudColors.lume
    case .listening, .hearing: return HudColors.lume
    case .thinking: return HudColors.amber
    case .speaking: return HudColors.lume
    }
}

func hazardColor(_ hazard: HazardLevel) -> Color {
    switch hazard {
    case .normal: return HudColors.lume
    case .caution: return HudColors.amber
    case .critical: return HudColors.danger2
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
    guard state.handsFree else { return HudColors.lume }
    switch state.connection {
    case .offline, .degraded: return HudColors.danger2
    case .connecting, .provider: return HudColors.amber
    case .relay, .ready: return ringColor(connected: true, turnState: state.turnState)
    }
}

/// Latin instrument telltale shown under the Chinese state word — the system
/// monospaced face here (Space Mono on web). Deliberately English: it reads as a
/// gauge label, not primary copy. Mirrors the web HelmetVisual TELLTALE map.
private func stateTelltale(_ state: AgentSession.State) -> String {
    if state.fusedHazard == .critical { return "HAZARD" }
    if state.fusedHazard == .caution { return "CAUTION" }
    if !state.handsFree { return "STANDBY" }
    if state.micMuted { return "MUTED" }
    switch state.connection {
    case .offline, .degraded: return "OFFLINE"
    case .connecting, .provider: return "CONNECTING"
    case .relay, .ready:
        switch state.turnState {
        case .idle: return "STANDBY"
        case .listening: return "LISTENING"
        case .hearing: return "HEARING"
        case .thinking: return "THINKING"
        case .speaking: return "SPEAKING"
        }
    }
}

/// Drive mode for the instrument bezel — mirrors the web HelmetVisual gauge, so
/// the tick ring and the caption always agree on what Max is doing.
enum GaugeMode { case offline, idle, connecting, mic, thinking, speaking, hazard }

private func gaugeMode(_ state: AgentSession.State) -> GaugeMode {
    if state.handsFree && state.fusedHazard != .normal { return .hazard }
    guard state.handsFree else { return .idle }
    switch state.connection {
    case .offline, .degraded: return .offline
    case .connecting, .provider: return .connecting
    case .relay, .ready:
        switch state.turnState {
        case .thinking: return .thinking
        case .speaking: return .speaking
        case .listening, .hearing: return .mic
        case .idle: return .idle
        }
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
                TopBar(state: state)

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
                    gauge: gaugeMode(state),
                    onTap: viewModel.toggleHandsFree
                )

                StateReadout(caption: orbCaption(state), telltale: stateTelltale(state), color: color)

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
        .background(HudColors.void.ignoresSafeArea())
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

private struct TopBar: View {
    let state: AgentSession.State

    var body: some View {
        let online = state.connection == .relay || state.connection == .ready
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Circle()
                    .fill(online ? HudColors.lume : HudColors.hudDim)
                    .frame(width: 7, height: 7)
                Text("MAX")
                    .font(.system(size: 15, weight: .bold))
                    .tracking(4)
                    .foregroundColor(HudColors.hudInk)
            }
            Spacer(minLength: 0)
            HStack(spacing: 7) {
                if state.bluetoothRouted {
                    Image(systemName: "headphones")
                        .font(.system(size: 11))
                        .foregroundColor(HudColors.hudDim)
                }
                Circle()
                    .fill(online ? HudColors.lume : HudColors.danger2)
                    .frame(width: 5, height: 5)
                Text(online ? "RELAY ONLINE" : "RELAY OFFLINE")
                    .font(.system(size: 10, weight: .regular, design: .monospaced))
                    .tracking(2)
                    .foregroundColor(online ? HudColors.hudDim : Color(hex: 0xB9776C))
            }
        }
        .frame(maxWidth: .infinity)
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
    /// Which arc the instrument bezel lights (mirrors the web gauge).
    let gauge: GaugeMode
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
                drawGauge(in: &context, size: size, color: color, mode: gauge, level: level, t: t)
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
        with: .color(listening ? HudColors.lume : HudColors.hudDim)
    )
    context.fill(
        Path(ellipseIn: CGRect(x: 282 - 9, y: 205 - 9, width: 18, height: 18)),
        with: .color(color)
    )
}

// MARK: - instrument bezel (the signature)

/// A 270° tick ring (gap at the bottom, tachometer-style) wrapped around the
/// helmet. Its luminous arc reads the session state — a small "ready" nub at
/// standby, an arc tracking the mic level while listening, a travelling shimmer
/// while thinking/connecting, a near-full arc while speaking, and a wide arc on
/// hazard. Mirrors the web .gaugeBezel signature.
private let gaugeTickCount = 56

private func gaugeLit(mode: GaugeMode, index i: Int, level: Double, t: Double) -> Bool {
    let n = gaugeTickCount
    switch mode {
    case .offline: return false
    case .idle: return i < 3 // a small "ready" nub at the start of the sweep
    case .mic:
        let lit = Int((0.08 + min(1.0, level * 1.7) * 0.82) * Double(n))
        return i < lit
    case .speaking: return i < Int(0.9 * Double(n))
    case .hazard: return i < Int(0.82 * Double(n))
    case .thinking, .connecting:
        // A travelling window of lit ticks reads as "working".
        let head = (t * 22).truncatingRemainder(dividingBy: Double(n))
        let rel = (Double(i) - head + Double(n)).truncatingRemainder(dividingBy: Double(n))
        return rel < 9
    }
}

private func drawGauge(
    in context: inout GraphicsContext, size: CGSize, color: Color, mode: GaugeMode, level: Double, t: Double
) {
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    let unit = size.width / 400
    let rOut = size.width * 0.46
    for i in 0..<gaugeTickCount {
        let frac = Double(i) / Double(gaugeTickCount - 1)
        let ang = (-135.0 + frac * 270.0) * .pi / 180
        let major = i % 6 == 0
        let len = (major ? 15.0 : 9.0) * unit
        // sin/cos return Double; CGFloat math below needs an explicit conversion.
        let s = CGFloat(sin(ang)), c = CGFloat(cos(ang))
        let p1 = CGPoint(x: center.x + rOut * s, y: center.y - rOut * c)
        let p2 = CGPoint(x: center.x + (rOut - len) * s, y: center.y - (rOut - len) * c)
        var line = Path()
        line.move(to: p1)
        line.addLine(to: p2)
        if gaugeLit(mode: mode, index: i, level: level, t: t) {
            context.stroke(
                line, with: .color(color.opacity(0.32)),
                style: StrokeStyle(lineWidth: (major ? 6.0 : 5.0) * unit, lineCap: .round)
            )
            context.stroke(
                line, with: .color(color),
                style: StrokeStyle(lineWidth: (major ? 3.0 : 2.4) * unit, lineCap: .round)
            )
        } else {
            context.stroke(
                line, with: .color(HudColors.tick),
                style: StrokeStyle(lineWidth: (major ? 2.2 : 1.6) * unit, lineCap: .round)
            )
        }
    }
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

/// The state readout below the helmet: the large Chinese state word with a
/// monospaced Latin telltale beneath it, coloured by state. Mirrors the web
/// .voiceReadout.
private struct StateReadout: View {
    let caption: String
    let telltale: String
    let color: Color

    var body: some View {
        VStack(spacing: 6) {
            Text(caption)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(HudColors.hudInk)
                .multilineTextAlignment(.center)
            Text(telltale)
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .tracking(4)
                .foregroundColor(color)
        }
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.2), value: caption)
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
            .foregroundColor(on ? HudColors.lume : HudColors.hudDim)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                Capsule().fill(on ? HudColors.lume.opacity(0.16) : HudColors.panelElevated)
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
                        tint: state.micMuted ? HudColors.amber : HudColors.hudInk,
                        background: HudColors.panelElevated,
                        label: state.micMuted ? "取消静音" : "静音",
                        action: viewModel.toggleMute
                    )
                    CircleControl(
                        icon: "xmark",
                        tint: .white,
                        background: HudColors.danger2,
                        label: "结束",
                        action: viewModel.toggleHandsFree
                    )
                }
            } else {
                CircleControl(
                    icon: "mic.fill",
                    tint: HudColors.onEmber,
                    background: HudColors.ember,
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

struct HudCard<Content: View>: View {
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
