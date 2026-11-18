package io.github.henrycooper86.max.companion

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject

data class CompanionState(val status: String = "signedOut", val device: String? = null, val detail: String? = null,
    val riding: Boolean = false, val fixes: Long = 0)
data class CompanionFix(val lat: Double, val lon: Double, val accuracy: Double, val timestamp: Long,
    val course: Double? = null, val speed: Double? = null)
object CompanionProtocol {
    fun endpoint(relay: String, accountToken: String): String? {
        if (accountToken.isBlank()) return null
        val normalized = relay.replaceFirst(Regex("^ws:"), "http:").replaceFirst(Regex("^wss:"), "https:")
        val url = normalized.toHttpUrlOrNull() ?: return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        return url.newBuilder().encodedPath("/companion").query(null).fragment(null).addQueryParameter("token", accountToken).build().toString()
    }
    fun pair(code: String): String? = code.trim().takeIf { it.isNotEmpty() && it.toByteArray().size <= 120 }
        ?.let { JSONObject().put("type", "companion.pair").put("code", it).toString() }
    fun discover(token: String): String? = token.takeIf { Regex("[0-9a-f]{32}").matches(it) }
        ?.let { JSONObject().put("type", "companion.pairDiscover").put("token", it).toString() }
    fun action(action: String) = JSONObject().put("type", "companion.$action").toString()
    fun parse(text: String): CompanionState? = runCatching {
        val j = JSONObject(text)
        fun bounded(key: String, required: Boolean = false): Boolean = if (!j.has(key)) !required else
            (j.opt(key) as? String)?.let { (!required || it.isNotEmpty()) && it.toByteArray().size <= 4096 } == true
        when (j.optString("type")) {
            "companion.status" -> {
                if (j.keys().asSequence().any { it !in setOf("type", "state", "deviceId", "deviceLabel", "detail") } ||
                    !bounded("state", true) || !bounded("deviceId") || !bounded("deviceLabel") || !bounded("detail") ||
                    j.getString("state") !in setOf("unpaired", "paired", "helmetOffline", "ready", "sharing")) null
                else CompanionState(j.getString("state"), j.optString("deviceLabel").ifEmpty { j.optString("deviceId").ifEmpty { null } })
            }
            "companion.error" -> if (j.keys().asSequence().any { it !in setOf("type", "code", "detail") } || !bounded("code", true) || !bounded("detail", true)) null
                else CompanionState("error", j.getString("code"), j.getString("detail"))
            else -> null
        }
    }.getOrNull()
    fun location(fix: CompanionFix, sequence: Long): String? {
        if (sequence <= 0 || sequence > 9_007_199_254_740_991L || !fix.lat.isFinite() || !fix.lon.isFinite() ||
            fix.lat !in -90.0..90.0 || fix.lon !in -180.0..180.0 || !fix.accuracy.isFinite() || fix.accuracy < 0 || fix.timestamp < 0 ||
            fix.course?.let { !it.isFinite() || it !in 0.0..360.0 } == true || fix.speed?.let { !it.isFinite() || it < 0 } == true) return null
        return JSONObject().put("type", "companion.location").put("sequence", sequence).put("lat", fix.lat).put("lon", fix.lon)
            .put("horizontalAccuracyMeters", fix.accuracy).put("timestamp", fix.timestamp)
            .apply { fix.course?.let { put("courseDegrees", it) }; fix.speed?.let { put("speedMps", it) } }.toString()
    }
}

/** Fresh, monotonic, at most one fix/second. Reset on each explicit ride, never on reconnect. */
class CompanionFixGate {
    private var last = Long.MIN_VALUE
    private var sequence = 0L
    fun next(fix: CompanionFix, monotonicMs: Long, wallMs: Long): String? {
        if (wallMs - fix.timestamp !in -5_000L..15_000L || (last != Long.MIN_VALUE && monotonicMs - last < 1000)) return null
        val text = CompanionProtocol.location(fix, sequence + 1) ?: return null
        sequence++; last = monotonicMs
        return text
    }
}
