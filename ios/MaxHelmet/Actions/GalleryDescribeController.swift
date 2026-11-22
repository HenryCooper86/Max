import Foundation

/// The gallery.describe device-action handler. Resolves the requested capture,
/// extracts one (photo) or eight (video) downscaled JPEG frames, and streams
/// each as its own vision.frames chunk over the injected `send` closure before
/// returning `.ok` — the relay reassembles the chunks by commandId, so every
/// chunk must land on the wire before the router's caller sends the single
/// device.result. `send` is synchronous-looking but fires-and-forgets onto the
/// WebSocket; callers (AgentSession) mirror the CrashController pattern of
/// `{ [weak self] json in self?.webSocket?.send(.string(json)) { _ in } }`.
///
/// Extraction runs on whatever thread `perform` is called from.
/// `FrameExtraction.videoFramesBase64` blocks synchronously through up to eight
/// seek+decodes; AgentSession's device.command dispatch already runs handlers
/// inside a detached `Task { }` off the main actor, so this type never hops
/// threads itself — doing so here would be redundant and risks reintroducing a
/// main-actor stall.
final class GalleryDescribeController: IdentifiedDeviceActionHandler {
    private let store: CaptureStoring
    private let send: (String) -> Void
    private let extractPhoto: (Data) -> String?
    private let extractVideo: (URL) -> [String]?
    /// Read on whatever thread `perform` runs on, so it must be thread-safe
    /// (AgentSession passes ThermalGovernor's locked snapshot).
    private let capturePolicy: () -> CapturePolicy

    init(
        store: CaptureStoring,
        send: @escaping (String) -> Void,
        extractPhoto: @escaping (Data) -> String? = FrameExtraction.photoBase64,
        extractVideo: @escaping (URL) -> [String]? = { FrameExtraction.videoFramesBase64(from: $0) },
        capturePolicy: @escaping () -> CapturePolicy = { .unrestricted }
    ) {
        self.store = store
        self.send = send
        self.extractPhoto = extractPhoto
        self.extractVideo = extractVideo
        self.capturePolicy = capturePolicy
    }

    /// gallery.describe is the only route registered with an
    /// IdentifiedDeviceActionHandler — the router always calls
    /// `perform(_:commandId:)` for it. This path only exists to satisfy the
    /// base `DeviceActionHandler` conformance.
    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        .unsupported("handler.missing")
    }

    func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult {
        guard case let .galleryDescribe(kind, question) = action else {
            return .unsupported("handler.missing")
        }
        guard let target = resolveTarget(kind: kind) else {
            return .failed("gallery.empty")
        }
        // Decoding frames is the expensive part, so a hot phone refuses before it.
        if let refusal = capturePolicy().visionFrames { return refusal.result }

        let frames: [String]
        switch target.type {
        case .photo:
            guard let data = try? Data(contentsOf: store.fileURL(for: target)),
                  let encoded = extractPhoto(data), !encoded.isEmpty else {
                return .failed("gallery.unreadable")
            }
            frames = [encoded]
        case .video:
            guard let extracted = extractVideo(store.fileURL(for: target)), !extracted.isEmpty else {
                return .failed("gallery.unreadable")
            }
            frames = extracted
        }

        let total = frames.count
        for (index, image) in frames.enumerated() {
            guard !Task.isCancelled else { return .failed("capture.cancelled") }
            send(buildVisionFrame(commandId: commandId, index: index, total: total, image: image, question: question))
        }
        return .ok
    }

    private func resolveTarget(kind: String) -> Capture? {
        let captures = store.captures()
        switch kind {
        case "photo": return captures.first { $0.type == .photo }
        case "video": return captures.first { $0.type == .video }
        default: return captures.first
        }
    }
}
