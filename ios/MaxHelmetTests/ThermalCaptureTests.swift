import XCTest
@testable import MaxHelmet

private final class StubCaptureSession: CaptureSessioning, @unchecked Sendable {
    var started: [URL] = []
    var stopped = 0
    var photos = 0
    func authorization() -> CameraAuthorization { .authorized }
    func requestAccess() async -> Bool { true }
    func capturePhoto() async throws -> Data { photos += 1; return Data([1]) }
    func startRecording(to url: URL) async throws { started.append(url) }
    func stopRecording() async throws -> URL { stopped += 1; return started.last ?? URL(fileURLWithPath: "/tmp/none.mov") }
}

private final class StubCaptureStore: CaptureStoring, @unchecked Sendable {
    var list: [Capture] = []
    var indexed: [URL] = []
    func hasSpace() -> Bool { true }
    func captures() -> [Capture] { list }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture {
        Capture(id: "p", type: .photo, filename: "p.heic", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t.jpg")
    }
    func indexVideo(at url: URL) throws -> Capture {
        indexed.append(url)
        return Capture(id: "v", type: .video, filename: url.lastPathComponent, createdAt: 0, durationSec: 1, exported: false, thumbnailName: "t.jpg")
    }
    func markExported(_ id: String) {}
    func delete(_ id: String) {}
    func fileURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.filename)") }
    func thumbnailURL(for capture: Capture) -> URL { URL(fileURLWithPath: "/tmp/\(capture.thumbnailName)") }
}

@MainActor
final class ThermalCameraTests: XCTestCase {
    private var policy = CapturePolicy.unrestricted
    private var recordingChanges: [Bool] = []

    private func camera(_ session: StubCaptureSession, _ store: StubCaptureStore = StubCaptureStore()) -> CameraController {
        CameraController(
            session: session, store: store,
            onRecordingChange: { [unowned self] in self.recordingChanges.append($0) },
            onOpenGallery: {}, onAutoStopped: {},
            capturePolicy: { [unowned self] in self.policy }
        )
    }

    func testAHotPhoneRefusesToStartRecording() async {
        let session = StubCaptureSession()
        policy = capturePolicy(heat: .serious, lowPowerMode: false)
        let result = await camera(session).perform(.cameraRecord(start: true))
        XCTAssertEqual(result, .denied("device.hot"))
        XCTAssertTrue(session.started.isEmpty)
    }

    func testLowPowerModeRefusesToStartRecordingWithItsOwnReason() async {
        policy = capturePolicy(heat: .nominal, lowPowerMode: true)
        let result = await camera(StubCaptureSession()).perform(.cameraRecord(start: true))
        XCTAssertEqual(result, .denied("device.powerSave"))
    }

    func testPhotosStillWorkWhenWarmButNotWhenCritical() async {
        let session = StubCaptureSession()
        let controller = camera(session)
        policy = capturePolicy(heat: .serious, lowPowerMode: false)
        let warm = await controller.perform(.cameraPhoto)
        XCTAssertEqual(warm, .ok)
        policy = capturePolicy(heat: .critical, lowPowerMode: false)
        let critical = await controller.perform(.cameraPhoto)
        XCTAssertEqual(critical, .denied("device.hot"))
        XCTAssertEqual(session.photos, 1)
    }

    func testHeatingUpMidRecordingStopsAndKeepsTheClip() async {
        let session = StubCaptureSession()
        let store = StubCaptureStore()
        let controller = camera(session, store)
        let started = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(started, .ok)
        policy = capturePolicy(heat: .serious, lowPowerMode: false)
        let stopped = await controller.enforce(policy)
        XCTAssertTrue(stopped)
        XCTAssertEqual(session.stopped, 1)
        XCTAssertEqual(store.indexed.count, 1, "what was recorded before the stop is saved")
        XCTAssertEqual(recordingChanges, [true, false])
    }

    func testLowPowerModeDoesNotCutARecordingAlreadyRunning() async {
        let session = StubCaptureSession()
        let controller = camera(session)
        _ = await controller.perform(.cameraRecord(start: true))
        policy = capturePolicy(heat: .nominal, lowPowerMode: true)
        let stopped = await controller.enforce(policy)
        XCTAssertFalse(stopped)
        XCTAssertEqual(session.stopped, 0)
    }

    func testEnforcingWhileIdleDoesNothing() async {
        let session = StubCaptureSession()
        let stopped = await camera(session).enforce(capturePolicy(heat: .critical, lowPowerMode: false))
        XCTAssertFalse(stopped)
        XCTAssertEqual(session.stopped, 0)
    }
}

final class ThermalGalleryDescribeTests: XCTestCase {
    private func store(with type: Capture.Kind) -> StubCaptureStore {
        let store = StubCaptureStore()
        store.list = [Capture(id: "c", type: type, filename: "c.bin", createdAt: 1, durationSec: type == .video ? 3 : nil, exported: false, thumbnailName: "t.jpg")]
        return store
    }

    func testAHotPhoneRefusesToDecodeVideoFrames() async {
        var extracted = 0
        let controller = GalleryDescribeController(
            store: store(with: .video), send: { _ in },
            extractVideo: { _ in extracted += 1; return ["a"] },
            capturePolicy: { capturePolicy(heat: .serious, lowPowerMode: false) }
        )
        let result = await controller.perform(.galleryDescribe(kind: "video", question: nil), commandId: "c1")
        XCTAssertEqual(result, .denied("device.hot"))
        XCTAssertEqual(extracted, 0, "the refusal comes before the expensive decode")
    }

    func testACoolPhoneStillDescribes() async {
        var sends = 0
        let controller = GalleryDescribeController(
            store: store(with: .video), send: { _ in sends += 1 },
            extractVideo: { _ in ["a", "b"] },
            capturePolicy: { .unrestricted }
        )
        let result = await controller.perform(.galleryDescribe(kind: "video", question: nil), commandId: "c1")
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(sends, 2)
    }
}
