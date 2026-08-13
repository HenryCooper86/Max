import XCTest
@testable import MaxHelmet

final class SessionLifecycleTests: XCTestCase {
    func testSecondHandsFreeToggleStopsAnActiveOrConnectingSession() {
        XCTAssertFalse(shouldStopHandsFreeSession(handsFree: false))
        XCTAssertTrue(shouldStopHandsFreeSession(handsFree: true))
    }

    func testStopInvalidatesDelayedStartupCallbacks() throws {
        var lifecycle = SessionLifecycle()
        let generation = try XCTUnwrap(lifecycle.begin())

        XCTAssertTrue(lifecycle.accepts(generation))
        XCTAssertTrue(lifecycle.stop())
        XCTAssertFalse(lifecycle.accepts(generation))
    }

    func testOnlyOneStartOwnsResourcesAtATime() throws {
        var lifecycle = SessionLifecycle()

        XCTAssertNotNil(lifecycle.begin())
        XCTAssertNil(lifecycle.begin())
        XCTAssertTrue(lifecycle.stop())
        XCTAssertNotNil(lifecycle.begin())
    }
}
