import XCTest
@testable import MaxHelmet

final class DeviceCommandSessionTests: XCTestCase {

    @MainActor
    func testEndingSessionCancelsSuspendedCommandAndDropsItsReply() async {
        let session = DeviceCommandSession()
        var continuation: CheckedContinuation<DeviceActionResult, Never>?
        let started = expectation(description: "handler started")
        let cancelled = expectation(description: "handler observes cancellation")
        var sent: [String] = []
        session.submit(DeviceCommand(commandId: "old", action: .torchSet(on: true), tier: .low),
            perform: { _ in
                let result = await withCheckedContinuation { continuation = $0; started.fulfill() }
                if Task.isCancelled { cancelled.fulfill() }
                return result
            }, send: { sent.append($0) })
        await fulfillment(of: [started], timeout: 1)
        session.invalidate()
        continuation?.resume(returning: .ok)
        await fulfillment(of: [cancelled], timeout: 1)
        XCTAssertTrue(sent.isEmpty)
    }

    @MainActor
    func testDuplicateCommandRunsOnceButSameIdCanRunInNextSession() async {
        let session = DeviceCommandSession()
        let command = DeviceCommand(commandId: "same", action: .torchSet(on: true), tier: .low)
        var performed = 0
        var sent: [String] = []
        let perform: (DeviceCommand) async -> DeviceActionResult = { _ in performed += 1; return .ok }
        session.submit(command, perform: perform, send: { sent.append($0) })
        session.submit(command, perform: perform, send: { sent.append($0) })
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(performed, 1)
        XCTAssertEqual(sent.count, 1)
        session.invalidate()
        session.submit(command, perform: perform, send: { sent.append($0) })
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(performed, 2)
        XCTAssertEqual(sent.count, 2)
    }

    func testEveryCommandProducesExactlyOneResult() async {
        var sent: [String] = []
        let router = DeviceActionRouter(handlers: [:], isDeviceUnlocked: { true })
        let command = DeviceCommand(commandId: "c1", action: .torchSet(on: true), tier: .low)

        let result = await router.handle(command)
        sent.append(buildDeviceResult(commandId: command.commandId, result: result))

        XCTAssertEqual(sent.count, 1)
        XCTAssertTrue(sent[0].contains("\"commandId\":\"c1\""))
        XCTAssertTrue(sent[0].contains("\"status\":\"unsupported\""))
    }

    func testResultRoundTripsThroughTheRelayContract() throws {
        let json = buildDeviceResult(commandId: "c2", result: .ok)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.deviceResult)
    }
}
