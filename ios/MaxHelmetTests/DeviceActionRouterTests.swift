import XCTest
@testable import MaxHelmet

private final class FakeHandler: DeviceActionHandler, @unchecked Sendable {
    var received: [DeviceAction] = []
    var stubbed: DeviceActionResult = .ok

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        received.append(action)
        return stubbed
    }
}

final class DeviceActionRouterTests: XCTestCase {

    func testCancelledCommandNeverReachesTheHandler() async {
        let torch = FakeHandler()
        let router = DeviceActionRouter(handlers: [.torch: torch], isDeviceUnlocked: { true })
        let task = Task {
            while !Task.isCancelled { await Task.yield() }
            return await router.handle(DeviceCommand(commandId: "cancelled", action: .torchSet(on: true), tier: .low))
        }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .failed("device.cancelled"))
        XCTAssertTrue(torch.received.isEmpty)
    }

    func testRoutesEachActionToItsHandler() async {
        let torch = FakeHandler()
        let music = FakeHandler()
        let router = DeviceActionRouter(
            handlers: [.torch: torch, .music: music],
            isDeviceUnlocked: { true }
        )

        _ = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))
        _ = await router.handle(DeviceCommand(commandId: "b", action: .musicControl(control: .next, app: nil), tier: .low))

        XCTAssertEqual(torch.received, [.torchSet(on: true)])
        XCTAssertEqual(music.received, [.musicControl(control: .next, app: nil)])
    }

    func testReturnsHandlerResultVerbatim() async {
        let torch = FakeHandler()
        torch.stubbed = .failed("torch.unavailable")
        let router = DeviceActionRouter(handlers: [.torch: torch], isDeviceUnlocked: { true })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result, .failed("torch.unavailable"))
    }

    func testRefusesEverythingWhileTheDeviceIsLocked() async {
        let torch = FakeHandler()
        let router = DeviceActionRouter(handlers: [.torch: torch], isDeviceUnlocked: { false })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "device.locked")
        XCTAssertTrue(torch.received.isEmpty, "A locked device must not reach the handler")
    }

    func testReportsUnsupportedWhenNoHandlerIsRegistered() async {
        let router = DeviceActionRouter(handlers: [:], isDeviceUnlocked: { true })

        let result = await router.handle(DeviceCommand(commandId: "a", action: .torchSet(on: true), tier: .low))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "handler.missing")
    }
}
