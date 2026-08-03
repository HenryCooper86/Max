import Foundation

/// Every detection threshold in one place, mirroring the ADAS tuning
/// dataclass. v1 numbers come from the spec; tune from recorded traces.
struct CrashTuning: Equatable {
    var impactThresholdG = 4.5
    var impactSustainS = 0.02
    var tumbleThresholdRadS = 6.0
    var tumbleSustainS = 0.10
    var speedGateKmh = 10.0
    var confirmWindowS = 5.0
    var confirmMinDelayS = 0.5
    var stillSpeedKmh = 2.0
    var stillVarianceG2 = 0.05
    var stillWindowS = 1.0
    var checkInWindowS = 15.0
    var alarmWindowS = 30.0
    var preContextS = 5.0
    static let standard = CrashTuning()
}

struct CrashSample: Equatable {
    var t: TimeInterval        // monotonic seconds
    var accelG: Double         // |userAcceleration| in g
    var rotationRadS: Double   // |rotationRate| in rad/s
    var speedKmh: Double?      // ride-context speed; nil = unknown
}

enum CrashPhase: Equatable {
    case armed
    case impactCandidate(since: TimeInterval)
    case checkIn(since: TimeInterval)
    case alarm(since: TimeInterval)
    case escalated(at: TimeInterval)
}

struct CrashState: Equatable {
    var phase: CrashPhase = .armed
    var recent: [CrashSample] = []
    var impactStart: TimeInterval?
    var tumbleStart: TimeInterval?
    static let armed = CrashState()
}

enum CrashEffect: Equatable {
    case speakCheckIn   // interrupt playback and ask 你还好吗
    case showAlarm      // full-screen alarm + siren
    case escalate       // send crash.alert
    case dismiss        // clear banner/alarm UI
    case logNearMiss    // cancelled incident — keep the trace for tuning
    case sendCancel     // post-escalation cancel — relay sends the 误报 follow-up
}

struct CrashUpdate: Equatable {
    var state: CrashState
    var effects: [CrashEffect] = []
}

/// Pure crash detection and escalation timing — no CoreMotion, no timers,
/// no I/O. Every decision the rider's safety depends on lives here, so it
/// can be table-tested from literal IMU traces.
enum CrashEngine {

    static func step(sample: CrashSample, state: CrashState, tuning: CrashTuning = .standard) -> CrashUpdate {
        var s = state
        s.recent.append(sample)
        let cutoff = sample.t - tuning.preContextS
        s.recent.removeAll { $0.t < cutoff }

        switch s.phase {
        case .armed:
            s.impactStart = sample.accelG >= tuning.impactThresholdG ? (s.impactStart ?? sample.t) : nil
            s.tumbleStart = sample.rotationRadS >= tuning.tumbleThresholdRadS ? (s.tumbleStart ?? sample.t) : nil
            let impact = s.impactStart.map { sample.t - $0 >= tuning.impactSustainS } ?? false
            let tumble = s.tumbleStart.map { sample.t - $0 >= tuning.tumbleSustainS } ?? false
            let recentSpeed = s.recent.compactMap(\.speedKmh).max()
            let fast = (recentSpeed ?? 0) >= tuning.speedGateKmh
            if (fast && (impact || tumble)) || (impact && tumble) {
                s.phase = .impactCandidate(since: sample.t)
                s.impactStart = nil
                s.tumbleStart = nil
            }
            return CrashUpdate(state: s)

        case .impactCandidate(let since):
            // Speed gate applies to PROMOTION from armed only. During confirm window, a qualifying
            // event has already passed the gate, so renewed signals corroborate regardless of speed.
            // A check-in is cheap to cancel; a missed low-speed crash is not.
            let renewed = sample.t - since >= tuning.confirmMinDelayS &&
                (sample.accelG >= tuning.impactThresholdG || sample.rotationRadS >= tuning.tumbleThresholdRadS)
            let still = sample.t - since >= tuning.confirmMinDelayS && stillness(s.recent, at: sample.t, tuning: tuning)
            if renewed || still {
                s.phase = .checkIn(since: sample.t)
                return CrashUpdate(state: s, effects: [.speakCheckIn])
            }
            if sample.t - since >= tuning.confirmWindowS {
                s.phase = .armed
            }
            return CrashUpdate(state: s)

        case .checkIn, .alarm, .escalated:
            // One incident at a time: sensor input never spawns or resets an
            // incident past check-in. Timing advances via tick().
            return CrashUpdate(state: s)
        }
    }

    /// What a real crash leaves behind: the rider and phone stop moving.
    private static func stillness(_ recent: [CrashSample], at t: TimeInterval, tuning: CrashTuning) -> Bool {
        let window = recent.filter { $0.t >= t - tuning.stillWindowS }
        guard window.count >= 10 else { return false }
        if window.contains(where: { ($0.speedKmh ?? 0) >= tuning.stillSpeedKmh }) { return false }
        let values = window.map(\.accelG)
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(values.count)
        return variance < tuning.stillVarianceG2
    }
}
