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

/**
 * Why a device.command cannot run as sent, or null when its arguments are valid (docs/protocol.md,
 * Wearable extensions): `action.invalid` for an action this app carries out whose arguments it cannot
 * read, `action.unknown` for an action it has never heard of. Malformed arguments are never
 * defaulted: `camera.record` without `start` must not stop a recording, and `torch.set` without
 * `on` must not switch the torch off.
 */
fun unsupportedDeviceCommandReason(action: String, args: Map<String, Any?>): String? = when (action) {
    "torch.set" -> if (args["on"] is Boolean) null else "action.invalid"
    "volume.set" -> if (args["direction"] in setOf("up", "down")) null else "action.invalid"
    "music.control" ->
        if (args["control"] in setOf("play", "pause", "next", "previous") && (args["app"] == null || args["app"] is String)) null
        else "action.invalid"
    "call.dial" -> if (listOf("name", "number").any { (args[it] as? String)?.isNotBlank() == true }) null else "action.invalid"
    "sms.compose" ->
        if ((args["name"] as? String)?.isNotBlank() == true && (args["body"] as? String)?.isNotBlank() == true) null
        else "action.invalid"
    "camera.record" -> if (args["start"] is Boolean) null else "action.invalid"
    "camera.photo", "gallery.open" -> null
    "gallery.describe" -> if (args["kind"] == null || args["kind"] in setOf("latest", "photo", "video")) null else "action.invalid"
    // An action this build has never heard of, from a newer relay.
    else -> "action.unknown"
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
