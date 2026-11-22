import XCTest
@testable import MaxHelmet

final class TypedInputProtocolTests: XCTestCase {

    // MARK: - session.started capabilities

    func testSessionStartedParsesTextInputAndToolsCapabilities() {
        let event = parseAgentEvent(#"{"type":"session.started","provider":"openai","mode":"live","capabilities":{"serverVad":true,"tools":true,"textInput":true}}"#)
        guard case let .sessionStarted(_, _, capabilities) = event else { return XCTFail("expected session.started, got \(event)") }
        XCTAssertTrue(capabilities.textInput)
        XCTAssertTrue(capabilities.tools)
        XCTAssertTrue(capabilities.serverVad)
    }

    func testOlderRelaysWithoutTheNewCapabilitiesReportThemOff() {
        let event = parseAgentEvent(#"{"type":"session.started","provider":"doubao","mode":"live","capabilities":{"serverVad":true}}"#)
        guard case let .sessionStarted(_, _, capabilities) = event else { return XCTFail("expected session.started") }
        XCTAssertFalse(capabilities.textInput)
        XCTAssertFalse(capabilities.tools)
    }

    // MARK: - text.input

    func testTypedTurnIsTrimmedAndSentAsTextInput() throws {
        let json = try XCTUnwrap(prepareTextInput("  Where is the nearest fuel?\n", textInputSupported: true, ready: true).get())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "text.input")
        XCTAssertEqual(object["text"] as? String, "Where is the nearest fuel?")
        XCTAssertEqual(object.count, 2, "text.input carries only type and text")
    }

    func testTypedTurnRespectsTheProtocolLimits() {
        XCTAssertEqual(prepareTextInput("   \n ", textInputSupported: true, ready: true), .failure(.empty))
        XCTAssertEqual(prepareTextInput(String(repeating: "a", count: 2001), textInputSupported: true, ready: true), .failure(.tooLong))
        XCTAssertNotNil(try? prepareTextInput(String(repeating: "好", count: 2000), textInputSupported: true, ready: true).get())
    }

    func testTypedTurnIsNotSentWhenTheBackendCannotTakeItOrIsNotReady() {
        XCTAssertEqual(prepareTextInput("hi", textInputSupported: false, ready: true), .failure(.unsupported))
        XCTAssertEqual(prepareTextInput("hi", textInputSupported: true, ready: false), .failure(.notReady))
    }

    func testTheTextFieldShowsOnlyWhenTheReadyBackendReportsTextInput() {
        var caps = ProviderCapabilities()
        XCTAssertFalse(typedInputVisible(capabilities: caps, connection: .ready))
        caps.textInput = true
        XCTAssertTrue(typedInputVisible(capabilities: caps, connection: .ready))
        for connection in [ConnectionState.offline, .connecting, .relay, .provider, .degraded] {
            XCTAssertFalse(typedInputVisible(capabilities: caps, connection: connection), "\(connection)")
        }
    }

    // MARK: - tool.activity

    func testToolActivityIsParsed() {
        let started = parseAgentEvent(#"{"type":"tool.activity","callId":"c1","name":"get_weather","where":"server","state":"started"}"#)
        guard case let .toolActivity(activity) = started else { return XCTFail("expected tool.activity, got \(started)") }
        XCTAssertEqual(activity, ToolActivity(callId: "c1", name: "get_weather", state: .started))

        let failed = parseAgentEvent(#"{"type":"tool.activity","callId":"c1","name":"get_weather","where":"server","state":"failed","error":"timeout"}"#)
        guard case let .toolActivity(failure) = failed else { return XCTFail("expected tool.activity") }
        XCTAssertEqual(failure.state, .failed)
    }

    func testToolActivityLineShowsWhileAnyCallRunsAndClearsWhenAllFinish() {
        var tracker = ToolActivityTracker()
        XCTAssertFalse(tracker.isBusy)
        tracker.apply(ToolActivity(callId: "a", name: "search", state: .started), now: 0)
        tracker.apply(ToolActivity(callId: "b", name: "weather", state: .started), now: 1)
        XCTAssertTrue(tracker.isBusy)
        tracker.apply(ToolActivity(callId: "a", name: "search", state: .succeeded), now: 2)
        XCTAssertTrue(tracker.isBusy, "b is still running")
        tracker.apply(ToolActivity(callId: "b", name: "weather", state: .failed), now: 3)
        XCTAssertFalse(tracker.isBusy)
    }

    func testAToolCallWhoseEndNeverArrivesStopsShowingAfterTheRelayTimeout() {
        var tracker = ToolActivityTracker()
        tracker.apply(ToolActivity(callId: "a", name: "search", state: .started), now: 100)
        tracker.expire(now: 100 + ToolActivityTracker.staleAfter - 0.1)
        XCTAssertTrue(tracker.isBusy)
        tracker.expire(now: 100 + ToolActivityTracker.staleAfter)
        XCTAssertFalse(tracker.isBusy)
    }

    func testToolActivityLineIsLocalised() {
        XCTAssertEqual(L("tool.activity.busy", in: .zh), "正在查询…")
        XCTAssertEqual(L("tool.activity.busy", in: .en), "Looking that up…")
    }

    // MARK: - tool.call (this app declares no client tools)

    func testUnexpectedToolCallIsParsed() {
        let event = parseAgentEvent(#"{"type":"tool.call","callId":"call_8f2","name":"open_page","arguments":{"path":"/"}}"#)
        guard case let .toolCall(callId, name) = event else { return XCTFail("expected tool.call, got \(event)") }
        XCTAssertEqual(callId, "call_8f2")
        XCTAssertEqual(name, "open_page")
    }

    func testUnexpectedToolCallIsAnsweredOnceWithAnError() throws {
        let json = try XCTUnwrap(unexpectedToolCallReply(callId: "call_8f2", name: "open_page"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "tool.result")
        XCTAssertEqual(object["callId"] as? String, "call_8f2")
        XCTAssertNil(object["output"], "an error result carries no output")
        let error = try XCTUnwrap(object["error"] as? String)
        XCTAssertTrue(error.contains("open_page"))
        XCTAssertLessThanOrEqual(error.count, 1000)
    }

    func testAToolCallWithAnInvalidCallIdCannotBeAnswered() {
        XCTAssertNil(unexpectedToolCallReply(callId: "", name: "x"))
        XCTAssertNil(unexpectedToolCallReply(callId: String(repeating: "c", count: 129), name: "x"))
        XCTAssertNotNil(unexpectedToolCallReply(callId: String(repeating: "c", count: 128), name: "x"))
    }
}
