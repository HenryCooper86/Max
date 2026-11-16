import XCTest
@testable import MaxHelmet

final class NavigationConfirmationReplyTests: XCTestCase {
    func testAcceptsEnglishAndChinesePhrases() {
        for phrase in [
            "confirm navigation", "Confirm navigation.", "Confirm", "yes", "Yes!", "OK", "okay",
            "start navigation", "That's right", "correct",
            "确认导航", "确认", "开始导航", "是的", "好的", "确认导航。"
        ] {
            XCTAssertEqual(navigationConfirmationReply(phrase, assistantName: "Max"), true, phrase)
        }
    }

    func testDeclinesInBothLanguages() {
        for phrase in ["cancel", "Cancel navigation", "no", "No.", "wrong", "取消", "取消导航", "不是", "不对"] {
            XCTAssertEqual(navigationConfirmationReply(phrase, assistantName: "Max"), false, phrase)
        }
    }

    func testIgnoresACallToTheAssistantInFront() {
        XCTAssertEqual(navigationConfirmationReply("Max, confirm navigation", assistantName: "Max"), true)
        XCTAssertEqual(navigationConfirmationReply("Hey Max, yes", assistantName: "Max"), true)
        XCTAssertEqual(navigationConfirmationReply("Max，确认导航", assistantName: "Max"), true)
        XCTAssertEqual(navigationConfirmationReply("Nova cancel", assistantName: "Nova"), false)
        // Saying only the name is not an answer.
        XCTAssertNil(navigationConfirmationReply("Max", assistantName: "Max"))
    }

    func testIgnoresEverythingElse() {
        for phrase in ["", "yes I think the weather is nice", "what time is it", "confirm the booking for tomorrow", "不知道", "navigation"] {
            XCTAssertNil(navigationConfirmationReply(phrase, assistantName: "Max"), phrase)
        }
    }
}
