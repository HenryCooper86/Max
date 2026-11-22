import SwiftUI
import XCTest
@testable import MaxHelmet

/// Accessibility contracts for the controls a rider or a VoiceOver user needs
/// on the main HUD, in the style of GuidanceCardAccessibilityTests: the views
/// read these values, so asserting them here pins what VoiceOver announces.
final class HudAccessibilityTests: XCTestCase {

    // MARK: hands-free toggle (already labelled; pinned so it stays that way)

    func testHandsFreeToggleAnnouncesActionAndState() {
        XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: false), "开启免提")
        XCTAssertEqual(helmetToggleAccessibilityLabel(handsFree: true), "结束免提")
        XCTAssertEqual(helmetToggleAccessibilityValue(handsFree: true), "免提已开启")
        XCTAssertFalse(helmetToggleAccessibilityHint(handsFree: false).isEmpty)
    }

    // MARK: mute

    func testMuteSaysWhatTappingDoesAndWhetherTheMicIsLive() {
        let live = muteUtilityAccessibility(muted: false)
        XCTAssertEqual(live.label, "静音")
        XCTAssertEqual(live.value, "麦克风已开启")
        XCTAssertFalse(live.hint.isEmpty)
        let muted = muteUtilityAccessibility(muted: true)
        XCTAssertEqual(muted.label, "取消静音")
        XCTAssertEqual(muted.value, "麦克风已静音")
        XCTAssertNotEqual(live.hint, muted.hint)
    }

    // MARK: crash alarm

    func testCrashAlarmTrapsVoiceOverAndNamesItsActions() {
        let contract = crashAlarmAccessibilityContract
        XCTAssertTrue(contract.isModal, "VoiceOver must not wander to the HUD behind the alarm")
        XCTAssertTrue(contract.titleIsHeader)
        XCTAssertEqual(crashAlarmCancelAccessibilityLabel(), "我没事，取消警报")
        XCTAssertFalse(crashAlarmCancelAccessibilityHint().isEmpty)
        XCTAssertEqual(crashAlarmCallAccessibilityHint(number: "120"), "拨打 120，iOS 会先请你确认")
    }

    func testCrashCheckInBannerIsAButtonWithAHint() {
        XCTAssertFalse(crashCheckInAccessibilityHint().isEmpty)
        XCTAssertEqual(L("crash.banner.a11y", ("n", "9")), "疑似摔车，点击取消警报，剩余9秒")
    }

    func testCrashStringsAreTranslated() {
        for key in ["a11y.crash.cancel", "a11y.crash.cancel.hint", "a11y.crash.call.hint", "a11y.crash.checkIn.hint"] {
            XCTAssertNotEqual(Loc.string(key, .en), key)
            XCTAssertNil(Loc.string(key, .en, ["number": "120"]).range(of: "\\p{Han}", options: .regularExpression), key)
        }
    }

    // MARK: mascot

    func testTheMascotIsDecorationNotAControl() {
        XCTAssertTrue(mascotAccessibilityContract.hidden)
        XCTAssertFalse(mascotAccessibilityContract.hitTestable)
    }

    // MARK: typed input

    func testTypedInputFieldAndSendButtonAreNamed() {
        let field = typedInputAccessibility
        XCTAssertEqual(field.fieldLabel, "输入消息")
        XCTAssertEqual(field.sendLabel, "发送")
        XCTAssertEqual(Loc.string("a11y.typed.field", .en), "Type a message")
        XCTAssertEqual(Loc.string("a11y.typed.send", .en), "Send")
    }

    // MARK: Dynamic Type

    func testHudIconsGrowWithTheirText() {
        let regular = hudIconPointSize(13, relativeTo: .footnote, dynamicTypeSize: .large)
        let larger = hudIconPointSize(13, relativeTo: .footnote, dynamicTypeSize: .accessibility3)
        XCTAssertEqual(regular, 13, accuracy: 0.5, "the default size is unchanged")
        XCTAssertGreaterThan(larger, regular * 1.5)
    }

    func testGlanceableNumeralsAreCappedSoTheHudStillFits() {
        let capped = hudIconPointSize(48, relativeTo: .largeTitle, dynamicTypeSize: .accessibility5, maximum: 64)
        XCTAssertLessThanOrEqual(capped, 64)
        XCTAssertGreaterThanOrEqual(capped, 48)
    }
}
