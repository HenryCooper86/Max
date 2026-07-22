import XCTest
@testable import MaxHelmet

final class VoiceMicDockTests: XCTestCase {
    func testMapsIdleConnectingLiveAndMutedStates() {
        var state = AgentSession.State()
        XCTAssertEqual(micDockPresentation(state).mode, .idle)
        XCTAssertEqual(micDockPresentation(state).label, "开始免提")

        state.handsFree = true
        state.connection = .provider
        XCTAssertEqual(micDockPresentation(state).mode, .connecting)
        XCTAssertEqual(micDockPresentation(state).label, "连接中")

        state.connection = .ready
        XCTAssertEqual(micDockPresentation(state).mode, .live)
        XCTAssertEqual(micDockPresentation(state).label, "结束免提")

        state.micMuted = true
        XCTAssertEqual(micDockPresentation(state).mode, .muted)
    }

    func testAnimatesOnlyReadyUnmutedRiderInput() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening
        state.voiceLevel = 0.5

        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .hearing
        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .thinking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .speaking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .listening
        state.connection = .degraded
        XCTAssertFalse(isVoiceInputActive(state))
        state.connection = .ready
        state.micMuted = true
        XCTAssertFalse(isVoiceInputActive(state))
    }

    func testAppliesNoiseFloorSensitivityAndClamp() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening

        state.voiceLevel = 0.035
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
        state.voiceLevel = 0.5
        XCTAssertEqual(micDisplayLevel(state), 0.7905, accuracy: 0.0001)
        state.voiceLevel = 1
        XCTAssertEqual(micDisplayLevel(state), 1, accuracy: 0.0001)
        state.turnState = .thinking
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
    }

    func testReturnsStableThreeBarGeometry() {
        XCTAssertEqual(micMeterHeights(0), [6, 6, 6])
        XCTAssertEqual(micMeterHeights(1), [14, 18, 15])
        XCTAssertEqual(micMeterHeights(2), [14, 18, 15])
    }
}
