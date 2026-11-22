import AVFoundation
import CoreImage
import UIKit

/// The camera behind live video (video.frame): frames come from a capture
/// output on a background queue, only the newest is kept, and the session
/// takes one a second. It is its own AVCaptureSession, video only, so the
/// mic stays with the voice engine; the photo and recording one in
/// CameraController is not used. Neither the simulator nor a unit test has a
/// camera, so what can be tested is in VideoInput.swift.
// Its state is behind the lock and the session queue.
final class VideoCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    /// For the preview layer.
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "max.videocamera.session")
    private let frameQueue = DispatchQueue(label: "max.videocamera.frames")
    private let output = AVCaptureVideoDataOutput()
    private var configured = false
    /// Says how far frames must be turned to be upright, however the phone is held. On `queue`.
    private var rotation: AVCaptureDevice.RotationCoordinator?

    private let lock = NSLock()
    private var newest: CVPixelBuffer?
    private var newestTaken = true
    /// Which camera is on. Read from the main thread only.
    private(set) var position: AVCaptureDevice.Position = .front

    private func device(_ position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
    }

    /// The camera that is on, for the preview to follow. Main thread.
    var current: AVCaptureDevice? { device(position) }

    /// Turns the frames upright again after the phone was turned: the app runs
    /// in landscape too. Called with every frame taken, so a second at most
    /// goes by with a frame on its side.
    func keepLevel() {
        queue.async { self.level() }
    }

    /// On `queue`.
    private func level() {
        guard let connection = output.connection(with: .video) else { return }
        let angle = rotation?.videoRotationAngleForHorizonLevelCapture ?? 90
        if connection.videoRotationAngle != angle, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    /// Opens the camera, asking permission the first time. The simulator has no
    /// camera: that is `.unavailable`, with no permission asked.
    func start(position wanted: AVCaptureDevice.Position = .front) async -> VideoStartResult {
        guard device(wanted) != nil else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { return .denied }
        default: return .denied
        }
        let opened: Bool = await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.configure(wanted)) }
        }
        guard opened else { return .unavailable }
        position = wanted
        return .started
    }

    /// Switches between the front and the back camera. False when there is no other camera.
    func switchCamera() async -> Bool {
        let wanted: AVCaptureDevice.Position = position == .front ? .back : .front
        guard device(wanted) != nil else { return false }
        let done: Bool = await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.configure(wanted)) }
        }
        if done { position = wanted }
        return done
    }

    func stop() {
        queue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
        lock.lock()
        newest = nil
        newestTaken = true
        lock.unlock()
    }

    /// The newest frame, once: nil when there is no new one since the last call.
    func takeNewestFrame() -> CVPixelBuffer? {
        lock.lock()
        defer { lock.unlock() }
        guard !newestTaken else { return nil }
        newestTaken = true
        return newest
    }

    /// On `queue`.
    private func configure(_ wanted: AVCaptureDevice.Position) -> Bool {
        guard let camera = device(wanted), let input = try? AVCaptureDeviceInput(device: camera) else { return false }
        session.beginConfiguration()
        for existing in session.inputs { session.removeInput(existing) }
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            return false
        }
        session.addInput(input)
        if !configured {
            session.sessionPreset = .hd1280x720
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: frameQueue)
            if session.canAddOutput(output) { session.addOutput(output) }
            configured = true
        }
        // Frames are sent upright, as the phone is held, and never mirrored (writing on a page must read right).
        rotation = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: nil)
        if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
            // Mirroring can only be set by hand once the system is told not to choose it.
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        level()
        session.commitConfiguration()
        lock.lock()
        newest = nil
        newestTaken = true
        lock.unlock()
        if !session.isRunning { session.startRunning() }
        return true
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock()
        newest = buffer
        newestTaken = false
        lock.unlock()
    }
}

private let videoFrameContext = CIContext(options: [.useSoftwareRenderer: false])

/// Makes the JPEG that video.frame carries from a camera frame: scaled to 768
/// pixels on its longer side, small enough for the relay. Nil when it cannot
/// be made to fit; the frame is then skipped. Not for the main thread.
func jpegBase64ForVideoFrame(_ buffer: CVPixelBuffer) -> String? {
    let image = CIImage(cvPixelBuffer: buffer)
    guard let full = videoFrameContext.createCGImage(image, from: image.extent) else { return nil }
    return encodeVideoFrame(width: full.width, height: full.height) { width, height, quality in
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let scaled = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
            UIImage(cgImage: full).draw(in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return scaled.jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}
