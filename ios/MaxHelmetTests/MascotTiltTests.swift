import XCTest
@testable import MaxHelmet

final class MascotTiltTests: XCTestCase {
    private let dt = 1.0 / 30.0

    func testAPhoneHeldStillLeavesTheBirdAtHome() {
        var tilt = MascotTilt()
        for _ in 0..<90 { tilt.step(gravityX: 0.1, gravityY: -0.95, dt: dt) }
        XCTAssertEqual(tilt.offset.width, 0, accuracy: 0.001)
        XCTAssertEqual(tilt.offset.height, 0, accuracy: 0.001)
    }

    func testTippingRightSlidesTheBirdRightThenItSettlesBack() {
        var tilt = MascotTilt()
        for _ in 0..<30 { tilt.step(gravityX: 0, gravityY: -1, dt: dt) }
        for _ in 0..<15 { tilt.step(gravityX: 0.25, gravityY: -0.97, dt: dt) }
        XCTAssertGreaterThan(tilt.offset.width, 0.2)
        // Held in the new position, that becomes the resting posture.
        for _ in 0..<600 { tilt.step(gravityX: 0.25, gravityY: -0.97, dt: dt) }
        XCTAssertEqual(tilt.offset.width, 0, accuracy: 0.02)
    }

    func testTippingTheTopAwaySlidesTheBirdUp() {
        var tilt = MascotTilt()
        for _ in 0..<30 { tilt.step(gravityX: 0, gravityY: -1, dt: dt) }
        for _ in 0..<15 { tilt.step(gravityX: 0, gravityY: -0.75, dt: dt) }
        XCTAssertLessThan(tilt.offset.height, -0.2)
    }

    func testAHardShakeNeverThrowsTheBirdPastItsLimit() {
        var tilt = MascotTilt()
        for index in 0..<300 {
            let swing = index % 2 == 0 ? 1.0 : -1.0
            tilt.step(gravityX: swing, gravityY: swing, dt: dt)
            XCTAssertLessThanOrEqual(abs(tilt.offset.width), MascotTilt.limit.width + 0.0001)
            XCTAssertLessThanOrEqual(abs(tilt.offset.height), MascotTilt.limit.height + 0.0001)
        }
    }
}
