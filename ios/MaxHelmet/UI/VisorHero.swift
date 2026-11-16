import SwiftUI

// The hero of the agent screen: a device-agnostic live voice visual. A wide
// visor lens (2.4:1 capsule) with a thin rim, carrying one waveform line that
// reads the session state. It replaces the helmet artwork and is the session
// toggle: tap once to start, again to stop. Mute is a separate control.

/// What the waveform is doing.
enum VisorMode: Equatable {
    /// Flat line, slow breathing.
    case idle
    /// A bright segment sweeping along a dim flat line.
    case connecting
    /// Accent line driven by the mic level.
    case listening
    /// A pulsing line.
    case thinking
    /// A fuller, livelier waveform.
    case speaking
    /// Dimmed line with a danger tick.
    case offline
}

func visorMode(_ state: AgentSession.State) -> VisorMode {
    guard state.handsFree else { return .idle }
    switch state.connection {
    case .offline, .degraded: return .offline
    case .connecting, .provider: return .connecting
    case .relay, .ready:
        switch state.turnState {
        case .thinking: return .thinking
        case .speaking: return .speaking
        case .listening, .hearing: return .listening
        case .idle: return .idle
        }
    }
}

/// Semantic hazard colour (also used by settings and the hazard banner).
func hazardColor(_ hazard: HazardLevel) -> Color {
    switch hazard {
    case .normal: return Visor.ok
    case .caution: return Visor.warn
    case .critical: return Visor.danger
    }
}

/// The waveform tint: the fused hazard (ride + weather) always wins over the
/// conversational palette, mirroring the web client; otherwise the accent.
func visorTint(_ state: AgentSession.State) -> Color {
    if isHazardPresentationActive(state) { return hazardColor(state.fusedHazard) }
    return Visor.accent
}

struct VisorView: View {
    let mode: VisorMode
    let tint: Color
    let voiceLevel: Float
    let dimmed: Bool
    /// Fused ride + weather hazard; critical adds a ~0.9s opacity pulse.
    let hazard: HazardLevel
    /// Whether a hands-free session is active, including a connection attempt.
    let handsFree: Bool
    /// The stage this view fills (also its hit target).
    let stage: CGSize
    var onTap: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The stage always has a real size from the layout; never draw into a
    /// degenerate or non-finite coordinate system.
    private var drawable: Bool {
        stage.width.isFinite && stage.height.isFinite && stage.width >= 40 && stage.height >= 40
    }

    var body: some View {
        Button(action: onTap) {
            if drawable {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
                    let t = helmetMotionTime(
                        elapsed: timeline.date.timeIntervalSinceReferenceDate,
                        reduceMotion: reduceMotion
                    )
                    let hazardPulse = hazard == .critical
                        ? 0.86 + 0.14 * (0.5 + 0.5 * sin(t * (2 * .pi / 0.9)))
                        : 1.0
                    Canvas { context, size in
                        drawVisor(
                            in: &context, size: size, mode: mode, tint: tint,
                            level: Double(max(0, min(1, voiceLevel))), t: t,
                            lensAspect: HudMetrics.visorAspect
                        )
                    }
                    .opacity(hazardPulse)
                }
            } else {
                Color.clear
            }
        }
        .buttonStyle(.plain)
        .frame(width: stage.width, height: stage.height)
        .opacity(dimmed ? 0.55 : 1)
        .contentShape(Rectangle())
        .accessibilityLabel(helmetToggleAccessibilityLabel(handsFree: handsFree))
        .accessibilityHint(helmetToggleAccessibilityHint(handsFree: handsFree))
        .accessibilityValue(helmetToggleAccessibilityValue(handsFree: handsFree))
    }
}

// MARK: - drawing

/// The lens rectangle inside a stage: widest 2.4:1 box that fits, centred.
func visorLensRect(in size: CGSize, aspect: CGFloat = HudMetrics.visorAspect) -> CGRect {
    let maxW = max(0, size.width - 8)
    let maxH = max(0, size.height - 8)
    let w = min(maxW, maxH * aspect)
    let h = w / aspect
    return CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
}

private func drawVisor(
    in context: inout GraphicsContext, size: CGSize, mode: VisorMode, tint: Color,
    level: Double, t: Double, lensAspect: CGFloat
) {
    let lens = visorLensRect(in: size, aspect: lensAspect)
    guard lens.width > 0, lens.height > 0 else { return }
    let live = mode == .listening || mode == .speaking || mode == .thinking

    // The one allowed effect: a faint accent-tinted radial vignette.
    do {
        var c = context
        let vignetteA = 0.07 + (live ? 0.05 : 0) + 0.06 * level
        c.translateBy(x: size.width / 2, y: size.height / 2)
        c.scaleBy(x: size.width / max(size.height, 1), y: 1)
        let r = size.height / 2
        c.fill(
            Path(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2)),
            with: .radialGradient(
                Gradient(colors: [tint.opacity(vignetteA), tint.opacity(0)]),
                center: .zero, startRadius: 0, endRadius: r
            )
        )
    }

    // Rim + lens: flat fills, hairline strokes.
    let rim = Path(roundedRect: lens, cornerRadius: lens.height / 2, style: .continuous)
    context.fill(rim, with: .color(Visor.surface2))
    context.stroke(rim, with: .color(live ? tint.opacity(0.55) : Visor.lineStrong), lineWidth: 1)

    let rimWidth = max(4, lens.height * 0.055)
    let glass = lens.insetBy(dx: rimWidth, dy: rimWidth)
    let glassPath = Path(roundedRect: glass, cornerRadius: glass.height / 2, style: .continuous)
    context.fill(glassPath, with: .color(Visor.bg))
    context.stroke(glassPath, with: .color(Visor.line), lineWidth: 1)

    // Waveform.
    let inset = glass.height * 0.55
    let x0 = glass.minX + inset
    let x1 = glass.maxX - inset
    guard x1 > x0 else { return }
    let midY = glass.midY
    let halfH = glass.height / 2 * 0.82
    let steps = 120
    let lineW = max(2, lens.height * 0.02)

    func envelope(_ u: Double) -> Double { pow(sin(.pi * u), 1.3) }

    func wave(_ amp: (Double) -> Double) -> [CGPoint] {
        (0...steps).map { i in
            let u = Double(i) / Double(steps)
            return CGPoint(x: x0 + (x1 - x0) * u, y: midY - halfH * amp(u))
        }
    }

    func polyline(_ pts: [CGPoint]) -> Path {
        var p = Path()
        for (i, pt) in pts.enumerated() { i == 0 ? p.move(to: pt) : p.addLine(to: pt) }
        return p
    }

    let style = StrokeStyle(lineWidth: lineW, lineCap: .round, lineJoin: .round)
    let breathe = 0.5 + 0.5 * sin(t * 0.9)

    switch mode {
    case .idle:
        let pts = wave { u in 0.035 * envelope(u) * sin(u * 7 + t * 0.6) * (0.4 + 0.6 * breathe) }
        context.stroke(polyline(pts), with: .color(Visor.textSecondary.opacity(0.45 + 0.30 * breathe)), style: style)

    case .connecting:
        let flat = wave { _ in 0 }
        context.stroke(polyline(flat), with: .color(Visor.textTertiary.opacity(0.7)), style: style)
        let span = 0.24
        let head = (t * 0.7).truncatingRemainder(dividingBy: 1 + span)
        let seg = (0...steps).compactMap { i -> CGPoint? in
            let u = Double(i) / Double(steps)
            guard u >= head - span, u <= head else { return nil }
            return flat[i]
        }
        if seg.count > 1 {
            context.stroke(polyline(seg), with: .color(Visor.text), style: style)
        }

    case .listening:
        let drive = 0.07 + 0.88 * min(1, level * 1.6)
        let main = wave { u in
            envelope(u) * drive * (0.55 * sin(u * 15 + t * 7.5) + 0.45 * sin(u * 24 - t * 5.2))
        }
        let ghost = wave { u in
            envelope(u) * drive * 0.7 * (0.6 * sin(u * 11 - t * 4.1) + 0.4 * sin(u * 19 + t * 6.3))
        }
        context.stroke(polyline(ghost), with: .color(tint.opacity(0.28)), style: style)
        context.stroke(polyline(main), with: .color(tint), style: style)

    case .thinking:
        let pulse = 0.5 + 0.5 * sin(t * 3.4)
        let pts = wave { u in envelope(u) * (0.07 + 0.10 * pulse) * sin(u * 9 - t * 4.0) }
        var s = style
        s.lineWidth = lineW * (1.0 + 0.5 * pulse)
        context.stroke(polyline(pts), with: .color(tint.opacity(0.55 + 0.45 * pulse)), style: s)

    case .speaking:
        let swell = 0.78 + 0.22 * sin(t * 2.3)
        let main = wave { u in
            envelope(u) * 0.62 * swell
                * (0.5 * sin(u * 11 + t * 6.5) + 0.3 * sin(u * 19 - t * 4.3) + 0.2 * sin(u * 5 + t * 3.1))
        }
        let ghost = wave { u in
            envelope(u) * 0.46 * swell
                * (0.55 * sin(u * 13 - t * 5.1) + 0.45 * sin(u * 7 + t * 2.7))
        }
        context.stroke(polyline(ghost), with: .color(tint.opacity(0.30)), style: style)
        context.stroke(polyline(main), with: .color(tint), style: style)

    case .offline:
        let flat = wave { _ in 0 }
        context.stroke(polyline(flat), with: .color(Visor.textTertiary.opacity(0.4)), style: style)
        var tick = Path()
        tick.move(to: CGPoint(x: x0 - inset * 0.05, y: midY - halfH * 0.55))
        tick.addLine(to: CGPoint(x: x0 - inset * 0.05, y: midY + halfH * 0.55))
        context.stroke(tick, with: .color(Visor.danger), style: StrokeStyle(lineWidth: lineW * 1.4, lineCap: .round))
    }
}
