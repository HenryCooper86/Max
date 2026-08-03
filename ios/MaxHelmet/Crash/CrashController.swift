import CoreLocation
import Foundation

struct CrashSettings {
    var contactNumber: String?
    var relayOptIn: Bool
    var callTarget: String   // "contact" or "120"
    var logOnly: Bool
}

enum CrashUIPhase: Equatable {
    case hidden
    case checkIn(sinceT: TimeInterval)
    case alarm(sinceT: TimeInterval)
    case escalated(ackText: String?)
}

/// The glue between the pure CrashEngine and the world: motion samples in,
/// speech/siren/UI/relay events out. Owns nothing safety-critical itself —
/// every decision comes back from CrashEngine as an effect.
@MainActor
final class CrashController {
    struct Lines {
        var checkIn = "检测到疑似摔车。你还好吗？没事请回答“我没事”，或点一下屏幕。"
        var ackNotified = "已通知紧急联系人。"
        var ackFailed = "紧急联系人通知失败，请手动拨打求助电话。"
        var ackUnconfigured = "服务器没有配置通知通道，请手动拨打求助电话。"
        var noAck = "服务器未确认 — 请手动拨打"
    }

    private let motion: MotionStreaming
    private let locate: (@escaping (CLLocationCoordinate2D?) -> Void) -> Void
    private let speak: (String) -> Void
    private let interruptPlayback: () -> Void
    private let siren: SirenPlayer
    private let send: (String) -> Void
    private let settings: () -> CrashSettings
    private let now: () -> TimeInterval
    private let tuning: CrashTuning
    private let lines = Lines()

    private var state = CrashState.armed
    private var armed = false
    private var tickTimer: Timer?
    private var pendingAlertJson: String?
    private var activeIncidentId: String?
    private var acked = false
    private var alertSentAt: TimeInterval?
    private var noAckNoticeShown = false
    private let ackTimeoutS: TimeInterval = 10

    var onUIChange: ((CrashUIPhase) -> Void)?
    var onLocationText: ((String?) -> Void)?
    var activeIncidentIdForTesting: String? { activeIncidentId }

    /// True once an incident has passed check-in and is still running
    /// (check-in, alarm, or escalated) — the point past which the incident
    /// outlives the session (see `sessionEnded()`) and the caller must keep
    /// the audio path (siren) alive even while tearing everything else down.
    var hasActiveIncident: Bool {
        switch state.phase {
        case .checkIn, .alarm, .escalated: return true
        case .armed, .impactCandidate: return false
        }
    }

    init(motion: MotionStreaming,
         locate: @escaping (@escaping (CLLocationCoordinate2D?) -> Void) -> Void,
         speak: @escaping (String) -> Void,
         interruptPlayback: @escaping () -> Void,
         siren: SirenPlayer,
         send: @escaping (String) -> Void,
         settings: @escaping () -> CrashSettings,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         tuning: CrashTuning = .standard) {
        self.motion = motion
        self.locate = locate
        self.speak = speak
        self.interruptPlayback = interruptPlayback
        self.siren = siren
        self.send = send
        self.settings = settings
        self.now = now
        self.tuning = tuning
        motion.onSample = { [weak self] sample in self?.handleSample(sample) }
    }

    /// Idempotent: a new session while an old incident is still alarming
    /// restarts detection without touching the incident.
    func arm() {
        armed = true
        motion.start()
        if tickTimer == nil {
            tickTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.handleTick() }
            }
        }
    }

    func disarm() {
        armed = false
        motion.stop()
        tickTimer?.invalidate()
        tickTimer = nil
        siren.stop()
        state = .armed
        pendingAlertJson = nil
        activeIncidentId = nil
        acked = false
        alertSentAt = nil
        noAckNoticeShown = false
        onUIChange?(.hidden)
        onLocationText?(nil)
    }

    /// The alarm outlives the session: detection stops (no more samples), but
    /// an incident past check-in keeps its countdowns, siren, and UI.
    func sessionEnded() {
        switch state.phase {
        case .armed, .impactCandidate:
            disarm()
        case .checkIn, .alarm, .escalated:
            motion.stop()
        }
    }

    func handleSample(_ sample: CrashSample) {
        guard armed else { return }
        apply(CrashEngine.step(sample: sample, state: state, tuning: tuning))
    }

    func handleTick() {
        guard armed else { return }
        apply(CrashEngine.tick(now: now(), state: state, tuning: tuning))
        if case .escalated = state.phase, let sentAt = alertSentAt, !acked, !noAckNoticeShown,
           now() - sentAt >= ackTimeoutS {
            noAckNoticeShown = true
            onUIChange?(.escalated(ackText: lines.noAck))
        }
    }

    func handleSimulate() {
        guard armed else { return }
        apply(CrashEngine.simulate(now: now(), state: state))
    }

    func riderTapCancelled() {
        apply(CrashEngine.riderCancelled(state: state))
    }

    func riderTranscript(_ text: String) {
        guard case .armed = state.phase else {
            if text.contains("没事") || text.contains("取消") {
                apply(CrashEngine.riderCancelled(state: state))
            }
            return
        }
    }

    func handleAck(incidentId: String, status: CrashAckStatus, detail: String?) {
        guard incidentId == activeIncidentId else { return }
        acked = true
        pendingAlertJson = nil
        alertSentAt = nil
        let line: String
        switch status {
        case .notified: line = lines.ackNotified
        case .failed: line = detail.map { "\(lines.ackFailed)（\($0)）" } ?? lines.ackFailed
        case .unconfigured: line = lines.ackUnconfigured
        }
        speak(line)
        if case .escalated = state.phase { onUIChange?(.escalated(ackText: line)) }
    }

    func socketBecameReady() {
        if let pendingAlertJson, !acked { send(pendingAlertJson) }
    }

    private func apply(_ update: CrashUpdate) {
        state = update.state
        for effect in update.effects { perform(effect) }
    }

    private func perform(_ effect: CrashEffect) {
        if settings().logOnly {
            // Harvest mode: record what would have happened, do nothing.
            print("[crash] log-only: \(effect) at \(now())")
            if effect == .speakCheckIn { state = .armed }
            return
        }
        switch effect {
        case .speakCheckIn:
            interruptPlayback()
            speak(lines.checkIn)
            onUIChange?(.checkIn(sinceT: now()))
        case .showAlarm:
            siren.start()
            onUIChange?(.alarm(sinceT: now()))
        case .escalate:
            escalate()
        case .dismiss:
            siren.stop()
            // A cancelled incident (checkIn/alarm path) never escalated, so
            // these are normally already nil — cleared here too for symmetry
            // with the escalated-cancel path below, and so nothing resends on
            // a later socketBecameReady() no matter which path cleared it.
            pendingAlertJson = nil
            alertSentAt = nil
            onUIChange?(.hidden)
            onLocationText?(nil)
        case .logNearMiss:
            print("[crash] near-miss cancelled at \(now())")
        case .sendCancel:
            // Send the follow-up before clearing anything — it needs
            // activeIncidentId. Once sent, this incident is fully closed:
            // nothing must resend the original crash.alert on a later
            // socketBecameReady() (the rider already told the relay it was a
            // false alarm).
            if let activeIncidentId { send(buildCrashCancel(incidentId: activeIncidentId)) }
            pendingAlertJson = nil
            alertSentAt = nil
            acked = false
        }
    }

    private func escalate() {
        let incidentId = UUID().uuidString
        activeIncidentId = incidentId
        acked = false
        noAckNoticeShown = false
        let current = settings()
        // The impact-window speed, captured by the engine at the moment of
        // promotion — by escalation time the rolling buffer holds only
        // stationary post-crash samples, so recomputing from `state.recent`
        // here would report ~0 km/h regardless of how fast the rider was going.
        let speedRecent = state.peakSpeedKmh
        onUIChange?(.escalated(ackText: nil))
        locate { [weak self] coordinate in
            guard let self else { return }
            if let coordinate {
                self.onLocationText?(String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude))
            }
            let json = buildCrashAlert(
                incidentId: incidentId,
                lat: coordinate?.latitude,
                lon: coordinate?.longitude,
                speedKmhRecent: speedRecent,
                contactNumber: current.relayOptIn ? current.contactNumber : nil,
                contactOptIn: current.relayOptIn,
                detectedAt: Date().timeIntervalSince1970 * 1000
            )
            self.pendingAlertJson = json
            self.alertSentAt = self.now()
            self.send(json)
        }
    }
}
