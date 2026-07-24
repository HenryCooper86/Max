import XCTest
@testable import MaxHelmet

final class DeviceCommandSessionTests: XCTestCase {

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
