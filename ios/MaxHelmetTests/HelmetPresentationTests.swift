import XCTest
@testable import MaxHelmet

final class HelmetPresentationTests: XCTestCase {
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
}
