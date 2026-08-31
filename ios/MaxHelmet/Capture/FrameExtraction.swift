import AVFoundation
import UIKit

/// Fail-honest photo and video key-frame extraction for gallery vision uploads:
/// downscaled JPEG base64, stepping quality down until under the payload cap.
/// Any single failure yields nil for the whole call — never a partial set.
enum FrameExtraction {
    static let maxDimension: CGFloat = 640
    static let maxBase64Chars = 200_000
    static let videoFrameCount = 8

    private static let qualitySteps: [CGFloat] = [0.7, 0.5, 0.3]

    /// Downscaled JPEG base64 of a photo, stepping quality down (0.7 → 0.5 → 0.3)
    /// until under maxBase64Chars. nil on any failure — fail-honest, never partial.
    static func photoBase64(from data: Data) -> String? {
        guard let image = UIImage(data: data) else { return nil }
        return base64(for: image)
    }

    /// `count` evenly-spaced frames (at (i + 0.5)/count of the duration, so no
    /// duplicate first/last frames), each a downscaled JPEG base64 under the cap.
    /// nil if the asset is unreadable, has no finite positive duration, or ANY
    /// frame fails — fail-honest, never partial.
    static func videoFramesBase64(from url: URL, count: Int = videoFrameCount) -> [String]? {
        guard count > 0 else { return nil }

        let asset = AVURLAsset(url: url)
        let durationSeconds = CMTimeGetSeconds(asset.duration)
        guard durationSeconds.isFinite, durationSeconds > 0 else { return nil }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero

        var frames: [String] = []
        frames.reserveCapacity(count)
        for i in 0..<count {
            let fraction = (Double(i) + 0.5) / Double(count)
            let time = CMTime(seconds: durationSeconds * fraction, preferredTimescale: 600)
            guard let cgImage = try? generator.copyCGImage(at: time, actualTime: nil),
                  let encoded = base64(for: UIImage(cgImage: cgImage)) else {
                return nil
            }
            frames.append(encoded)
        }
        return frames
    }

    /// Downscales to `maxDimension`, then steps JPEG quality down through
    /// `qualitySteps` until the base64 payload is under `maxBase64Chars`. nil if
    /// downscaling fails or every quality step is still over the cap.
    private static func base64(for image: UIImage) -> String? {
        guard let downscaled = image.downscaled(to: maxDimension) else { return nil }
        for quality in qualitySteps {
            guard let jpeg = downscaled.jpegData(compressionQuality: quality) else { continue }
            let encoded = jpeg.base64EncodedString()
            if encoded.count <= maxBase64Chars {
                return encoded
            }
        }
        return nil
    }
}
