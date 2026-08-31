import XCTest
@testable import MaxHelmet

@MainActor
final class CameraSessionWiringTests: XCTestCase {

    func testGalleryModelWiresAStoreToTheRealExporter() throws {
        // Proves the store → gallery-model → system-exporter types compose (the
        // exact wiring MainViewModel uses), without constructing the shared
        // AgentSession singleton, which starts audio/capture subsystems that a
        // unit-test host has no entitlements for.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("wiring-\(UUID().uuidString)")
        let store = CaptureStore(root: root, availableBytes: { 5_000_000_000 })
        let model = GalleryModel(store: store, exporter: SystemPhotoLibraryExporter())
        model.refresh()
        XCTAssertTrue(model.captures.isEmpty)
    }

    func testDeviceResultForGalleryOpenRoundTrips() throws {
        let json = buildDeviceResult(commandId: "g1", result: .ok)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["status"] as? String, "ok")
    }
}
