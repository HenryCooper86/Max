import AVFoundation
import UIKit

/// The single owner of everything the gallery keeps on disk: capture files,
/// their thumbnails, and the JSON index. Injectable `root` and `availableBytes`
/// keep it fully testable without a real device or camera.
protocol CaptureStoring: AnyObject {
    func hasSpace() -> Bool
    func captures() -> [Capture]
    func newVideoURL() -> URL
    func addPhoto(_ data: Data) throws -> Capture
    func indexVideo(at url: URL) throws -> Capture
    func markExported(_ id: String)
    func delete(_ id: String)
    func fileURL(for capture: Capture) -> URL
    func thumbnailURL(for capture: Capture) -> URL
}

final class CaptureStore: CaptureStoring {
    /// Captures below this free-space floor are refused rather than dropping old
    /// ones — the gallery never auto-prunes.
    static let minimumFreeBytes: UInt64 = 500_000_000
    private static let thumbnailMaxDimension: CGFloat = 300

    private let root: URL
    private let availableBytes: () -> UInt64
    private let indexURL: URL
    private var index: [Capture]
    private let queue = DispatchQueue(label: "capture-store")

    /// - Parameter availableBytes: free capacity probe, injected so tests can
    ///   simulate a full disk. Production passes the real volume capacity.
    init(root: URL, availableBytes: @escaping () -> UInt64) {
        self.root = root
        self.availableBytes = availableBytes
        self.indexURL = root.appendingPathComponent("captures.json")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Capture].self, from: data) {
            index = decoded
        } else {
            index = []
        }
    }

    /// Production initializer: probes the real volume capacity for the Captures
    /// folder.
    convenience init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let captures = support.appendingPathComponent("Captures", isDirectory: true)
        self.init(root: captures, availableBytes: {
            let values = try? captures.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return UInt64(values?.volumeAvailableCapacityForImportantUsage ?? 0)
        })
    }

    func hasSpace() -> Bool {
        availableBytes() >= Self.minimumFreeBytes
    }

    func captures() -> [Capture] {
        queue.sync { index.sorted { $0.createdAt > $1.createdAt } }
    }

    func newVideoURL() -> URL {
        root.appendingPathComponent("\(UUID().uuidString).mov")
    }

    func addPhoto(_ data: Data) throws -> Capture {
        let id = UUID().uuidString
        let filename = "\(id).heic"
        let thumbnailName = "\(id)-thumb.jpg"
        try data.write(to: root.appendingPathComponent(filename))
        try writePhotoThumbnail(from: data, to: root.appendingPathComponent(thumbnailName))
        let capture = Capture(
            id: id, type: .photo, filename: filename,
            createdAt: Date().timeIntervalSince1970, durationSec: nil,
            exported: false, thumbnailName: thumbnailName
        )
        appendToIndex(capture)
        return capture
    }

    func indexVideo(at url: URL) throws -> Capture {
        let id = UUID().uuidString
        let thumbnailName = "\(id)-thumb.jpg"
        let asset = AVURLAsset(url: url)
        let duration = CMTimeGetSeconds(asset.duration)
        try writeVideoThumbnail(from: asset, to: root.appendingPathComponent(thumbnailName))
        let capture = Capture(
            id: id, type: .video, filename: url.lastPathComponent,
            createdAt: Date().timeIntervalSince1970, durationSec: duration,
            exported: false, thumbnailName: thumbnailName
        )
        appendToIndex(capture)
        return capture
    }

    func markExported(_ id: String) {
        queue.sync {
            guard let i = index.firstIndex(where: { $0.id == id }) else { return }
            index[i].exported = true
            persist()
        }
    }

    func delete(_ id: String) {
        queue.sync {
            guard let i = index.firstIndex(where: { $0.id == id }) else { return }
            let capture = index[i]
            try? FileManager.default.removeItem(at: root.appendingPathComponent(capture.filename))
            try? FileManager.default.removeItem(at: root.appendingPathComponent(capture.thumbnailName))
            index.remove(at: i)
            persist()
        }
    }

    func fileURL(for capture: Capture) -> URL { root.appendingPathComponent(capture.filename) }
    func thumbnailURL(for capture: Capture) -> URL { root.appendingPathComponent(capture.thumbnailName) }

    // MARK: - Private

    private func appendToIndex(_ capture: Capture) {
        queue.sync {
            index.append(capture)
            persist()
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    private func writePhotoThumbnail(from data: Data, to url: URL) throws {
        guard let image = UIImage(data: data),
              let thumb = image.downscaled(to: Self.thumbnailMaxDimension),
              let jpeg = thumb.jpegData(compressionQuality: 0.7) else {
            throw CaptureStoreError.thumbnailFailed
        }
        try jpeg.write(to: url)
    }

    private func writeVideoThumbnail(from asset: AVAsset, to url: URL) throws {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let cg = try generator.copyCGImage(at: .zero, actualTime: nil)
        guard let thumb = UIImage(cgImage: cg).downscaled(to: Self.thumbnailMaxDimension),
              let jpeg = thumb.jpegData(compressionQuality: 0.7) else {
            throw CaptureStoreError.thumbnailFailed
        }
        try jpeg.write(to: url)
    }
}

enum CaptureStoreError: Error {
    case thumbnailFailed
}

private extension UIImage {
    /// Aspect-fit downscale so the longest side is `maxDimension`.
    func downscaled(to maxDimension: CGFloat) -> UIImage? {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
