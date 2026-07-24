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
}

/// The camera device-action handler. Owns recording state and the benign state
/// guards; delegates capture to `CaptureSessioning` and persistence to
/// `CaptureStoring`. A reference type because it holds recording state across
/// commands.
final class CameraController: DeviceActionHandler {
    /// A forgotten "开始录像" must not eat the disk.
    static let maxRecordingSeconds: TimeInterval = 600

    private let session: CaptureSessioning
    private let store: CaptureStoring
    private let onRecordingChange: (Bool) -> Void
    private let onOpenGallery: () -> Void
    private let onAutoStopped: () -> Void

    private var recording = false
    private var autoStopTask: Task<Void, Never>?

    init(
        session: CaptureSessioning,
        store: CaptureStoring,
        onRecordingChange: @escaping (Bool) -> Void,
        onOpenGallery: @escaping () -> Void,
        onAutoStopped: @escaping () -> Void
    ) {
        self.session = session
        self.store = store
        self.onRecordingChange = onRecordingChange
        self.onOpenGallery = onOpenGallery
        self.onAutoStopped = onAutoStopped
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
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
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard store.hasSpace() else { return .denied("storage.full") }
        do {
            let data = try await session.capturePhoto()
            _ = try store.addPhoto(data)
            return .ok
        } catch {
            return .failed("capture.failed")
        }
    }

    private func startRecording() async -> DeviceActionResult {
        guard !recording else { return .failed("camera.recording") }
        guard await ensureAuthorized() else { return .denied("permission.camera") }
        guard store.hasSpace() else { return .denied("storage.full") }
        do {
            try await session.startRecording(to: store.newVideoURL())
            recording = true
            onRecordingChange(true)
            scheduleAutoStop()
            return .ok
        } catch {
            return .failed("capture.failed")
        }
    }

    private func stopRecording(auto: Bool) async -> DeviceActionResult {
        guard recording else { return .failed("camera.notRecording") }
        autoStopTask?.cancel()
        autoStopTask = nil
        do {
            let url = try await session.stopRecording()
            recording = false
            onRecordingChange(false)
            _ = try store.indexVideo(at: url)
            if auto { onAutoStopped() }
            return .ok
        } catch {
            recording = false
            onRecordingChange(false)
            return .failed("capture.failed")
        }
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
final class AVFoundationCaptureSession: NSObject, CaptureSessioning {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "camera-session")
    private var configured = false
    private var photoContinuation: CheckedContinuation<Data, Error>?
    private var recordContinuation: CheckedContinuation<URL, Error>?

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
            // A reached minFreeDiskSpaceLimit surfaces as an error, but the file
            // written so far is valid — keep it rather than losing the clip.
            self.recordContinuation?.resume(returning: outputFileURL)
            self.recordContinuation = nil
        }
    }
}
