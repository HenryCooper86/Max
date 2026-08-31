import XCTest
@testable import MaxHelmet

final class GalleryDescribeProtocolTests: XCTestCase {
    func testParsesGalleryDescribe() {
        XCTAssertEqual(parseDeviceAction("gallery.describe", ["kind": "photo"]), .galleryDescribe(kind: "photo", question: nil))
        XCTAssertEqual(
            parseDeviceAction("gallery.describe", ["kind": "video", "question": "有什么"]),
            .galleryDescribe(kind: "video", question: "有什么")
        )
        XCTAssertEqual(parseDeviceAction("gallery.describe", [:]), .galleryDescribe(kind: "latest", question: nil))
    }

    func testRouteMapping() {
        XCTAssertEqual(DeviceActionRoute(.galleryDescribe(kind: "photo", question: nil)), .galleryDescribe)
    }

    func testBuildVisionFrameShape() throws {
        let json = buildVisionFrame(commandId: "c9", index: 1, total: 8, image: "QUJD", question: "有什么")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "vision.frames")
        XCTAssertEqual(object["commandId"] as? String, "c9")
        XCTAssertEqual(object["reason"] as? String, "gallery")
        XCTAssertEqual(object["index"] as? Int, 1)
        XCTAssertEqual(object["total"] as? Int, 8)
        XCTAssertEqual(object["image"] as? String, "QUJD")
        XCTAssertEqual(object["question"] as? String, "有什么")
        let bare = buildVisionFrame(commandId: "c9", index: 0, total: 1, image: "QUJD", question: nil)
        let bareObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(bare.utf8)) as? [String: Any])
        XCTAssertNil(bareObject["question"])
    }

    func testIdentifiedHandlerReceivesCommandId() async {
        final class Probe: IdentifiedDeviceActionHandler {
            var seen: (DeviceAction, String)?
            func perform(_ action: DeviceAction) async -> DeviceActionResult { .unsupported("wrong.path") }
            func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult {
                seen = (action, commandId)
                return .ok
            }
        }
        let probe = Probe()
        let router = DeviceActionRouter(handlers: [.galleryDescribe: probe], isDeviceUnlocked: { true })
        let result = await router.handle(DeviceCommand(commandId: "c1", action: .galleryDescribe(kind: "latest", question: nil), tier: .low))
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(probe.seen?.1, "c1")
    }
}
