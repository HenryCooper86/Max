import XCTest
@testable import MaxHelmet

private final class FakePlayer: SystemMusicPlaying, @unchecked Sendable {
    var calls: [String] = []
    var result = DeviceActionResult.ok
    @MainActor func perform(_ control: MusicControl) async -> DeviceActionResult {
        calls.append(control.rawValue)
        return result
    }
}

private final class FakePresenter: MessagePresenting, @unchecked Sendable {
    var presented: [(String, String)] = []
    var result = true
    func present(number: String, body: String) async -> Bool {
        presented.append((number, body))
        return result
    }
}

private final class FakeResolver: ContactResolving, @unchecked Sendable {
    var number: String? = "13800000000"
    var authorized = true
    func isAuthorized() async -> Bool { authorized }
    func number(matching name: String) async -> String? { number }
}

final class MusicMessageHandlerTests: XCTestCase {

    func testDrivesTheSystemPlayer() async {
        let player = FakePlayer()
        let handler = MusicController(player: player)

        _ = await handler.perform(.musicControl(control: .play, app: nil))
        _ = await handler.perform(.musicControl(control: .next, app: nil))
        _ = await handler.perform(.musicControl(control: .pause, app: nil))
        _ = await handler.perform(.musicControl(control: .previous, app: nil))

        XCTAssertEqual(player.calls, ["play", "next", "pause", "previous"])
    }

    func testRefusesANamedThirdPartyPlayer() async {
        let player = FakePlayer()
        let handler = MusicController(player: player)

        let result = await handler.perform(.musicControl(control: .play, app: "网易云音乐"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "player.unsupported")
        XCTAssertTrue(player.calls.isEmpty, "A refused player must not fall through to Apple Music")
    }

    func testPlaybackFailureIsReturnedToVoiceCommand() async {
        let player = FakePlayer()
        player.result = .failed("music.emptyQueue", "选择音乐")
        let result = await MusicController(player: player).perform(.musicControl(control: .play, app: nil))
        XCTAssertEqual(result, player.result)
    }

    func testMusicPermissionDenialIsReturnedToVoiceCommand() async {
        let player = FakePlayer()
        player.result = .denied("permission.music")
        let result = await MusicController(player: player).perform(.musicControl(control: .play, app: nil))
        XCTAssertEqual(result, player.result)
    }

    func testComposesAMessageWhenStopped() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { 0 }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(presenter.presented.first?.1, "我晚点到")
    }

    func testRefusesAboveTheSpeedLimit() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { 42 }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "unsafe.speed")
        XCTAssertTrue(presenter.presented.isEmpty)
    }

    func testRefusesWhenSpeedIsUnknown() async {
        let presenter = FakePresenter()
        let handler = MessageComposer(presenter: presenter, speedProvider: { nil }, resolver: FakeResolver())

        let result = await handler.perform(.smsCompose(name: "老王", body: "我晚点到"))

        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "unsafe.speed")
    }

    func testReportsAnUnknownRecipient() async {
        let resolver = FakeResolver()
        resolver.number = nil
        let handler = MessageComposer(presenter: FakePresenter(), speedProvider: { 0 }, resolver: resolver)

        let result = await handler.perform(.smsCompose(name: "查无此人", body: "在吗"))

        XCTAssertEqual(result.reason, "contact.notFound")
    }
}
