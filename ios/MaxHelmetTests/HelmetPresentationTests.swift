import XCTest
@testable import MaxHelmet

final class HelmetPresentationTests: XCTestCase {
    func testHelmetToggleAccessibilityUsesSessionStateNotTurnState() {
        XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: false), "开启免提")
        XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: true), "结束免提")
        XCTAssertEqual(helmetToggleAccessibilityHint(handsFree: false), "开启免提会话")
        XCTAssertEqual(helmetToggleAccessibilityHint(handsFree: true), "结束免提会话，或取消正在进行的连接")
        XCTAssertEqual(helmetToggleAccessibilityValue(handsFree: false), "免提未开启")
        XCTAssertEqual(helmetToggleAccessibilityValue(handsFree: true), "免提已开启")
    }

    private func hazardState(handsFree: Bool, connection: ConnectionState) -> AgentSession.State {
        var state = AgentSession.State()
        state.handsFree = handsFree
        state.connection = connection
        state.rideContext.hazardLevel = .critical
        return state
    }

    func testOffSessionHazardDoesNotActivateHelmetPresentation() {
        let state = hazardState(handsFree: false, connection: .ready)
        XCTAssertFalse(isHazardPresentationActive(state))
    }

    func testConnectingHazardDoesNotActivateHelmetPresentation() {
        let state = hazardState(handsFree: true, connection: .connecting)
        XCTAssertFalse(isHazardPresentationActive(state))
    }

    func testReadyAndRelayHazardsActivateHelmetPresentation() {
        XCTAssertTrue(isHazardPresentationActive(hazardState(handsFree: true, connection: .ready)))
        XCTAssertTrue(isHazardPresentationActive(hazardState(handsFree: true, connection: .relay)))
    }

    func testReducedMotionUsesStableHelmetPhase() {
        XCTAssertEqual(helmetMotionTime(elapsed: 42, reduceMotion: true), 0)
        XCTAssertEqual(helmetMotionTime(elapsed: 42, reduceMotion: false), 42)
    }

    /// A final relay close (used-up minutes, refused credentials) leaves its
    /// reason on the idle screen; a session that ended normally keeps the start hint.
    func testAnIdleScreenSaysWhyTheLastSessionEndedOnlyWhenItFailed() {
        var state = AgentSession.State()
        state.statusText = L("st.minutesUsedUp")
        XCTAssertEqual(readoutHint(state, wakePhrase: "Max"), L("hint.wake", ("wake", "Max")))
        state.connection = .degraded
        XCTAssertEqual(readoutHint(state, wakePhrase: "Max"), L("st.minutesUsedUp"))
        state.handsFree = true
        XCTAssertEqual(readoutHint(state, wakePhrase: nil), L("hint.end"), "while live the hint stays about the session")
    }
}
