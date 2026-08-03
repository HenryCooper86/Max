import XCTest
@testable import MaxHelmet

private final class FakeMotion: MotionStreaming, @unchecked Sendable {
    var onSample: ((CrashSample) -> Void)?
    var started = false
    func start() { started = true }
    func stop() { started = false }
}

@MainActor
final class CrashControllerTests: XCTestCase {

    private var sent: [String] = []
    private var spoken: [String] = []
    private var sirenOn = 0
    private var sirenOff = 0
    private var interrupted = 0
    private var phases: [CrashUIPhase] = []
    private var now: TimeInterval = 100
    private var settings = CrashSettings(contactNumber: "+8613800000000", relayOptIn: true, callTarget: "120", logOnly: false)
    private var motion = FakeMotion()

    private func makeController() -> CrashController {
        let controller = CrashController(
            motion: motion,
            locate: { completion in completion(.init(latitude: 31.23, longitude: 121.47)) },
            speak: { [weak self] line in self?.spoken.append(line) },
            interruptPlayback: { [weak self] in self?.interrupted += 1 },
            siren: SirenPlayer(play: { [weak self] _ in self?.sirenOn += 1 }, stop: { [weak self] in self?.sirenOff += 1 }),
            send: { [weak self] json in self?.sent.append(json) },
            settings: { [weak self] in self!.settings },
            now: { [weak self] in self!.now }
        )
        controller.onUIChange = { [weak self] phase in self?.phases.append(phase) }
        return controller
    }

    func testArmStartsMotionAndSimulateSpeaksCheckIn() {
        let controller = makeController()
        controller.arm()
        XCTAssertTrue(motion.started)
        controller.handleSimulate()
        XCTAssertEqual(interrupted, 1, "check-in cuts agent speech first")
        XCTAssertEqual(spoken.count, 1)
        XCTAssertTrue(spoken[0].contains("你还好吗"))
        guard case .checkIn = phases.last else { return XCTFail("UI must show check-in") }
    }

    func testFullTimeoutFlowEscalatesWithOptedInContact() throws {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        XCTAssertEqual(sirenOn, 1, "alarm starts the siren")
        guard case .alarm = phases.last else { return XCTFail("UI must show alarm") }
        now += 30
        controller.handleTick()
        XCTAssertEqual(sent.count, 1)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashAlert)
        XCTAssertEqual(parsed["contactOptIn"] as? Bool, true)
        XCTAssertEqual(parsed["contactNumber"] as? String, "+8613800000000")
        XCTAssertEqual(parsed["lat"] as? Double ?? 0, 31.23, accuracy: 0.001)
    }

    /// Advance the staged countdowns: 15 s check-in → alarm, then 30 s alarm → escalated.
    private func escalate(_ controller: CrashController) {
        now += 15
        controller.handleTick()
        now += 30
        controller.handleTick()
    }

    func testAckOutcomesSpeakTheTruth() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        let incidentId = controller.activeIncidentIdForTesting ?? ""
        controller.handleAck(incidentId: incidentId, status: .notified, detail: nil)
        XCTAssertTrue(spoken.last?.contains("已通知紧急联系人") ?? false)

        spoken = []
        controller.handleAck(incidentId: incidentId, status: .unconfigured, detail: nil)
        XCTAssertTrue(spoken.last?.contains("请手动拨打") ?? false, "unconfigured must never sound like success")
    }

    func testTapCancelDuringAlarmStopsSirenAndNeverEscalates() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.riderTapCancelled()
        XCTAssertEqual(sirenOff, 1)
        XCTAssertEqual(phases.last, .hidden)
        now += 60
        controller.handleTick()
        XCTAssertTrue(sent.isEmpty, "cancelled incident must not escalate")
    }

    func testVoiceCancelMatchesMeiShi() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        controller.riderTranscript("我没事，刚才手滑了")
        XCTAssertEqual(phases.last, .hidden)
    }

    func testCancelAfterEscalationSendsCrashCancel() throws {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        controller.riderTapCancelled()
        XCTAssertEqual(sent.count, 2)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[1].utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.crashCancel)
    }

    func testUnackedAlertResendsWhenSocketBecomesReady() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        XCTAssertEqual(sent.count, 1)
        controller.socketBecameReady()
        XCTAssertEqual(sent.count, 2, "pending crash.alert resends on reconnect")
        let incidentId = controller.activeIncidentIdForTesting ?? ""
        controller.handleAck(incidentId: incidentId, status: .notified, detail: nil)
        controller.socketBecameReady()
        XCTAssertEqual(sent.count, 2, "acked alert must not resend")
    }

    func testCancelledIncidentNeverResendsItsAlert() throws {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        controller.riderTapCancelled()
        XCTAssertEqual(sent.count, 2, "one alert, one cancel")
        controller.socketBecameReady()
        XCTAssertEqual(sent.count, 2, "a cancelled incident must never resend its crash.alert")
        let alert = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any])
        XCTAssertEqual(alert["type"] as? String, ClientEventTypes.crashAlert)
        let cancel = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sent[1].utf8)) as? [String: Any])
        XCTAssertEqual(cancel["type"] as? String, ClientEventTypes.crashCancel)
    }

    func testHasActiveIncidentAcrossPhases() {
        let controller = makeController()
        XCTAssertFalse(controller.hasActiveIncident, "no incident before arming")
        controller.arm()
        XCTAssertFalse(controller.hasActiveIncident, "armed alone carries no incident")
        controller.handleSimulate()
        XCTAssertTrue(controller.hasActiveIncident, "check-in is an active incident")
        now += 15
        controller.handleTick()
        XCTAssertTrue(controller.hasActiveIncident, "alarm is an active incident")
        now += 30
        controller.handleTick()
        XCTAssertTrue(controller.hasActiveIncident, "escalated is an active incident")
        controller.riderTapCancelled()
        XCTAssertFalse(controller.hasActiveIncident, "cancelling returns to armed")
    }

    func testLogOnlyModeDetectsButStaysSilent() {
        settings.logOnly = true
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        XCTAssertTrue(spoken.isEmpty)
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(phases.isEmpty || phases.last == .hidden)
    }

    func testDisarmClearsEverything() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.disarm()
        XCTAssertFalse(motion.started)
        XCTAssertEqual(sirenOff, 1)
        XCTAssertEqual(phases.last, .hidden)
    }

    func testNoAckShowsManualDialNotice() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        escalate(controller)
        now += 10
        controller.handleTick()
        guard case let .escalated(ackText) = phases.last else { return XCTFail("expected escalated") }
        XCTAssertTrue(ackText?.contains("服务器未确认") ?? false, "nobody may believe a notification that didn't happen")
    }

    func testSessionEndDuringAlarmKeepsTheAlarmRunning() {
        let controller = makeController()
        controller.arm()
        controller.handleSimulate()
        now += 15
        controller.handleTick()
        controller.sessionEnded()
        XCTAssertFalse(motion.started, "detection stops with the session")
        XCTAssertEqual(sirenOff, 0, "but an active alarm keeps running")
        now += 30
        controller.handleTick()
        XCTAssertEqual(sent.count, 1, "escalation still fires after session death")
    }

    func testSessionEndWhileMerelyArmedDisarms() {
        let controller = makeController()
        controller.arm()
        controller.sessionEnded()
        XCTAssertFalse(motion.started)
        XCTAssertEqual(phases.last ?? .hidden, .hidden)
    }
}
