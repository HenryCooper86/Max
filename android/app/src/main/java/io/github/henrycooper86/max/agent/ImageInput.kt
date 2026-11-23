package io.github.henrycooper86.max.agent

import org.json.JSONObject

/**
 * Pictures for the conversation's model (image.input in docs/protocol.md): the
 * same rules as the web SDK's `sendImage` (sdk/src/image.ts), so a photo from
 * a phone and one from a browser reach the relay alike.
 */

/** The relay refuses a longer `image`: with it the whole message stays under its 256 KiB limit. */
const val MAX_IMAGE_BASE64_CHARS = 240_000

/** The longer side a picture is scaled down to before it is sent. */
const val DEFAULT_IMAGE_MAX_SIDE = 1024
private const val MIN_IMAGE_SIDE = 64
private const val IMAGE_SHRINK = 0.75

/** JPEG qualities tried in turn at each size before the size itself is lowered. */
private val IMAGE_QUALITIES = intArrayOf(85, 70, 55)

/** The relay takes one picture a second and 50 per connection, and refuses the rest. */
const val MIN_IMAGE_INTERVAL_MS = 1_000L
const val MAX_IMAGES_PER_CONNECTION = 50

/**
 * Scales a picture of [width] × [height] so its longer side is at most
 * [maxSide], has [encode] make a JPEG of it as base64, and lowers the quality
 * and then the size until it fits the relay's limit. A small picture is not
 * made larger. Null when it has no pixels, or does not fit even at 64 pixels.
 */
fun encodeImageForInput(
    width: Int,
    height: Int,
    maxSide: Int = DEFAULT_IMAGE_MAX_SIDE,
    encode: (width: Int, height: Int, quality: Int) -> String
): String? {
    val longest = maxOf(width, height)
    if (width <= 0 || height <= 0) return null
    var side = minOf(if (maxSide >= MIN_IMAGE_SIDE) maxSide else DEFAULT_IMAGE_MAX_SIDE, longest)
    // The first size is always tried, even a tiny picture's own.
    while (true) {
        val scale = side.toDouble() / longest
        val scaledWidth = maxOf(1, Math.round(width * scale).toInt())
        val scaledHeight = maxOf(1, Math.round(height * scale).toInt())
        for (quality in IMAGE_QUALITIES) {
            val data = encode(scaledWidth, scaledHeight, quality)
            if (data.isNotEmpty() && data.length <= MAX_IMAGE_BASE64_CHARS) return data
        }
        side = (side * IMAGE_SHRINK).toInt()
        if (side < MIN_IMAGE_SIDE) return null
    }
}

/**
 * Client → server image.input: a JPEG as base64 with no `data:` prefix. With
 * [text] it is a typed turn with the picture attached, answered aloud. Without,
 * the picture joins the conversation silently and the model sees it with the
 * user's next turn. Null for a picture the relay would refuse.
 */
fun buildImageInput(jpegBase64: String, text: String? = null): String? {
    if (jpegBase64.isEmpty() || jpegBase64.length > MAX_IMAGE_BASE64_CHARS) return null
    val event = JSONObject()
        .put("type", ClientEventTypes.IMAGE_INPUT)
        .put("image", jpegBase64)
        .put("mimeType", "image/jpeg")
    // The words go by the rules of text.input: trimmed and cut at its limit.
    val words = text?.let(::buildTextInput)?.let { JSONObject(it).getString("text") }
    if (words != null) event.put("text", words)
    return event.toString()
}

/** Why a picture was not sent. */
enum class ImageRefusal { NOT_READY, TOO_FAST, TOO_MANY, TOO_LARGE }

/**
 * The relay's limits, kept on the phone too, so the user is told at once and
 * in their language why a picture did not go. A connection starts a new count.
 */
class ImageInputLimiter {
    private var lastAt: Long? = null
    private var sent = 0

    fun refusal(now: Long): ImageRefusal? = when {
        sent >= MAX_IMAGES_PER_CONNECTION -> ImageRefusal.TOO_MANY
        lastAt?.let { now - it < MIN_IMAGE_INTERVAL_MS } == true -> ImageRefusal.TOO_FAST
        else -> null
    }

    fun sent(now: Long) {
        lastAt = now
        sent += 1
    }

    fun reset() {
        lastAt = null
        sent = 0
    }
}

/**
 * Whether the conversation offers to show a picture: the backend takes them,
 * and a typed turn could be sent now (connected, and not while riding).
 */
fun imageInputReady(state: AgentSession.State): Boolean =
    state.capabilities.imageInput && typedInputMode(state) == TypedInputMode.READY
