package com.horizon.maxhelmet.crash

import com.horizon.maxhelmet.ui.tr
import com.horizon.maxhelmet.ui.Str

import org.json.JSONObject
import java.util.UUID

data class CrashSettings(val contact: String = "", val optIn: Boolean = false, val callContact: Boolean = false, val logOnly: Boolean = false)
data class CrashUi(val phase: CrashPhase = CrashPhase.ARMED, val remaining: Int = 0, val message: String? = null, val coordinate: String? = null)

/** All methods are confined to the main thread by the runtime. Async location uses incident ownership. */
class CrashController(private val now: () -> Double, private val wall: () -> Long,
    private val settings: () -> CrashSettings, private val locate: ((Pair<Double, Double>?) -> Unit) -> Unit,
    private val speak: (String) -> Unit, private val siren: (Boolean) -> Unit, private val send: (String) -> Unit,
    private val publish: (CrashUi) -> Unit, private val resolved: () -> Unit,
    private val tuning: CrashTuning = CrashTuning()) {
    @Volatile var state = CrashState(); private set
    var armed = false; private set
    var pending: String? = null; private set
    var incidentId: String? = null; private set
    private var sentAt: Double? = null
    private var acked = false
    private var message: String? = null
    private var coordinate: String? = null
    private var networkAllowed = true
    private var simulation = false
    val active get() = state.active
    fun arm() { armed = true; if (!active) networkAllowed = true }
    fun sessionEnded() { if (!active) { armed = false; state = CrashState(); render() } }
    fun detachAccount() { networkAllowed = false; pending = null; sentAt = null; if (active) { message = tr(Str.CRASH_SIGNED_OUT); render() } }
    fun sample(value: CrashSample) { if (armed) apply(CrashEngine.step(state, value, tuning)) }
    fun tick() {
        if (!armed) return
        apply(CrashEngine.tick(state, now(), tuning))
        if (!acked && sentAt?.let { now() - it >= 10 } == true) message = tr(Str.CRASH_UNCONFIRMED)
        render()
    }
    // A developer drill exercises the UI/siren but can never notify a real contact.
    fun simulate() { if (armed && state.phase == CrashPhase.ARMED) { simulation = true; apply(CrashEngine.simulate(state, now())) } }
    fun cancel() { apply(CrashEngine.cancel(state)) }
    fun transcript(text: String) { if (text.contains("没事") || text.contains("取消")) cancel() }
    fun ready() { if (networkAllowed) pending?.let(send) }
    fun ack(id: String, status: String, detail: String?) {
        if (id != incidentId || state.phase != CrashPhase.ESCALATED || status !in setOf("notified", "failed", "unconfigured")) return
        acked = true; pending = null; sentAt = null
        message = when (status) {
            "notified" -> tr(Str.CRASH_NOTIFIED)
            "unconfigured" -> tr(Str.CRASH_NO_CHANNEL)
            else -> tr(Str.CRASH_NOTIFY_FAILED)
        } + (detail?.take(200)?.let { "（$it）" } ?: "")
        speak(message!!); render()
    }
    private fun apply(update: CrashUpdate) {
        val wasActive = active
        state = update.state
        for (effect in update.effects) {
            if (settings().logOnly && !simulation && effect == CrashEffect.CHECK_IN) { state = CrashState(); continue }
            when (effect) {
                CrashEffect.CHECK_IN -> { message = if (simulation) tr(Str.CRASH_DRILL_NOTE) else null; speak("检测到疑似摔车。你还好吗？没事请回答我没事，或点一下屏幕。") }
                CrashEffect.ALARM -> siren(true)
                CrashEffect.ESCALATE -> escalate()
                CrashEffect.DISMISS -> { siren(false); pending = null; sentAt = null; message = null; coordinate = null }
                CrashEffect.CANCEL -> { if (networkAllowed && !simulation) incidentId?.let { send(JSONObject().put("type", "crash.cancel").put("incidentId", it).toString()) } }
                CrashEffect.NEAR_MISS -> Unit
            }
        }
        render()
        if (wasActive && !active) { incidentId = null; simulation = false; resolved() }
    }
    private fun escalate() {
        val id = UUID.randomUUID().toString(); incidentId = id; acked = false
        if (simulation || !networkAllowed) { message = if (simulation) tr(Str.CRASH_DRILL_OVER) else tr(Str.CRASH_CALL_MANUALLY); return }
        val config = settings(); val speed = state.peakSpeed
        locate { point ->
            if (incidentId != id || state.phase != CrashPhase.ESCALATED || !networkAllowed) return@locate
            val json = JSONObject().put("type", "crash.alert").put("incidentId", id)
                .put("contactOptIn", config.optIn).put("detectedAt", wall())
            point?.takeIf { it.first.isFinite() && it.second.isFinite() && it.first in -90.0..90.0 && it.second in -180.0..180.0 }?.let {
                json.put("lat", it.first).put("lon", it.second); coordinate = "%.5f, %.5f".format(it.first, it.second)
            }
            speed?.let { json.put("speedKmhRecent", it) }
            if (config.optIn && validContact(config.contact)) json.put("contactNumber", config.contact.trim())
            pending = json.toString(); sentAt = now(); send(pending!!); render()
        }
    }
    private fun render() {
        val duration = when (state.phase) { CrashPhase.CHECK_IN -> tuning.checkInS; CrashPhase.ALARM -> tuning.alarmS; else -> 0.0 }
        publish(CrashUi(state.phase, kotlin.math.ceil((duration - (now() - state.since)).coerceAtLeast(0.0)).toInt(), message, coordinate))
    }
    companion object { fun validContact(value: String) = Regex("^\\+?[0-9]{5,20}$").matches(value.trim()) }
}
