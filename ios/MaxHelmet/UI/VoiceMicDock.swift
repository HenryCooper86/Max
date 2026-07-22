import SwiftUI

struct VoiceMicDock: View {
    let state: AgentSession.State
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var displayedLevel: Float = 0

    private var presentation: MicDockPresentation { micDockPresentation(state) }

    private var accent: Color {
        switch presentation.mode {
        case .idle: return HudColors.ember
        case .connecting: return HudColors.amber
        case .live, .muted: return HudColors.lume
        }
    }

    var body: some View {
        TimelineView(
            .animation(
                minimumInterval: 1.0 / 30.0,
                paused: reduceMotion || presentation.mode != .connecting
            )
        ) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 0.9) / 0.9
            let motionLevel: Float = reduceMotion ? 0 : displayedLevel

            Button(action: action) {
                HStack(spacing: 13) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 13)
                            .fill(accent.opacity(0.13))
                            .overlay(RoundedRectangle(cornerRadius: 13).stroke(accent.opacity(0.30 + 0.25 * Double(motionLevel))))
                        Image(systemName: presentation.mode == .idle ? "mic.fill" : "xmark")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundColor(accent)
                    }
                    .frame(width: 46, height: 46)
                    .scaleEffect(1 + CGFloat(motionLevel) * 0.04)

                    Rectangle().fill(Color(hex: 0xC4DAD8, alpha: 0.14)).frame(width: 1, height: 28)

                    Text(presentation.label)
                        .font(.system(size: 16, weight: .semibold))
                        .tracking(0.64)
                        .foregroundColor(HudColors.hudInk)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    trailing(phase: phase)
                }
                .padding(.leading, 8)
                .padding(.trailing, 15)
                .padding(.vertical, 8)
                .frame(maxWidth: 300, minHeight: 64)
                .background(
                    LinearGradient(
                        colors: [Color.white.opacity(0.05), Color.clear, Color(hex: 0x11100E)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 19)
                        .stroke(accent.opacity(0.34 + 0.28 * Double(motionLevel)), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 19))
                .shadow(
                    color: accent.opacity(0.12 + 0.22 * Double(motionLevel)),
                    radius: 12 + 8 * CGFloat(motionLevel),
                    y: 8
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(presentation.accessibilityLabel)
        }
        .onAppear { displayedLevel = presentation.displayLevel }
        .onChange(of: presentation) { previous, next in
            switch micDockLevelTransition(
                from: previous,
                to: next,
                displayedLevel: displayedLevel,
                reduceMotion: reduceMotion
            ) {
            case .snap(let target):
                withAnimation(nil) { displayedLevel = target }
            case .animate(let target, let duration):
                withAnimation(.linear(duration: duration)) { displayedLevel = target }
            }
        }
        .onChange(of: reduceMotion) { _, enabled in
            if enabled { withAnimation(nil) { displayedLevel = presentation.displayLevel } }
        }
    }

    @ViewBuilder
    private func trailing(phase: Double) -> some View {
        switch presentation.mode {
        case .muted:
            Image(systemName: "mic.slash.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(HudColors.amber)
                .frame(width: 24)
                .accessibilityHidden(true)
        case .connecting:
            VoiceInputMeter(
                heights: [6, 12, 6],
                color: HudColors.amber,
                level: 0,
                phase: reduceMotion ? nil : phase
            )
        case .idle, .live:
            VoiceInputMeter(
                heights: micMeterHeights(displayedLevel),
                color: accent,
                level: displayedLevel,
                phase: nil
            )
        }
    }
}

private struct VoiceInputMeter: View {
    let heights: [CGFloat]
    let color: Color
    let level: Float
    let phase: Double?

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(heights.enumerated()), id: \.offset) { index, height in
                let shimmer = phase.map { 0.5 + 0.5 * sin($0 * 2 * .pi - Double(index) * 1.7) }
                Capsule()
                    .fill(color.opacity(shimmer.map { 0.25 + 0.65 * $0 } ?? 0.28 + 0.72 * Double(level)))
                    .frame(width: 4, height: height)
            }
        }
        .frame(width: 24, height: 20)
        .accessibilityHidden(true)
    }
}

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        let tint = muted ? HudColors.amber : HudColors.hudDim
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(muted ? "取消静音" : "静音")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(tint)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(muted ? HudColors.amber.opacity(0.16) : HudColors.panelElevated))
        }
        .buttonStyle(.plain)
        .frame(minHeight: muteUtilityMinimumHitHeight)
        .contentShape(Rectangle())
        .accessibilityLabel(muted ? "取消静音" : "静音")
    }
}
