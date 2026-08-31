import XCTest
@testable import MaxHelmet

final class VoiceUtilityPillTests: XCTestCase {
    func testMuteUtilityPillUsesMinimumInteractiveHeight() {
        XCTAssertGreaterThanOrEqual(muteUtilityMinimumHitHeight, 44)
    }
}
