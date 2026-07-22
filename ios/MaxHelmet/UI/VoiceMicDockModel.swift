import Foundation

let micDockNoiseFloor: Float = 0.035
let micDockSensitivity: Float = 1.7
let muteUtilityMinimumHitHeight: CGFloat = 44

enum MicDockMode: Equatable {
    case idle, connecting, live, muted
}

struct MicDockPresentation: Equatable {
    let mode: MicDockMode
    let label: String
    let accessibilityLabel: String
    let displayLevel: Float
}

enum MicDockLevelTransition: Equatable {
    case snap(to: Float)
    case animate(to: Float, duration: TimeInterval)
}

func micDockLevelTransition(
    from _: MicDockPresentation,
    to next: MicDockPresentation,
    displayedLevel: Float,
    reduceMotion: Bool
) -> MicDockLevelTransition {
    if reduceMotion || next.mode != .live {
        return .snap(to: next.displayLevel)
    }
    let duration = next.displayLevel > displayedLevel ? 0.08 : 0.18
    return .animate(to: next.displayLevel, duration: duration)
}

func isVoiceInputActive(_ state: AgentSession.State) -> Bool {
    state.handsFree &&
        state.connection == .ready &&
        !state.micMuted &&
        (state.turnState == .listening || state.turnState == .hearing)
}

func micDisplayLevel(_ state: AgentSession.State) -> Float {
    guard isVoiceInputActive(state) else { return 0 }
    return min(max((state.voiceLevel - micDockNoiseFloor) * micDockSensitivity, 0), 1)
}

func micDockPresentation(_ state: AgentSession.State) -> MicDockPresentation {
    let mode: MicDockMode
    if !state.handsFree {
        mode = .idle
    } else if state.connection != .ready {
        mode = .connecting
    } else if state.micMuted {
        mode = .muted
    } else {
        mode = .live
    }

    switch mode {
    case .idle:
        return MicDockPresentation(mode: mode, label: "开始免提", accessibilityLabel: "开始免提", displayLevel: 0)
    case .connecting:
        return MicDockPresentation(mode: mode, label: "连接中", accessibilityLabel: "正在连接免提，点按取消", displayLevel: 0)
    case .live:
        return MicDockPresentation(mode: mode, label: "结束免提", accessibilityLabel: "结束免提", displayLevel: micDisplayLevel(state))
    case .muted:
        return MicDockPresentation(mode: mode, label: "结束免提", accessibilityLabel: "结束免提", displayLevel: 0)
    }
}

func micMeterHeights(_ level: Float) -> [CGFloat] {
    let value = CGFloat(min(max(level, 0), 1))
    return [6 + 8 * value, 6 + 12 * value, 6 + 9 * value]
}
