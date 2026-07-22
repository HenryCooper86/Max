import Foundation

func isHazardPresentationActive(_ state: AgentSession.State) -> Bool {
    guard state.handsFree, state.fusedHazard != .normal else { return false }
    return state.connection == .relay || state.connection == .ready
}

func helmetMotionTime(elapsed: TimeInterval, reduceMotion: Bool) -> TimeInterval {
    reduceMotion ? 0 : elapsed
}
