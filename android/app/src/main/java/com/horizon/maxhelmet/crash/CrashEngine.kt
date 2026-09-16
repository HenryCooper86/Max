package com.horizon.maxhelmet.crash

/** Same thresholds and transitions as the iOS engine; samples use monotonic seconds. */
data class CrashTuning(val impactG: Double = 4.5, val impactS: Double = .02,
    val tumbleRadS: Double = 6.0, val tumbleS: Double = .1, val speedGate: Double = 10.0,
    val confirmS: Double = 5.0, val confirmDelayS: Double = .5, val stillSpeed: Double = 2.0,
    val stillVariance: Double = .05, val stillWindowS: Double = 1.0,
    val checkInS: Double = 15.0, val alarmS: Double = 30.0, val contextS: Double = 5.0)
data class CrashSample(val t: Double, val accelG: Double, val rotation: Double, val speed: Double? = null)
enum class CrashPhase { ARMED, CANDIDATE, CHECK_IN, ALARM, ESCALATED }
enum class CrashEffect { CHECK_IN, ALARM, ESCALATE, DISMISS, NEAR_MISS, CANCEL }
data class CrashState(val phase: CrashPhase = CrashPhase.ARMED, val since: Double = 0.0,
    val recent: List<CrashSample> = emptyList(), val impactStart: Double? = null,
    val tumbleStart: Double? = null, val peakSpeed: Double? = null) {
    val active: Boolean get() = phase in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)
}
data class CrashUpdate(val state: CrashState, val effects: List<CrashEffect> = emptyList())
object CrashEngine {
    fun step(s: CrashState, sample: CrashSample, t: CrashTuning = CrashTuning()): CrashUpdate {
        if (!sample.t.isFinite() || !sample.accelG.isFinite() || !sample.rotation.isFinite() ||
            sample.accelG < 0 || sample.rotation < 0 || (s.recent.lastOrNull()?.t ?: sample.t) > sample.t) return CrashUpdate(s)
        val x = sample.copy(speed = sample.speed?.takeIf { it.isFinite() && it >= 0 })
        var n = s.copy(recent = (s.recent + x).filter { it.t >= x.t - t.contextS }.takeLast(1200))
        when (s.phase) {
            CrashPhase.ARMED -> {
                n = n.copy(impactStart = if (x.accelG >= t.impactG) s.impactStart ?: x.t else null,
                    tumbleStart = if (x.rotation >= t.tumbleRadS) s.tumbleStart ?: x.t else null)
                val impact = n.impactStart?.let { x.t - it >= t.impactS } == true
                val tumble = n.tumbleStart?.let { x.t - it >= t.tumbleS } == true
                val speed = n.recent.mapNotNull { it.speed }.maxOrNull()
                if (((speed ?: 0.0) >= t.speedGate && (impact || tumble)) || (impact && tumble))
                    n = n.copy(phase = CrashPhase.CANDIDATE, since = x.t, impactStart = null, tumbleStart = null, peakSpeed = speed)
            }
            CrashPhase.CANDIDATE -> {
                val window = n.recent.filter { it.t >= x.t - t.stillWindowS }
                val mean = window.map { it.accelG }.average()
                val still = window.size >= 10 && window.none { (it.speed ?: 0.0) >= t.stillSpeed } &&
                    window.map { (it.accelG - mean) * (it.accelG - mean) }.average() < t.stillVariance
                if (x.t - s.since >= t.confirmDelayS && (x.accelG >= t.impactG || x.rotation >= t.tumbleRadS || still))
                    return CrashUpdate(n.copy(phase = CrashPhase.CHECK_IN, since = x.t), listOf(CrashEffect.CHECK_IN))
                if (x.t - s.since >= t.confirmS) n = n.copy(phase = CrashPhase.ARMED)
            }
            else -> Unit
        }
        return CrashUpdate(n)
    }
    fun tick(s: CrashState, now: Double, t: CrashTuning = CrashTuning()): CrashUpdate = when {
        s.phase == CrashPhase.CANDIDATE && now - s.since >= t.confirmS -> CrashUpdate(s.copy(phase = CrashPhase.ARMED))
        s.phase == CrashPhase.CHECK_IN && now - s.since >= t.checkInS -> CrashUpdate(s.copy(phase = CrashPhase.ALARM, since = now), listOf(CrashEffect.ALARM))
        s.phase == CrashPhase.ALARM && now - s.since >= t.alarmS -> CrashUpdate(s.copy(phase = CrashPhase.ESCALATED, since = now), listOf(CrashEffect.ESCALATE))
        else -> CrashUpdate(s)
    }
    fun cancel(s: CrashState): CrashUpdate = if (!s.active) CrashUpdate(s) else CrashUpdate(CrashState(),
        listOf(CrashEffect.DISMISS, if (s.phase == CrashPhase.ESCALATED) CrashEffect.CANCEL else CrashEffect.NEAR_MISS))
    fun simulate(s: CrashState, now: Double): CrashUpdate = if (s.phase != CrashPhase.ARMED) CrashUpdate(s)
        else CrashUpdate(CrashState(phase = CrashPhase.CHECK_IN, since = now), listOf(CrashEffect.CHECK_IN))
}
