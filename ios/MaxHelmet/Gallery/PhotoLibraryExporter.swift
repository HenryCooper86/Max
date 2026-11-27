import Photos

/// Copies a capture into the system Photos library. Behind a protocol so the
/// gallery model is testable without touching the real library. `Sendable`
/// because GalleryModel keeps the exporter it was handed in a nonisolated init
/// and awaits `add` from the main actor.
protocol PhotoLibraryAdding: Sendable {
    func add(fileURL: URL, isVideo: Bool) async -> Bool
}

/// Real exporter using add-only authorization — Max never reads the rider's
/// existing library.
struct SystemPhotoLibraryExporter: PhotoLibraryAdding {
    func add(fileURL: URL, isVideo: Bool) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let type: PHAssetResourceType = isVideo ? .video : .photo
                request.addResource(with: type, fileURL: fileURL, options: nil)
            }
            return true
        } catch {
            return false
        }
    }
}
