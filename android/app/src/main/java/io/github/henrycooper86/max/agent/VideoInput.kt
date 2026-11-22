package io.github.henrycooper86.max.agent

import org.json.JSONObject

/**
 * Live video for the conversation's model (video.frame and video.stop in
 * docs/protocol.md): the same rules as the web SDK's `startVideo`
 * (sdk/src/video.ts). A frame is a picture by the rules of image.input, but
 * smaller and cheaper, and has no count limit.
 */

/** The longer side of a frame, smaller than a picture's: a frame is one of many. */
const val VIDEO_MAX_SIDE = 768

/** JPEG qualities tried in turn for a frame; one that fits at none is skipped, the next is a second away. */
private val VIDEO_QUALITIES = intArrayOf(60, 45)

/** About one frame a second. */
const val VIDEO_INTERVAL_MS = 1_000L

/** The relay drops a frame that comes sooner than this after the last, so none is ever sent sooner. */
const val MIN_VIDEO_INTERVAL_MS = 500L

/** Client → server video.stop: the video is off. */
const val VIDEO_STOP_EVENT = """{"type":"video.stop"}"""

/** The size a camera frame of [width] × [height] is scaled to: its longer side [maxSide], never larger than it is. */
fun videoFrameSize(width: Int, height: Int, maxSide: Int = VIDEO_MAX_SIDE): Pair<Int, Int>? {
    if (width <= 0 || height <= 0) return null
    val longest = maxOf(width, height)
    if (longest <= maxSide) return width to height
    val scale = maxSide.toDouble() / longest
    return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
}

/**
 * Has [encode] make a JPEG of a frame as base64 at quality 60 and then 45,
 * and returns the first that fits the relay's limit. Null when none does or
 * it cannot be encoded: the frame is skipped.
 */
fun encodeVideoFrame(encode: (quality: Int) -> String): String? {
    for (quality in VIDEO_QUALITIES) {
        val data = encode(quality)
        if (data.isNotEmpty() && data.length <= MAX_IMAGE_BASE64_CHARS) return data
    }
    return null
}

/**
 * Client → server video.frame: a JPEG as base64 with no `data:` prefix, and no
 * words. Null for a frame the relay would refuse.
 */
fun buildVideoFrame(jpegBase64: String): String? {
    if (jpegBase64.isEmpty() || jpegBase64.length > MAX_IMAGE_BASE64_CHARS) return null
    return JSONObject()
        .put("type", ClientEventTypes.VIDEO_FRAME)
        .put("image", jpegBase64)
        .put("mimeType", "image/jpeg")
        .toString()
}

/** What [LiveVideo.sendNewest] did. */
enum class VideoStep { OFF, NOT_READY, NO_FRAME, TOO_SOON, SKIPPED, SENT }

/**
 * The live video of one conversation, without a camera: it keeps the newest
 * frame of type [F] it is given, and about once a second encodes that frame
 * and sends it. A frame starts nothing and uses none of the 50 pictures of
 * image.input. Frames are offered from the camera's thread and sent from a
 * worker's, never from the main thread: [encode] is slow. [connected] says the
 * socket is ready, [takesVideo] that the session reported `videoInput`.
 */
class LiveVideo<F : Any>(
    private val connected: () -> Boolean,
    private val takesVideo: () -> Boolean,
    private val send: (String) -> Boolean,
    private val encode: (F) -> String?,
    private val now: () -> Long,
    private val release: (F) -> Unit = {},
    intervalMs: Long = VIDEO_INTERVAL_MS
) {
    private val intervalMs = maxOf(intervalMs, MIN_VIDEO_INTERVAL_MS)
    private val lock = Any()
    private var on = false
    private var newest: F? = null
    private var lastAt: Long? = null

    val active: Boolean get() = synchronized(lock) { on }

    /** Turns the video on. False when the session cannot take it now. */
    fun start(): Boolean = synchronized(lock) {
        if (!connected() || !takesVideo()) return false
        on = true
        lastAt = null
        true
    }

    /** Keeps [frame] as the newest, letting the one it replaces go. A frame offered while off is let go at once. */
    fun offer(frame: F) {
        val dropped: F? = synchronized(lock) {
            if (on) { val old = newest; newest = frame; old } else frame
        }
        dropped?.let(release)
    }

    /**
     * Sends the newest frame when a second has gone since the last one. A frame
     * that cannot be made to fit is skipped, and the next is a second away.
     * Call it often; it sends at most one per interval.
     */
    fun sendNewest(): VideoStep {
        val frame: F
        val at: Long
        synchronized(lock) {
            if (!on) return VideoStep.OFF
            if (!connected() || !takesVideo()) {
                // A frame from before a drop is not what the camera shows now.
                newest?.let(release); newest = null
                return VideoStep.NOT_READY
            }
            at = now()
            if (lastAt?.let { at - it < intervalMs } == true) return VideoStep.TOO_SOON
            frame = newest ?: return VideoStep.NO_FRAME
            newest = null
        }
        val payload = try { encode(frame)?.let(::buildVideoFrame) } finally { release(frame) }
        synchronized(lock) {
            if (!on) return VideoStep.OFF
            // Skipped or sent, the next is an interval away.
            lastAt = at
            if (payload == null) return VideoStep.SKIPPED
            if (!connected() || !takesVideo()) return VideoStep.NOT_READY
            return if (send(payload)) VideoStep.SENT else VideoStep.NOT_READY
        }
    }

    /**
     * Turns the video off, and tells the relay if the socket is open. True
     * when it was on. Called when the user turns it off, the conversation ends
     * and the app goes to the background.
     */
    fun stop(): Boolean {
        val wasOn: Boolean
        val dropped: F?
        synchronized(lock) {
            wasOn = on
            on = false
            dropped = newest
            newest = null
            lastAt = null
        }
        dropped?.let(release)
        if (wasOn && connected()) send(VIDEO_STOP_EVENT)
        return wasOn
    }

    /** A new session.started: a reconnect whose session takes no video turns it off. True when it did. */
    fun sessionStarted(videoInput: Boolean): Boolean = if (videoInput) false else stop()
}
