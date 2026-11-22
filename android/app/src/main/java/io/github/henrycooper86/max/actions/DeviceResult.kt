package io.github.henrycooper86.max.actions

import io.github.henrycooper86.max.agent.buildDeviceResult
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr

data class DeviceResult(val status: String, val reason: String? = null, val detail: String? = null) {
    fun json(commandId: String) = buildDeviceResult(commandId, status, reason, detail)
    companion object {
        val OK = DeviceResult("ok")
        fun failed(reason: String, detail: String? = null) = DeviceResult("failed", reason, detail)
        fun denied(reason: String) = DeviceResult("denied", reason)
        fun unsupported(reason: String) = DeviceResult("unsupported", reason)
    }
}

/** Reject malformed commands before touching hardware or opening another app. */
fun validDeviceArguments(action: String, args: Map<String, Any?>): Boolean = when (action) {
    "torch.set" -> args["on"] is Boolean
    "volume.set" -> args["direction"] in setOf("up", "down")
    "music.control" -> args["control"] in setOf("play", "pause", "next", "previous") &&
        (args["app"] == null || args["app"] is String)
    "call.dial" -> listOf("name", "number").any { (args[it] as? String)?.isNotBlank() == true }
    "sms.compose" -> (args["name"] as? String)?.isNotBlank() == true && (args["body"] as? String)?.isNotBlank() == true
    "camera.record" -> args["start"] is Boolean
    "camera.photo", "gallery.open" -> true
    "gallery.describe" -> args["kind"] == null || args["kind"] in setOf("latest", "photo", "video")
    else -> false
}

/**
 * SMS composition fails closed: refused unless speed is known to be below
 * walking pace. With no GPS fix (indoors, tunnels) and no mock-relay speed
 * that also refuses, so the refusal says the speed is unknown rather than
 * claiming the rider is riding; dialling is unaffected.
 */
fun smsSpeedRefusal(speedKmh: Double?): DeviceResult? = when {
    safeToComposeMessage(speedKmh) -> null
    speedKmh == null -> DeviceResult("denied", "unsafe.speed", tr(Str.SMS_SPEED_UNKNOWN))
    else -> DeviceResult.denied("unsafe.speed")
}

/** Walking pace: at or above it the rider counts as riding (the same limit as iOS). */
const val WALKING_PACE_KMH = 5.0

fun safeToComposeMessage(speedKmh: Double?): Boolean =
    speedKmh != null && speedKmh.isFinite() && speedKmh >= 0.0 && speedKmh < WALKING_PACE_KMH

fun nextVoiceGain(current: Float, direction: String): Float =
    (current + if (direction == "up") 0.5f else -0.5f).coerceIn(0.5f, 4f)
