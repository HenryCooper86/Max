import XCTest
@testable import MaxHelmet

private final class FakeTorch: TorchCapableDevice, @unchecked Sendable {
    var hasTorch = true
    var isOn = false
    var throwOnSet = false

    func setTorch(on: Bool) throws {
        if throwOnSet { throw NSError(domain: "test", code: 1) }
        isOn = on
    }
}

private final class FakeGain: PlaybackGain, @unchecked Sendable {
    var level: Float = 1.0
    func setLevel(_ newLevel: Float) { level = newLevel }
}

final class TorchVolumeHandlerTests: XCTestCase {

    func testTurnsTorchOnAndOff() async {
        let torch = FakeTorch()
        let handler = TorchController(device: torch)

        let onResult = await handler.perform(.torchSet(on: true))
        XCTAssertEqual(onResult, .ok)
        XCTAssertTrue(torch.isOn)

        let offResult = await handler.perform(.torchSet(on: false))
        XCTAssertEqual(offResult, .ok)
        XCTAssertFalse(torch.isOn)
    }

    func testReportsMissingTorchHardware() async {
        let torch = FakeTorch()
        torch.hasTorch = false
        let handler = TorchController(device: torch)

        let result = await handler.perform(.torchSet(on: true))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "torch.unavailable")
    }

    func testReportsTorchLockFailure() async {
        let torch = FakeTorch()
        torch.throwOnSet = true
        let handler = TorchController(device: torch)

        let result = await handler.perform(.torchSet(on: true))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "torch.unavailable")
    }

    func testRaisesAndLowersGainWithinBounds() async {
        let gain = FakeGain()
        let handler = PlaybackVolumeController(gain: gain)

        _ = await handler.perform(.volumeSet(direction: .up))
        XCTAssertEqual(gain.level, 1.5, accuracy: 0.001)

        gain.level = PlaybackVolumeController.maximumLevel
        _ = await handler.perform(.volumeSet(direction: .up))
        XCTAssertEqual(gain.level, PlaybackVolumeController.maximumLevel, accuracy: 0.001)

        gain.level = PlaybackVolumeController.minimumLevel
        _ = await handler.perform(.volumeSet(direction: .down))
        XCTAssertEqual(gain.level, PlaybackVolumeController.minimumLevel, accuracy: 0.001)
    }
}
