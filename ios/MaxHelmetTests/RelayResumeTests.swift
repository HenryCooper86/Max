import XCTest
@testable import MaxHelmet

/// The conversation lifecycle as a real `AgentSession` sees it through its own transport
/// (docs/protocol.md, Resuming, session.ended, agent.changed, Versions and Wearable extensions).
/// The synthetic QA mode connects without a microphone or location, as the close-code tests do.
@MainActor
final class RelayResumeTests: XCTestCase {
    private var relay: LoopbackRelay!
    private var session: AgentSession!

    override func setUp() async throws {
        relay = try LoopbackRelay()
        try await relay.start()
        session = try makeSession()
    }

    override func tearDown() {
        session.finishSyntheticAudioQA()
        relay.stop()
    }

    /// Hands-free against the relay, started and left waiting for its session.start to be answered.
    private func makeSession() throws -> AgentSession {
        let session = AgentSession()
        try session.prepareSyntheticAudioQA()
        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)
        return session
    }

    /// Waits for the `n`th session.start and answers it.
    private func answerSessionStart(number n: Int, with event: String) async throws {
        try await waitUntil("session.start #\(n)") { self.relay.sessionStarts().count >= n }
        relay.current?.send(text: event)
        try await waitUntil("session #\(n) to be ready") { self.session.state.connection == .ready }
    }

    func testADroppedLinkResumesTheConversationAndANewSessionDoesNot() async throws {
        try await answerSessionStart(number: 1, with: LoopbackRelay.sessionStarted(resume: "rsm_first"))
        XCTAssertNil(relay.sessionStarts()[0]["resume"], "a new conversation leaves the id out")

        // The link drops: the reconnect carries the conversation on instead of greeting again.
        relay.current?.drop()
        try await answerSessionStart(number: 2, with: LoopbackRelay.sessionStarted(resume: "rsm_second"))
        XCTAssertEqual(relay.sessionStarts()[1]["resume"] as? String, "rsm_first")

        // The relay answers with a new id; a later reconnect sends that one.
        relay.current?.drop()
        try await answerSessionStart(number: 3, with: LoopbackRelay.sessionStarted(resume: "rsm_third"))
        XCTAssertEqual(relay.sessionStarts()[2]["resume"] as? String, "rsm_second")
        XCTAssertEqual(relay.connectionCount, 3, "each drop costs one reconnect")

        // The rider ended hands-free: the next session is a new conversation.
        session.stop()
        XCTAssertFalse(session.state.handsFree)
        session.finishSyntheticAudioQA()
        session = try makeSession()
        try await waitUntil("the new session's session.start") { self.relay.sessionStarts().count == 4 }
        XCTAssertNil(relay.sessionStarts()[3]["resume"], "hands-free ended for good, so nothing is resumed")
    }

    func testAFinalCloseEndsTheConversationForGood() async throws {
        // 4001 idle, 4003 voice minutes used up, 1008 credentials refused (docs/protocol.md, Close codes).
        let closes: [(code: UInt16, status: String)] = [
            (4001, L("st.idleEnded")), (4003, L("st.minutesUsedUp")), (1008, L("st.signInAgain"))
        ]
        for (iteration, close) in closes.enumerated() {
            try await answerSessionStart(number: iteration + 1, with: LoopbackRelay.sessionStarted(resume: "rsm_\(close.code)"))
            relay.current?.close(code: close.code)
            try await waitUntil("hands-free to end after \(close.code)") { !self.session.state.handsFree }
            XCTAssertEqual(session.state.statusText, close.status)
            // Past the first reconnect backoff (1 s): a final close is not retried.
            try await Task.sleep(nanoseconds: 1_500_000_000)
            XCTAssertEqual(relay.connectionCount, iteration + 1, "a final close must not be retried")

            session.finishSyntheticAudioQA()
            session = try makeSession()
            try await waitUntil("the next session's session.start") { self.relay.sessionStarts().count == iteration + 2 }
            XCTAssertNil(relay.sessionStarts()[iteration + 1]["resume"], "close \(close.code) ended the conversation")
        }
    }

    func testTheRelayEndingTheConversationEndsHandsFreeWithItsReason() async throws {
        try await answerSessionStart(number: 1, with: LoopbackRelay.sessionStarted())

        relay.current?.send(text: #"{"type":"session.ended","reason":"max_duration"}"#)
        // Right after the event the relay closes with 4001 and the reason.
        relay.current?.close(code: 4001, reason: "max_duration")
        try await waitUntil("hands-free to end") { !self.session.state.handsFree }
        XCTAssertEqual(session.state.statusText, L("st.endedMaxDuration"))
        XCTAssertEqual(session.state.connection, .offline, "a conversation the relay ended is not a failure")

        // The close behind the event is not a second end: the reason stays and nothing reconnects.
        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertEqual(session.state.statusText, L("st.endedMaxDuration"))
        XCTAssertEqual(relay.connectionCount, 1)
    }

    func testAHandoverToAnotherAgentIsShownOnTheStatusLine() async throws {
        try await answerSessionStart(number: 1, with: LoopbackRelay.sessionStarted())
        relay.current?.send(text: #"{"type":"agent.changed","agent":"billing"}"#)
        try await waitUntil("the handover to be shown") {
            self.session.state.statusText == L("st.agentChanged", ("agent", "billing"))
        }
    }

    func testANewerRelayIsWarnedAboutOncePerHandsFreeSession() async throws {
        try await answerSessionStart(number: 1, with: LoopbackRelay.sessionStarted(protocol: 2))
        let warning = L("st.protocolMismatch", ("relay", "2"), ("ours", "1"))
        XCTAssertEqual(session.state.statusText, warning, "the warning is on the status line")

        // A reconnect to the same newer relay does not say it again.
        relay.current?.drop()
        try await answerSessionStart(number: 2, with: LoopbackRelay.sessionStarted(protocol: 2))
        XCTAssertEqual(session.state.statusText, L("st.mockRoute"))

        // Nor does a relay that is not ahead, or one too old to say.
        relay.current?.drop()
        try await answerSessionStart(number: 3, with: LoopbackRelay.sessionStarted(protocol: 1))
        XCTAssertEqual(session.state.statusText, L("st.mockRoute"))
        relay.current?.drop()
        try await answerSessionStart(number: 4, with: LoopbackRelay.sessionStarted(protocol: nil))
        XCTAssertEqual(session.state.statusText, L("st.mockRoute"))
    }

    func testDeviceCommandsThisAppCannotCarryOutAreAnsweredAtOnce() async throws {
        try await answerSessionStart(number: 1, with: LoopbackRelay.sessionStarted())
        relay.current?.send(text: #"{"type":"device.command","commandId":"c-look","action":"camera.look","args":{"on":true},"tier":"low"}"#)
        // A torch with no `on` and a recording with no `start` must not run as "off" and "stop".
        relay.current?.send(text: #"{"type":"device.command","commandId":"c-torch","action":"torch.set","args":{},"tier":"low"}"#)
        relay.current?.send(text: #"{"type":"device.command","commandId":"c-record","action":"camera.record","tier":"low"}"#)
        // One this app does carry out still goes to the device layer.
        relay.current?.send(text: #"{"type":"device.command","commandId":"c-on","action":"torch.set","args":{"on":true},"tier":"low"}"#)

        try await waitUntil("the four results") { self.relay.deviceResults().count >= 4 }
        func outcome(_ commandId: String) -> (status: String, reason: String?) {
            for result in relay.deviceResults() where result["commandId"] as? String == commandId {
                return (result["status"] as? String ?? "", result["reason"] as? String)
            }
            return ("", "no result")
        }
        XCTAssertEqual(outcome("c-look").status, "unsupported")
        XCTAssertEqual(outcome("c-look").reason, "action.unknown")
        XCTAssertEqual(outcome("c-torch").status, "unsupported")
        XCTAssertEqual(outcome("c-torch").reason, "action.invalid")
        XCTAssertEqual(outcome("c-record").status, "unsupported")
        XCTAssertEqual(outcome("c-record").reason, "action.invalid")
        XCTAssertEqual(outcome("c-on").reason, "device.synthetic-qa-disabled")
    }
}
