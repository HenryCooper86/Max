import XCTest
@testable import MaxHelmet

private final class FakeSession: CaptureSessioning, @unchecked Sendable {
    var auth: CameraAuthorization = .authorized
    var granted = true
    var photoData = Data([0x01])
    var throwOnPhoto = false
    var throwOnStart = false
    var started: [URL] = []
    var stopped = 0

    func authorization() -> CameraAuthorization { auth }
    func requestAccess() async -> Bool { granted }
    func capturePhoto() async throws -> Data {
        if throwOnPhoto { throw CaptureStoreError.thumbnailFailed }
        return photoData
    }
    func startRecording(to url: URL) async throws {
        if throwOnStart { throw CaptureStoreError.thumbnailFailed }
        started.append(url)
    }
    func stopRecording() async throws -> URL {
        stopped += 1
        return started.last ?? URL(fileURLWithPath: "/tmp/none.mov")
    }
}

private final class FakeStore: CaptureStoring, @unchecked Sendable {
    var space = true
    var photos: [Data] = []
    var indexedVideos: [URL] = []
    func hasSpace() -> Bool { space }
    func captures() -> [Capture] { [] }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture {
        photos.append(data)
        return Capture(id: "p", type: .photo, filename: "p.heic", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t.jpg")
    }
    func indexVideo(at url: URL) throws -> Capture {
        indexedVideos.append(url)
        return Capture(id: "v", type: .video, filename: url.lastPathComponent, createdAt: 0, durationSec: 1, exported: false, thumbnailName: "t.jpg")
    }
    func markExported(_ id: String) {}
    func delete(_ id: String) {}
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.filename)") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.thumbnailName)") }
}

final class CameraControllerTests: XCTestCase {

    private func make(_ session: FakeSession, _ store: FakeStore, gallery: @escaping () -> Void = {}) -> CameraController {
        CameraController(session: session, store: store, onRecordingChange: { _ in }, onOpenGallery: gallery, onAutoStopped: {})
    }

    func testTakesAPhoto() async {
        let session = FakeSession(), store = FakeStore()
        let result = await make(session, store).perform(.cameraPhoto)
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(store.photos.count, 1)
    }

    func testPhotoReportsDeniedPermission() async {
        let session = FakeSession(); session.auth = .denied
        let result = await make(session, FakeStore()).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "permission.camera")
    }

    func testPhotoRefusedWhenLowOnSpace() async {
        let store = FakeStore(); store.space = false
        let result = await make(FakeSession(), store).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .denied)
        XCTAssertEqual(result.reason, "storage.full")
    }

    func testPhotoFailureIsReported() async {
        let session = FakeSession(); session.throwOnPhoto = true
        let result = await make(session, FakeStore()).perform(.cameraPhoto)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "capture.failed")
    }

    func testStartsAndStopsRecording() async {
        let session = FakeSession(), store = FakeStore()
        let controller = make(session, store)

        let start = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(start, .ok)
        XCTAssertEqual(session.started.count, 1)

        let stop = await controller.perform(.cameraRecord(start: false))
        XCTAssertEqual(stop, .ok)
        XCTAssertEqual(session.stopped, 1)
        XCTAssertEqual(store.indexedVideos.count, 1)
    }

    func testStartWhileRecordingIsABenignGuard() async {
        let session = FakeSession()
        let controller = make(session, FakeStore())
        _ = await controller.perform(.cameraRecord(start: true))

        let again = await controller.perform(.cameraRecord(start: true))

        XCTAssertEqual(again.status, .failed)
        XCTAssertEqual(again.reason, "camera.recording")
        XCTAssertEqual(session.started.count, 1, "No second recording is started")
    }

    func testStopWhileIdleIsABenignGuard() async {
        let session = FakeSession()
        let result = await make(session, FakeStore()).perform(.cameraRecord(start: false))
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.reason, "camera.notRecording")
        XCTAssertEqual(session.stopped, 0)
    }

    func testGalleryOpenInvokesTheCallback() async {
        var opened = false
        let result = await make(FakeSession(), FakeStore(), gallery: { opened = true }).perform(.galleryOpen)
        XCTAssertEqual(result, .ok)
        XCTAssertTrue(opened)
    }
}
