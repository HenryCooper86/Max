import XCTest
@testable import MaxHelmet

/// What an `AgentSession` records from the relay's lifecycle events, for the parts of the app that
/// show the active agent and the diagnostics. Same synthetic transport as `RelayResumeTests`.
@MainActor
final class RelayLifecycleStateTests: XCTestCase {
    func testTheActiveAgentIsRecordedForTheSessionAndStartsClean() async throws {
        let relay = try LoopbackRelay()
        try await relay.start()
        defer { relay.stop() }
        let session = AgentSession()
        try session.prepareSyntheticAudioQA()
        defer { session.finishSyntheticAudioQA() }

        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)
        try await waitUntil("session.start") { relay.sessionStarts().count == 1 }
        relay.current?.send(text: LoopbackRelay.sessionStarted())
        try await waitUntil("ready") { session.state.connection == .ready }
        XCTAssertNil(session.state.activeAgent, "nothing is named until the relay hands the conversation over")

        relay.current?.send(text: #"{"type":"agent.changed","agent":"billing"}"#)
        try await waitUntil("the agent to be recorded") { session.state.activeAgent == "billing" }
        relay.current?.send(text: #"{"type":"agent.changed","agent":"main"}"#)
        try await waitUntil("the handover back") { session.state.activeAgent == "main" }

        session.stop()
        session.finishSyntheticAudioQA()
        try session.prepareSyntheticAudioQA()
        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)
        try await waitUntil("the new session's session.start") { relay.sessionStarts().count == 2 }
        XCTAssertNil(session.state.activeAgent, "a new conversation starts with no agent named")
    }

    func testANewerRelayIsKeptInDiagnosticsForTheSessionAndStartsClean() async throws {
        let relay = try LoopbackRelay()
        try await relay.start()
        defer { relay.stop() }
        let session = AgentSession()
        try session.prepareSyntheticAudioQA()
        defer { session.finishSyntheticAudioQA() }

        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)
        try await waitUntil("session.start") { relay.sessionStarts().count == 1 }
        relay.current?.send(text: LoopbackRelay.sessionStarted(protocol: 3))
        try await waitUntil("ready") { session.state.connection == .ready }
        let warning = L("st.protocolMismatch", ("relay", "3"), ("ours", String(protocolVersion)))
        XCTAssertEqual(session.state.protocolWarning, warning)
        XCTAssertEqual(session.state.transientNotice, warning, "a banner on the HUD")

        // Still in diagnostics after the banner and the status line have moved on.
        relay.current?.drop()
        try await waitUntil("the reconnect's session.start") { relay.sessionStarts().count == 2 }
        relay.current?.send(text: LoopbackRelay.sessionStarted(protocol: 3))
        try await waitUntil("ready again") { session.state.connection == .ready }
        XCTAssertEqual(session.state.protocolWarning, warning, "kept for diagnostics across reconnects")

        session.stop()
        session.finishSyntheticAudioQA()
        try session.prepareSyntheticAudioQA()
        session.start(url: relay.agentURL.absoluteString, allowSelfSignedTls: false)
        try await waitUntil("the new session's session.start") { relay.sessionStarts().count == 3 }
        relay.current?.send(text: LoopbackRelay.sessionStarted())
        try await waitUntil("ready") { session.state.connection == .ready }
        XCTAssertNil(session.state.protocolWarning, "a new session that is not behind says nothing")
    }
}
