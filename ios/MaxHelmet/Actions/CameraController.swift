import AVFoundation
import Foundation

enum CameraAuthorization {
    case authorized
    case denied
    case notDetermined
}

/// The capture surface behind a protocol so the handler's state machine is
/// testable — a real AVCaptureSession works on neither the simulator nor a unit
/// test. Video-only: no method here ever configures an audio input, which is
/// what keeps the mic with the voice engine.
protocol CaptureSessioning {
    func authorization() -> CameraAuthorization
    func requestAccess() async -> Bool
    func capturePhoto() async throws -> Data
    func startRecording(to url: URL) async throws
    func stopRecording() async throws -> URL
    func setRecordingCompletion(_ completion: @escaping (Result<URL, Error>) -> Void)
}

extension CaptureSessioning {
    func setRecordingCompletion(_ completion: @escaping (Result<URL, Error>) -> Void) {}
}

/// The camera device-action handler. Owns recording state and the benign state
/// guards; delegates capture to `CaptureSessioning` and persistence to
/// `CaptureStoring`. A reference type because it holds recording state across
/// commands.
@MainActor
final class CameraController: DeviceActionHandler {
    /// A forgotten "开始录像" must not eat the disk.
    static let maxRecordingSeconds: TimeInterval = 600

    private let session: CaptureSessioning
    private let store: CaptureStoring
    private let onRecordingChange: (Bool) -> Void
    private let onOpenGallery: () -> Void
    private let onAutoStopped: () -> Void
    /// What the phone's heat and Low Power Mode allow right now.
    private let capturePolicy: () -> CapturePolicy

    private var recording = false
    /// Called before the camera is taken for a photo or a recording: live video,
    /// which has a capture session of its own, lets go of it first.
    var willUseCamera: () -> Void = {}
    private var autoStopTask: Task<Void, Never>?
    private var operationGeneration = 0
    private var startingRecording = false
    private var lastRecordingResult: DeviceActionResult = .ok
    private var manualStop = false
    private var takingPhoto = false
    private var stopTask: Task<DeviceActionResult, Never>?
    /// The clip being finished. Indexing awaits off the main actor, and the
    /// same clip is reported twice — by the stop that asked for it and by
    /// AVFoundation's own completion — so the second report waits for the
    /// first instead of reading a result that is not written yet. A new
    /// recording waits too (`camera.busy`): one clip in flight at a time.
    private var finishTask: Task<DeviceActionResult, Never>?

    init(
        session: CaptureSessioning,
        store: CaptureStoring,
        onRecordingChange: @escaping (Bool) -> Void,
        onOpenGallery: @escaping () -> Void,
        onAutoStopped: @escaping () -> Void,
        capturePolicy: @escaping () -> CapturePolicy = { .unrestricted }
    ) {
        self.session = session
        self.store = store
        self.onRecordingChange = onRecordingChange
        self.onOpenGallery = onOpenGallery
        self.onAutoStopped = onAutoStopped
        self.capturePolicy = capturePolicy
        session.setRecordingCompletion { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                _ = await self.finishRecording(result, auto: !self.manualStop)
            }
        }
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard !Task.isCancelled else { return .failed("capture.cancelled") }
        switch action {
        case .cameraPhoto:
            return await takePhoto()
        case let .cameraRecord(start):
            return start ? await startRecording() : await stopRecording(auto: false)
        case .galleryOpen:
            onOpenGallery()
            return .ok
        default:
            return .unsupported("action.mismatch")
        }
    }

    private func ensureAuthorized() async -> Bool {
        switch session.authorization() {
        case .authorized: return true
        case .notDetermined: return await session.requestAccess()
        case .denied: return false
        }
    }

    private func takePhoto() async -> DeviceActionResult {
        guard !recording, !startingRecording else { return .failed("camera.recording") }
        guard !takingPhoto else { return .failed("camera.busy") }
        if let refusal = capturePolicy().photo { return refusal.result }
        takingPhoto = true
        defer { takingPhoto = false }
        let generation = operationGeneration
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard !Task.isCancelled, generation == operationGeneration else { return .failed("capture.cancelled") }
        guard store.hasSpace() else { return .denied("storage.full") }
        do {
            willUseCamera()
            let data = try await session.capturePhoto()
            _ = try store.addPhoto(data)
            return .ok
        } catch {
            return .failed("capture.failed")
        }
    }

    private func startRecording() async -> DeviceActionResult {
        guard !recording, !startingRecording else { return .failed("camera.recording") }
        guard !takingPhoto, stopTask == nil, finishTask == nil else { return .failed("camera.busy") }
        if let refusal = capturePolicy().videoRecording { return refusal.result }
        startingRecording = true
        defer { startingRecording = false }
        let generation = operationGeneration
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard !Task.isCancelled, generation == operationGeneration else { return .failed("capture.cancelled") }
        guard store.hasSpace() else { return .denied("storage.full") }
        recording = true
        lastRecordingResult = .ok
        do {
            willUseCamera()
            try await session.startRecording(to: store.newVideoURL())
            guard recording else { return lastRecordingResult }
            if Task.isCancelled || generation != operationGeneration {
                _ = await stopRecording(auto: false)
                return .failed("capture.cancelled")
            }
            onRecordingChange(true)
            scheduleAutoStop()
            // Heat that arrived while the start was awaited was not seen by
            // enforce() (nothing was recording yet); check again now it runs.
            if capturePolicy().videoRecording == .hot {
                _ = await stopRecording(auto: false)
                return CaptureRefusal.hot.result
            }
            return .ok
        } catch {
            return await finishRecording(.failure(error), auto: false)
        }
    }

    private func stopRecording(auto: Bool) async -> DeviceActionResult {
        if let stopTask { return await stopTask.value }
        guard recording else { return .failed("camera.notRecording") }
        let task = Task { @MainActor in
            manualStop = !auto
            defer { manualStop = false; stopTask = nil }
            autoStopTask?.cancel()
            autoStopTask = nil
            do {
                let url = try await session.stopRecording()
                return await finishRecording(.success(url), auto: auto)
            } catch {
                return await finishRecording(.failure(error), auto: auto)
            }
        }
        stopTask = task
        return await task.value
    }

    /// Applies a new heat policy to a recording in progress. Heat stops it (the
    /// clip so far is kept, as with any stop); Low Power Mode does not cut a
    /// recording the rider already started. Returns whether it stopped one.
    @discardableResult
    func enforce(_ policy: CapturePolicy) async -> Bool {
        guard policy.videoRecording == .hot, recording, !startingRecording else { return false }
        _ = await stopRecording(auto: false)
        return true
    }

    /// Ends capture independently of voice/audio teardown and invalidates permission waits.
    func stopForSession() async {
        operationGeneration += 1
        if recording && !startingRecording { _ = await stopRecording(auto: false) }
    }

    private func finishRecording(_ result: Result<URL, Error>, auto: Bool) async -> DeviceActionResult {
        // The same clip can be reported twice (see finishTask): the later report waits for
        // the finish the earlier one started, not for the result of the recording before.
        if let finishTask { return await finishTask.value }
        guard recording else { return lastRecordingResult }
        recording = false
        autoStopTask?.cancel()
        autoStopTask = nil
        onRecordingChange(false)
        let task = Task { @MainActor in
            defer { finishTask = nil }
            do {
                let url = try result.get()
                _ = try await store.indexVideo(at: url)
                lastRecordingResult = .ok
                if auto { onAutoStopped() }
            } catch {
                lastRecordingResult = .failed("capture.failed")
            }
            return lastRecordingResult
        }
        finishTask = task
        return await task.value
    }

    private func scheduleAutoStop() {
        autoStopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.maxRecordingSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            _ = await self.stopRecording(auto: true)
        }
    }
}

enum CaptureError: Error {
    /// stopRecording was called while the movie output was not recording.
    case notRecording
}

/// The production `CaptureSessioning`, backed by AVFoundation. Rear camera,
/// video-only: it never adds an audio input and disables automatic audio-session
/// configuration, so the voice engine keeps the microphone. All AVCaptureSession
/// work runs on a dedicated serial queue.
/// `@unchecked Sendable`: the async methods hand it to that queue, and every
/// mutable property is only touched on it.
final class AVFoundationCaptureSession: NSObject, CaptureSessioning, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "camera-session")
    private var configured = false
    private var photoContinuation: CheckedContinuation<Data, Error>?
    private var recordContinuation: CheckedContinuation<URL, Error>?
    private var recordingCompletion: ((Result<URL, Error>) -> Void)?

    func setRecordingCompletion(_ completion: @escaping (Result<URL, Error>) -> Void) {
        queue.async { self.recordingCompletion = completion }
    }

    func authorization() -> CameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    private func configureIfNeeded() throws {
        guard !configured else { return }
        session.automaticallyConfiguresApplicationAudioSession = false
        session.beginConfiguration()
        session.sessionPreset = .high
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            session.commitConfiguration()
            throw CaptureStoreError.thumbnailFailed
        }
        session.addInput(input)
        if session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
        if session.canAddOutput(movieOutput) {
            session.addOutput(movieOutput)
            movieOutput.minFreeDiskSpaceLimit = Int64(CaptureStore.minimumFreeBytes)
        }
        session.commitConfiguration()
        configured = true
    }

    func capturePhoto() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    try self.configureIfNeeded()
                    if !self.session.isRunning { self.session.startRunning() }
                    self.photoContinuation = continuation
                    self.photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func startRecording(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    try self.configureIfNeeded()
                    if !self.session.isRunning { self.session.startRunning() }
                    self.movieOutput.startRecording(to: url, recordingDelegate: self)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stopRecording() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                // If the output is not actually recording, the didFinishRecording
                // delegate will never fire — resuming here avoids hanging forever
                // and leaving the HUD's recording indicator stuck on.
                guard self.movieOutput.isRecording else {
                    self.session.stopRunning()
                    continuation.resume(throwing: CaptureError.notRecording)
                    return
                }
                self.recordContinuation = continuation
                self.movieOutput.stopRecording()
            }
        }
    }
}

extension AVFoundationCaptureSession: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        queue.async {
            defer { self.session.stopRunning() }
            if let error {
                self.photoContinuation?.resume(throwing: error)
            } else if let data = photo.fileDataRepresentation() {
                self.photoContinuation?.resume(returning: data)
            } else {
                self.photoContinuation?.resume(throwing: CaptureStoreError.thumbnailFailed)
            }
            self.photoContinuation = nil
        }
    }
}

extension AVFoundationCaptureSession: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        queue.async {
            self.session.stopRunning()
            // AVFoundation can finish without an explicit stop (disk limit or interruption).
            // Preserve successful partial movies, but never index a failed recording.
            let finishedSuccessfully = (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
            let result: Result<URL, Error> = if let error, !finishedSuccessfully {
                .failure(error)
            } else {
                .success(outputFileURL)
            }
            self.recordingCompletion?(result)
            self.recordContinuation?.resume(with: result)
            self.recordContinuation = nil
        }
    }
}
