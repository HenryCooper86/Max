import Foundation
import ImageIO
import UIKit

// Pictures for the conversation's model (image.input in docs/protocol.md): the
// same rules as the web SDK's `sendImage` (sdk/src/image.ts), so a photo from
// a phone and one from a browser reach the relay alike.

/// The relay refuses a longer `image`: with it the whole message stays under
/// its 256 KiB limit.
let imageInputMaxBase64Chars = 240_000
/// The longer side a picture is scaled down to before it is sent.
let imageInputDefaultMaxSide = 1024
private let imageInputMinSide = 64
private let imageInputShrink = 0.75
/// JPEG qualities tried in turn at each size before the size itself is lowered.
private let imageInputQualities: [Double] = [0.85, 0.7, 0.55]
/// The relay takes one picture a second and 50 per connection, and refuses the rest.
let imageInputMinInterval: TimeInterval = 1
let imageInputMaxPerConnection = 50

enum ImageInputRejection: Error, Equatable {
    case unsupported, notReady
    /// The bike is known to be moving (see typedInputLockedForSpeed).
    case moving
    case tooFast, tooMany
    /// The picture could not be opened, or does not fit even at its smallest.
    case unreadable
}

/// Scales a picture of `width` × `height` so its longer side is at most
/// `maxSide`, has `encode` make a JPEG of it as base64, and lowers the quality
/// and then the size until it fits the relay's limit. A small picture is not
/// made larger. Nil when it has no pixels, or does not fit even at 64 pixels.
func encodeImageForInput(
    width: Int,
    height: Int,
    maxSide: Int = imageInputDefaultMaxSide,
    encode: (_ width: Int, _ height: Int, _ quality: Double) -> String?
) -> String? {
    guard width > 0, height > 0 else { return nil }
    let longest = max(width, height)
    var side = min(maxSide >= imageInputMinSide ? maxSide : imageInputDefaultMaxSide, longest)
    // The first size is always tried, even a tiny picture's own.
    while true {
        let scale = Double(side) / Double(longest)
        let scaledWidth = max(1, Int((Double(width) * scale).rounded()))
        let scaledHeight = max(1, Int((Double(height) * scale).rounded()))
        for quality in imageInputQualities {
            if let data = encode(scaledWidth, scaledHeight, quality), !data.isEmpty, data.utf8.count <= imageInputMaxBase64Chars {
                return data
            }
        }
        side = Int(Double(side) * imageInputShrink)
        if side < imageInputMinSide { return nil }
    }
}

/// Validates a picture and builds its `image.input` event: a JPEG as base64
/// with no `data:` prefix. With `text` it is a typed turn with the picture
/// attached, answered aloud. Without, the picture joins the conversation
/// silently and the model sees it with the user's next turn.
func prepareImageInput(
    jpegBase64: String,
    text: String? = nil,
    imageInputSupported: Bool,
    ready: Bool,
    speedKmh: Double? = nil
) -> Result<String, ImageInputRejection> {
    guard imageInputSupported else { return .failure(.unsupported) }
    guard ready else { return .failure(.notReady) }
    guard !typedInputLockedForSpeed(speedKmh) else { return .failure(.moving) }
    guard !jpegBase64.isEmpty, jpegBase64.utf8.count <= imageInputMaxBase64Chars else { return .failure(.unreadable) }
    var payload: [String: Any] = ["type": ClientEventTypes.imageInput, "image": jpegBase64, "mimeType": "image/jpeg"]
    // The words go by the rules of text.input: trimmed and cut at its limit.
    let words = clampToTextInputLimit((text ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !words.isEmpty { payload["text"] = words }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return .failure(.unreadable) }
    return .success(json)
}

/// The relay's limits, kept on the phone too, so the user is told at once and
/// in their language why a picture did not go. A connection starts a new count.
struct ImageInputLimiter {
    private var lastAt: TimeInterval?
    private var sent = 0

    func rejection(at now: TimeInterval) -> ImageInputRejection? {
        if sent >= imageInputMaxPerConnection { return .tooMany }
        if let lastAt, now - lastAt < imageInputMinInterval { return .tooFast }
        return nil
    }

    mutating func didSend(at now: TimeInterval) {
        lastAt = now
        sent += 1
    }

    mutating func reset() {
        lastAt = nil
        sent = 0
    }
}

/// The picture button belongs on screen only when it can work: the backend
/// said it takes pictures and typed turns, and the session is up.
func imageInputVisible(capabilities: ProviderCapabilities, connection: ConnectionState) -> Bool {
    capabilities.imageInput && typedInputVisible(capabilities: capabilities, connection: connection)
}

/// Opens a picture the user chose (the bytes of a JPEG, HEIC, PNG…) and makes
/// the JPEG that image.input carries: turned the way the camera held it,
/// scaled down, small enough for the relay. Nil when it cannot be read as a
/// picture or cannot be made to fit. Not for the main thread.
func jpegBase64ForImageInput(_ data: Data) -> String? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
    else { return nil }
    return encodeImageForInput(width: width, height: height) { scaledWidth, scaledHeight, quality in
        // ImageIO reads the photo at the size asked for, never whole, and turns it upright by its EXIF data.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(scaledWidth, scaledHeight)
        ]
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return opaque(scaled).jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}

/// JPEG has no transparency: what is see-through in a screenshot or a sticker is white, not black.
private func opaque(_ image: CGImage) -> UIImage {
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast:
        return UIImage(cgImage: image)
    default:
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: image.width, height: image.height)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
