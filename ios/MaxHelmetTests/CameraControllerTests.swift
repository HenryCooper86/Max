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
    var onIndex: (() async -> Void)?
    var failIndexing = false
    func hasSpace() -> Bool { space }
    func captures() -> [Capture] { [] }
    func newVideoURL() -> URL { URL(fileURLWithPath: "/tmp/\(UUID().uuidString).mov") }
    func addPhoto(_ data: Data) throws -> Capture {
        photos.append(data)
        return Capture(id: "p", type: .photo, filename: "p.heic", createdAt: 0, durationSec: nil, exported: false, thumbnailName: "t.jpg")
    }
    func indexVideo(at url: URL) async throws -> Capture {
        indexedVideos.append(url)
        await onIndex?()
        if failIndexing { throw CaptureStoreError.thumbnailFailed }
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
        // Indexing awaits off the main actor, so wait for it instead of counting yields.
        let indexed = expectation(description: "clip indexed")
        store.onIndex = { indexed.fulfill() }
        await fulfillment(of: [indexed], timeout: 1)
        XCTAssertEqual(store.indexedVideos, session.started)
        XCTAssertEqual(recordingStates, [true, false])
        let result = await controller.perform(.cameraRecord(start: false))
        XCTAssertEqual(result, .failed("camera.notRecording"))
    }

    func testStartWhileThePreviousClipIsBeingIndexedIsBusy() async {
        let session = FakeSession(), store = FakeStore()
        let finished = expectation(description: "clip indexed and the rider told")
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { _ in }, onOpenGallery: {}, onAutoStopped: { finished.fulfill() })
        _ = await controller.perform(.cameraRecord(start: true))
        // AVFoundation ended the clip by itself (a disk limit, an interruption).
        // Indexing is held from here so a start can be asked for while it runs.
        let indexing = expectation(description: "indexing started")
        var gate: CheckedContinuation<Void, Never>?
        store.onIndex = {
            await withCheckedContinuation { gate = $0; indexing.fulfill() }
        }
        session.completion?(.success(session.started[0]))
        await fulfillment(of: [indexing], timeout: 1)

        let busy = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(busy, .failed("camera.busy"))
        XCTAssertEqual(session.started.count, 1, "no second recording starts while the first clip is being indexed")

        gate?.resume()
        await fulfillment(of: [finished], timeout: 1)
        let again = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(again, .ok)
        XCTAssertEqual(session.started.count, 2)
        XCTAssertEqual(store.indexedVideos, [session.started[0]])
    }

    /// Stops a recording the way a device does: AVFoundation reports the finished clip first,
    /// and that report's finish is held inside indexing before the stop's own result lands.
    /// Checks that the stop is still waiting, then lets indexing finish and returns what the
    /// stop reported.
    private func stopWithAVFoundationReportingFirst(indexingFails: Bool) async
        -> (result: DeviceActionResult, controller: CameraController, session: FakeSession, store: FakeStore) {
        let session = FakeSession(), store = FakeStore()
        store.failIndexing = indexingFails
        var recordingStates: [Bool] = []
        let controller = CameraController(session: session, store: store,
            onRecordingChange: { recordingStates.append($0) }, onOpenGallery: {}, onAutoStopped: {})
        _ = await controller.perform(.cameraRecord(start: true))
        let indexing = expectation(description: "indexing started")
        var gate: CheckedContinuation<Void, Never>?
        store.onIndex = {
            await withCheckedContinuation { gate = $0; indexing.fulfill() }
        }
        // The stop's own result only lands once the completion's finish is indexing.
        let (releaseStop, releaseStopContinuation) = AsyncStream<Void>.makeStream()
        session.onStop = {
            let url = session.started[0]
            session.completion?(.success(url))
            var release = releaseStop.makeAsyncIterator()
            _ = await release.next()
            return url
        }
        var stopResult: DeviceActionResult?
        let stop = Task { () -> DeviceActionResult in
            let result = await controller.perform(.cameraRecord(start: false))
            stopResult = result
            return result
        }
        await fulfillment(of: [indexing], timeout: 1)
        releaseStopContinuation.yield()
        // Both reports are in and indexing is held. A stop that returned the previous
        // recording's result instead of waiting would have returned by now.
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertNil(stopResult, "the stop waits for its clip to be indexed")
        XCTAssertEqual(recordingStates, [true, false])
        gate?.resume()
        let result = await stop.value
        return (result, controller, session, store)
    }

    func testStopAndCompletionOfTheSameClipAwaitOneFinishAndIndexOnce() async {
        let (result, controller, session, store) = await stopWithAVFoundationReportingFirst(indexingFails: false)
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(store.indexedVideos, session.started, "indexed once, for both reports")
        XCTAssertEqual(session.stopped, 1)
        let restart = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(restart, .ok, "a start right after the stop is not busy")
    }

    func testStopReportsTheFailedIndexingOfTheSameClipReportedTwice() async {
        let (result, controller, _, store) = await stopWithAVFoundationReportingFirst(indexingFails: true)
        XCTAssertEqual(result, .failed("capture.failed"), "its clip's outcome, not the .ok its start left behind")
        XCTAssertEqual(store.indexedVideos.count, 1, "indexed once, for both reports")
        let restart = await controller.perform(.cameraRecord(start: true))
        XCTAssertEqual(restart, .ok, "a start right after the stop is not busy")
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
