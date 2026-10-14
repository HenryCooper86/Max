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
    var completion: ((Result<URL, Error>) -> Void)?
    var access: (() async -> Bool)?
    var onStart: (() async -> Void)?
    var onStop: (() async throws -> URL)?
    var onPhoto: (() async throws -> Data)?
    func setRecordingCompletion(_ completion: @escaping (Result<URL, Error>) -> Void) { self.completion = completion }

    func authorization() -> CameraAuthorization { auth }
    func requestAccess() async -> Bool { if let access { return await access() }; return granted }
    func capturePhoto() async throws -> Data {
        if throwOnPhoto { throw CaptureStoreError.thumbnailFailed }
        if let onPhoto { return try await onPhoto() }
        return photoData
    }
    func startRecording(to url: URL) async throws {
        if throwOnStart { throw CaptureStoreError.thumbnailFailed }
        started.append(url)
        if let onStart { await onStart() }
    }
    func stopRecording() async throws -> URL {
        stopped += 1
        if let onStop { return try await onStop() }
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

@MainActor
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

    func testPhotoDuringRecordingDoesNotStopTheMovieSession() async {
        let session = FakeSession(), store = FakeStore()
        let controller = make(session, store)
        _ = await controller.perform(.cameraRecord(start: true))
        let result = await controller.perform(.cameraPhoto)
        XCTAssertEqual(result, .failed("camera.recording"))
        XCTAssertTrue(store.photos.isEmpty)
        _ = await controller.perform(.cameraRecord(start: false))
    }

    func testEndingSessionFinalizesTheRecordingOnce() async {
        let session = FakeSession(), store = FakeStore()
        var recordingStates: [Bool] = []
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { recordingStates.append($0) }, onOpenGallery: {}, onAutoStopped: {})
        _ = await controller.perform(.cameraRecord(start: true))
        await controller.stopForSession()
        await controller.stopForSession()
        XCTAssertEqual(session.stopped, 1)
        XCTAssertEqual(store.indexedVideos.count, 1)
        XCTAssertEqual(recordingStates, [true, false])
    }

    func testConcurrentStopTriggersShareOnePendingFinalization() async throws {
        let session = FakeSession(), store = FakeStore()
        let controller = make(session, store)
        _ = await controller.perform(.cameraRecord(start: true))
        let requested = expectation(description: "first stop requested")
        var pending: [CheckedContinuation<URL, Error>] = []
        session.onStop = {
            try await withCheckedThrowingContinuation {
                pending.append($0)
                if pending.count == 1 { requested.fulfill() }
            }
        }
        let manual = Task { await controller.perform(.cameraRecord(start: false)) }
        await fulfillment(of: [requested], timeout: 1)
        let backgroundStarted = expectation(description: "background stop entered")
        let background = Task { backgroundStarted.fulfill(); await controller.stopForSession() }
        await fulfillment(of: [backgroundStarted], timeout: 1)
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(session.stopped, 1)
        for continuation in pending { continuation.resume(returning: session.started[0]) }
        _ = await manual.value
        await background.value
        XCTAssertEqual(store.indexedVideos.count, 1)
    }

    func testRecordingCannotOverlapAPhotoPermissionWait() async {
        let session = FakeSession(), store = FakeStore()
        session.auth = .notDetermined
        var permission: CheckedContinuation<Bool, Never>?
        let requested = expectation(description: "photo permission requested")
        session.access = { await withCheckedContinuation { permission = $0; requested.fulfill() } }
        let controller = make(session, store)
        let photo = Task { await controller.perform(.cameraPhoto) }
        await fulfillment(of: [requested], timeout: 1)
        session.auth = .authorized
        let recording = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(recording, .failed("camera.busy"))
        XCTAssertTrue(session.started.isEmpty)
        permission?.resume(returning: true)
        _ = await photo.value
        await controller.stopForSession()
    }

    func testRecordingCannotOverlapAnInFlightStillCapture() async {
        let session = FakeSession(), store = FakeStore()
        var capture: CheckedContinuation<Data, Error>?
        let requested = expectation(description: "still capture started")
        session.onPhoto = { try await withCheckedThrowingContinuation { capture = $0; requested.fulfill() } }
        let controller = make(session, store)
        let photo = Task { await controller.perform(.cameraPhoto) }
        await fulfillment(of: [requested], timeout: 1)
        let duplicatePhoto = await controller.perform(.cameraPhoto)
        XCTAssertEqual(duplicatePhoto, .failed("camera.busy"))
        let recording = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(recording, .failed("camera.busy"))
        XCTAssertTrue(session.started.isEmpty)
        capture?.resume(returning: Data([1]))
        _ = await photo.value
        await controller.stopForSession()
    }

    func testAutonomousFinishIndexesClipAndClearsRecording() async {
        let session = FakeSession(), store = FakeStore()
        var recordingStates: [Bool] = []
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { recordingStates.append($0) }, onOpenGallery: {}, onAutoStopped: {})
        _ = await controller.perform(.cameraRecord(start: true))
        session.completion?(.success(session.started[0]))
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(store.indexedVideos, session.started)
        XCTAssertEqual(recordingStates, [true, false])
        let result = await controller.perform(.cameraRecord(start: false))
        XCTAssertEqual(result, .failed("camera.notRecording"))
    }

    func testEndingSessionDuringCameraPermissionDoesNotStartRecording() async {
        let session = FakeSession(), store = FakeStore()
        session.auth = .notDetermined
        let requested = expectation(description: "permission requested")
        var permission: CheckedContinuation<Bool, Never>?
        session.access = { await withCheckedContinuation { permission = $0; requested.fulfill() } }
        let controller = make(session, store)
        let task = Task { await controller.perform(.cameraRecord(start: true)) }
        await fulfillment(of: [requested], timeout: 1)
        await controller.stopForSession()
        permission?.resume(returning: true)
        let result = await task.value
        XCTAssertEqual(result, .failed("capture.cancelled"))
        XCTAssertTrue(session.started.isEmpty)
    }

    func testAutonomousCaptureFailureClearsRecordingWithoutIndexing() async {
        let session = FakeSession(), store = FakeStore()
        var states: [Bool] = []
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { states.append($0) }, onOpenGallery: {}, onAutoStopped: {})
        _ = await controller.perform(.cameraRecord(start: true))
        session.completion?(.failure(CaptureError.notRecording))
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(states, [true, false])
        XCTAssertTrue(store.indexedVideos.isEmpty)
    }

    func testCaptureFailureDuringStartupCannotLeaveRecordingOn() async {
        let session = FakeSession(), store = FakeStore()
        var states: [Bool] = []
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { states.append($0) }, onOpenGallery: {}, onAutoStopped: {})
        session.onStart = {
            session.completion?(.failure(CaptureError.notRecording))
            await Task.yield()
            await Task.yield()
        }
        let result = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(result, .failed("capture.failed"))
        XCTAssertNotEqual(states.last, true)
        XCTAssertTrue(store.indexedVideos.isEmpty)
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
