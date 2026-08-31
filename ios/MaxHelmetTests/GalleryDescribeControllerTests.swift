import XCTest
@testable import MaxHelmet

/// In-memory CaptureStoring fake modeled on CameraControllerTests' FakeStore:
/// configurable captures() list (already newest-first), fileURL(for:) returning
/// temp paths, other methods no-op.
private final class FakeStore: CaptureStoring, @unchecked Sendable {
    var list: [Capture] = []
    func hasSpace() -> Bool { true }
    func captures() -> [Capture] { list }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture {
        Capture(id: "p", type: .photo, filename: "p.heic", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t.jpg")
    }
    func indexVideo(at url: URL) throws -> Capture {
        Capture(id: "v", type: .video, filename: url.lastPathComponent, createdAt: 0, durationSec: 1, exported: false, thumbnailName: "t.jpg")
    }
    func markExported(_ id: String) {}
    func delete(_ id: String) {}
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.filename)") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.thumbnailName)") }
}

final class GalleryDescribeControllerTests: XCTestCase {

    private func photo(id: String, createdAt: Double) -> Capture {
        Capture(id: id, type: .photo, filename: "\(id).heic", createdAt: createdAt, durationSec: nil, exported: false, thumbnailName: "\(id)-t.jpg")
    }

    private func video(id: String, createdAt: Double) -> Capture {
        Capture(id: id, type: .video, filename: "\(id).mov", createdAt: createdAt, durationSec: 3, exported: false, thumbnailName: "\(id)-t.jpg")
    }

    /// Parses a sent vision.frames JSON string into its fields for assertions.
    private func fields(_ json: String) -> [String: Any] {
        let data = Data(json.utf8)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func testEmptyGallery() async {
        let store = FakeStore()
        var sends: [String] = []
        let controller = GalleryDescribeController(
            store: store,
            send: { sends.append($0) }
        )

        let result = await controller.perform(.galleryDescribe(kind: "photo", question: nil), commandId: "c1")

        XCTAssertEqual(result, .failed("gallery.empty"))
        XCTAssertTrue(sends.isEmpty)
    }

    func testPhotoSendsSingleChunkThenOk() async throws {
        let store = FakeStore()
        let older = photo(id: "pOlder", createdAt: 1)
        store.list = [video(id: "vNewer", createdAt: 2), older]
        // The real CaptureStore always has bytes on disk for a photo capture;
        // the controller reads them before handing off to extractPhoto, so the
        // fake needs a real file at the resolved fileURL too.
        try Data([0x50, 0x48, 0x4F]).write(to: store.fileURL(for: older))
        addTeardownBlock { try? FileManager.default.removeItem(at: store.fileURL(for: older)) }
        var sends: [String] = []
        var sendHappenedBeforeReturn = false
        let controller = GalleryDescribeController(
            store: store,
            send: { json in
                sends.append(json)
                sendHappenedBeforeReturn = true
            },
            extractPhoto: { _ in "UEhPVE8=" },
            extractVideo: { _ in XCTFail("must not extract video for a photo target"); return nil }
        )

        let result = await controller.perform(
            .galleryDescribe(kind: "photo", question: "what is this?"), commandId: "c2"
        )

        XCTAssertTrue(sendHappenedBeforeReturn, "send must happen before perform returns")
        XCTAssertEqual(sends.count, 1)
        let f = fields(sends[0])
        XCTAssertEqual(f["commandId"] as? String, "c2")
        XCTAssertEqual(f["index"] as? Int, 0)
        XCTAssertEqual(f["total"] as? Int, 1)
        XCTAssertEqual(f["image"] as? String, "UEhPVE8=")
        XCTAssertEqual(f["question"] as? String, "what is this?")
        XCTAssertEqual(result, .ok)
    }

    func testVideoSendsEightChunksInOrder() async throws {
        let store = FakeStore()
        store.list = [video(id: "v1", createdAt: 1)]
        var sends: [String] = []
        let frames = (0..<8).map { "F\($0)" }
        let controller = GalleryDescribeController(
            store: store,
            send: { sends.append($0) },
            extractPhoto: { _ in XCTFail("must not extract photo for a video target"); return nil },
            extractVideo: { _ in frames }
        )

        let result = await controller.perform(.galleryDescribe(kind: "video", question: nil), commandId: "c3")

        XCTAssertEqual(sends.count, 8)
        for (i, json) in sends.enumerated() {
            let f = fields(json)
            XCTAssertEqual(f["index"] as? Int, i)
            XCTAssertEqual(f["total"] as? Int, 8)
            XCTAssertEqual(f["image"] as? String, "F\(i)")
        }
        XCTAssertEqual(result, .ok)
    }

    func testLatestPicksNewestOfAnyKind() async {
        let store = FakeStore()
        store.list = [video(id: "vNewest", createdAt: 5), photo(id: "pOlder", createdAt: 1)]
        var photoCalled = false
        var videoCalled = false
        let controller = GalleryDescribeController(
            store: store,
            send: { _ in },
            extractPhoto: { _ in photoCalled = true; return "photo" },
            extractVideo: { _ in videoCalled = true; return ["F0"] }
        )

        let result = await controller.perform(.galleryDescribe(kind: "latest", question: nil), commandId: "c4")

        XCTAssertTrue(videoCalled)
        XCTAssertFalse(photoCalled)
        XCTAssertEqual(result, .ok)
    }

    func testExtractionFailure() async {
        let store = FakeStore()
        store.list = [video(id: "v1", createdAt: 1)]
        var sends: [String] = []
        let controller = GalleryDescribeController(
            store: store,
            send: { sends.append($0) },
            extractVideo: { _ in nil }
        )

        let result = await controller.perform(.galleryDescribe(kind: "video", question: nil), commandId: "c5")

        XCTAssertEqual(result, .failed("gallery.unreadable"))
        XCTAssertTrue(sends.isEmpty)
    }
}
