import Foundation

// Live video for the conversation's model (video.frame and video.stop in
// docs/protocol.md): the same rules as the web SDK's `startVideo`
// (sdk/src/video.ts). A frame is a picture by the rules of image.input, but
// smaller and cheaper, and it does not use up the picture budget.

/// The longer side a frame is scaled down to.
let videoInputMaxSide = 768
/// Lower than a picture's: a frame is one of many, and the next is a second away.
let videoInputQualities: [Double] = [0.6, 0.45]
/// A frame about every second while the video is on.
let videoInputInterval: TimeInterval = 1
/// The relay drops a frame that comes sooner than this after the last one.
let videoInputMinInterval: TimeInterval = 0.5

enum VideoInputRejection: Error, Equatable {
    case unsupported, notReady
    /// The video is off, or not on yet.
    case inactive
    /// Less than 500 ms after the last frame: dropped here, as the relay would.
    case tooFast
    /// The frame does not fit even at the lowest quality.
    case unreadable
}

/// What came of asking to turn the camera on, said to the user in their language.
enum VideoStartResult: Equatable {
    case started
    case denied
    /// No camera: the simulator, or a device without one.
    case unavailable
    case notReady
    /// A recording is using the camera.
    case busy
}

/// Has `encode` make a JPEG of a frame of `width` × `height` as base64: the
/// longer side at most 768, quality 0.6 and then 0.45. Nil when it has no
/// pixels or still does not fit; that frame is skipped.
func encodeVideoFrame(
    width: Int,
    height: Int,
    encode: (_ width: Int, _ height: Int, _ quality: Double) -> String?
) -> String? {
    encodeImageForInput(width: width, height: height, maxSide: videoInputMaxSide, qualities: videoInputQualities, shrinks: false, encode: encode)
}

/// The `video.frame` event for a JPEG as base64 with no `data:` prefix.
func prepareVideoFrame(jpegBase64: String) -> String? {
    guard !jpegBase64.isEmpty, jpegBase64.utf8.count <= imageInputMaxBase64Chars else { return nil }
    let payload: [String: Any] = ["type": ClientEventTypes.videoFrame, "image": jpegBase64, "mimeType": "image/jpeg"]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
    return String(data: data, encoding: .utf8)
}

let videoStopEvent = #"{"type":"video.stop"}"#

/// What the live video is doing, with no camera in it: whether it is on, the
/// pacing, and when it must stop. Frames never touch ImageInputLimiter.
struct LiveVideoState {
    private(set) var active = false
    private var lastAt: TimeInterval?

    /// Turns the video on when the session takes it and is up.
    mutating func begin(supported: Bool, ready: Bool) -> Bool {
        guard supported, ready else { return false }
        active = true
        lastAt = nil
        return true
    }

    /// The `video.frame` event to send now, or why none.
    mutating func frameEvent(jpegBase64: String, supported: Bool, ready: Bool, now: TimeInterval) -> Result<String, VideoInputRejection> {
        guard active else { return .failure(.inactive) }
        guard supported else { return .failure(.unsupported) }
        guard ready else { return .failure(.notReady) }
        if let lastAt, now - lastAt < videoInputMinInterval { return .failure(.tooFast) }
        guard let json = prepareVideoFrame(jpegBase64: jpegBase64) else { return .failure(.unreadable) }
        lastAt = now
        return .success(json)
    }

    /// Turns the video off. True when `video.stop` is to be sent: it was on and the socket is ready.
    mutating func end(ready: Bool) -> Bool {
        let wasActive = active
        active = false
        lastAt = nil
        return wasActive && ready
    }

    /// A new `session.started`. A session that does not take video ends the
    /// video (True: send `video.stop`); one that does starts the pacing afresh.
    mutating func sessionStarted(videoInput: Bool) -> Bool {
        guard active else { return false }
        if videoInput {
            lastAt = nil
            return false
        }
        return end(ready: true)
    }
}

/// The camera button belongs on screen only when it can work: the session
/// said it takes video, and typed turns are on (as for pictures).
func liveVideoVisible(capabilities: ProviderCapabilities, connection: ConnectionState) -> Bool {
    capabilities.videoInput && typedInputVisible(capabilities: capabilities, connection: connection)
}

func videoNoteText(_ result: VideoStartResult) -> String? {
    switch result {
    case .started: return nil
    case .denied: return L("video.denied")
    case .unavailable: return L("video.unavailable")
    case .notReady: return L("video.notReady")
    case .busy: return L("video.busy")
    }
}
