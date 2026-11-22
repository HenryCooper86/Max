package io.github.henrycooper86.max.crash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * SYNTHETIC scenario traces. No recorded rides exist in this repository, so
 * every trace here is hand-built from rough physical reasoning (handlebar or
 * tank-bag phone, 100 Hz linear acceleration in g with gravity removed,
 * gyroscope magnitude in rad/s, speed in km/h). They pin down how the engine
 * treats the situations that matter; they are not evidence of real-world
 * accuracy, which only recorded rides and field tests can give.
 */
private const val NO_FIX = -1.0

class CrashScenarioTest {
    private data class Run(val state: CrashState, val effects: List<Pair<Double, CrashEffect>>, val sawCandidate: Boolean)

    /** Feeds samples every 10 ms and ticks every 250 ms, like CrashRuntime. */
    private fun ride(
        seconds: Double,
        start: CrashState = CrashState(),
        accel: (Double) -> Double,
        rotation: (Double) -> Double,
        speed: (Double) -> Double?,
        gate: (Double) -> Double? = { null }
    ): Run {
        var state = start
        val effects = mutableListOf<Pair<Double, CrashEffect>>()
        var candidate = false
        var i = 0
        while (i * 0.01 <= seconds + 1e-9) {
            val t = i * 0.01
            val update = CrashEngine.step(state, CrashSample(t, accel(t), rotation(t), speed(t), gate(t)))
            state = update.state
            update.effects.forEach { effects += t to it }
            if (i % 25 == 0) {
                val tick = CrashEngine.tick(state, t)
                state = tick.state
                tick.effects.forEach { effects += t to it }
            }
            if (state.phase == CrashPhase.CANDIDATE) candidate = true
            i++
        }
        return Run(state, effects, candidate)
    }

    /** Deterministic road vibration: two incommensurate sines, never above [amplitude] + base. */
    private fun road(t: Double, base: Double = 0.15, amplitude: Double = 0.25) =
        base + amplitude * (0.6 * sin(2 * PI * 13.0 * t) + 0.4 * sin(2 * PI * 31.0 * t)).let { kotlin.math.abs(it) }

    private fun window(t: Double, from: Double, to: Double) = t >= from - 1e-9 && t < to - 1e-9

    @Test
    fun `pothole hit at speed - one sharp jolt, riding on - no check-in`() {
        // 60 km/h on a rough road; a 30 ms, 6 g pothole jolt at t = 2 s; the rider rides on.
        val run = ride(9.0,
            accel = { t -> if (window(t, 2.0, 2.03)) 6.0 else road(t) },
            rotation = { t -> if (window(t, 2.0, 2.05)) 3.0 else 0.4 },
            speed = { 60.0 })
        assertTrue("a sustained jolt at speed is worth a second look", run.sawCandidate)
        assertTrue(run.effects.isEmpty())
        assertEquals(CrashPhase.ARMED, run.state.phase)
    }

    @Test
    fun `pothole too short to count as an impact is ignored outright`() {
        val run = ride(4.0,
            accel = { t -> if (window(t, 2.0, 2.02)) 8.0 else road(t) },
            rotation = { 0.4 },
            speed = { 60.0 })
        assertFalse(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
    }

    @Test
    fun `hard braking from 80 km per h to a stop - no check-in`() {
        // About 0.9 g of deceleration for 2.5 s with front-fork pitch, then standing at the lights.
        val run = ride(8.0,
            accel = { t -> if (window(t, 1.0, 3.5)) 0.9 + 0.1 * sin(2 * PI * 5 * t) else if (t < 1.0) road(t) else 0.03 },
            rotation = { t -> if (window(t, 1.0, 1.4)) 1.2 else 0.2 },
            speed = { t -> when { t < 1.0 -> 80.0; t < 3.5 -> 80.0 - (t - 1.0) * 32.0; else -> 0.0 } })
        assertFalse(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
    }

    @Test
    fun `low-speed tip-over in a car park - below the speed gate, no check-in`() {
        // 5 km/h; the bike leans over in 0.6 s (peak 4 rad/s), hits the ground (5 g, 30 ms), then rests.
        // By design the speed gate (10 km/h) keeps parking drops from raising alarms.
        val run = ride(8.0,
            accel = { t -> when { window(t, 2.6, 2.63) -> 5.0; t < 2.0 -> road(t, 0.05, 0.1); t < 2.6 -> 0.6; else -> 0.02 } },
            rotation = { t -> if (window(t, 2.0, 2.6)) 4.0 * sin(PI * (t - 2.0) / 0.6) else 0.05 },
            speed = { t -> if (t < 2.6) 5.0 else 0.0 })
        assertFalse(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
    }

    @Test
    fun `real impact at speed followed by stillness - check-in, then alarm, then escalation`() {
        // 50 km/h; 8 g impact for 60 ms while the bike and rider tumble (9 rad/s for 0.8 s),
        // a short slide, then the rider lies still and the speed reads zero.
        val run = ride(60.0,
            accel = { t -> when { t < 3.0 -> road(t); window(t, 3.0, 3.06) -> 8.0; t < 3.8 -> 1.5; else -> 0.02 } },
            rotation = { t -> if (window(t, 2.95, 3.8)) 9.0 else if (t < 3.0) 0.4 else 0.02 },
            speed = { t -> if (t < 3.0) 50.0 else if (t < 3.8) 50.0 - (t - 3.0) * 62.5 else 0.0 })
        val kinds = run.effects.map { it.second }
        assertEquals(listOf(CrashEffect.CHECK_IN, CrashEffect.ALARM, CrashEffect.ESCALATE), kinds)
        val (checkInAt, _) = run.effects.first()
        assertTrue("check-in comes within seconds of the impact, at $checkInAt", checkInAt in 3.0..6.0)
        assertEquals(15.0, run.effects[1].first - checkInAt, 0.26)
        assertEquals(30.0, run.effects[2].first - run.effects[1].first, 0.26)
        assertEquals(CrashPhase.ESCALATED, run.state.phase)
    }

    @Test
    fun `real impact while the speed is unknown still checks in when the phone tumbles`() {
        // No ride context at all (speed null): only impact together with tumble promotes.
        val run = ride(8.0,
            accel = { t -> when { t < 3.0 -> road(t); window(t, 3.0, 3.06) -> 8.0; t < 3.8 -> 1.5; else -> 0.02 } },
            rotation = { t -> if (window(t, 2.85, 3.8)) 9.0 else 0.3 },
            speed = { null })
        assertEquals(listOf(CrashEffect.CHECK_IN), run.effects.map { it.second })
    }

    @Test
    fun `rider answers the check-in - the incident is dismissed as a near miss`() {
        val impact = ride(6.0,
            accel = { t -> when { t < 3.0 -> road(t); window(t, 3.0, 3.06) -> 8.0; t < 3.8 -> 1.5; else -> 0.02 } },
            rotation = { t -> if (window(t, 2.95, 3.8)) 9.0 else 0.3 },
            speed = { t -> if (t < 3.0) 50.0 else 0.0 })
        assertEquals(CrashPhase.CHECK_IN, impact.state.phase)
        val cancelled = CrashEngine.cancel(impact.state)
        assertEquals(listOf(CrashEffect.DISMISS, CrashEffect.NEAR_MISS), cancelled.effects)
        assertEquals(CrashPhase.ARMED, cancelled.state.phase)
    }

    /**
     * The crash detector's view of a live session: the relay sends no speed, so
     * the phone's GPS (fixes at 1 Hz, read through the session's RideSpeed) is
     * the only source: the 2 s-fresh sample speed and the 15 s gate speed. [fix]
     * returns the speed reported by the fix taken at a whole second, NO_FIX for
     * no fix at all, or null for a GPS fix without a usable speed.
     */
    private class GpsFeed(private val fix: (second: Int) -> Double?) {
        private var clockMs = 0L
        private val gps = io.github.henrycooper86.max.agent.RideSpeed(clock = { clockMs })
        private var lastSecond = -1
        private fun advance(t: Double) {
            clockMs = Math.round(t * 1000)
            val second = kotlin.math.floor(t + 1e-9).toInt()
            if (second != lastSecond) {
                lastSecond = second
                val kmh = fix(second)
                if (kmh != NO_FIX) gps.onGps(kmh, second * 1000L, fromGps = true)
            }
        }
        fun speed(t: Double): Double? { advance(t); return gps.forCrash() }
        fun gate(t: Double): Double? { advance(t); return gps.forCrashGate() }
    }

    private fun gpsRide(seconds: Double, accel: (Double) -> Double, rotation: (Double) -> Double, fix: (Int) -> Double?): Run {
        val feed = GpsFeed(fix)
        return ride(seconds, accel = accel, rotation = rotation, speed = feed::speed, gate = feed::gate)
    }

    // 8 g for 60 ms at t = 3 s with little rotation (no tumble): only the GPS speed opens the gate.
    private val impactAccel: (Double) -> Double = { t -> when { t < 3.0 -> road(t); window(t, 3.0, 3.06) -> 8.0; else -> 0.02 } }
    private val impactRotation: (Double) -> Double = { t -> if (window(t, 3.0, 3.06)) 3.0 else if (t < 3.0) 0.4 else 0.02 }

    private fun assertChecksInWithinConfirmWindow(run: Run) {
        assertTrue("the GPS speed opens the speed gate on the impact alone", run.sawCandidate)
        assertEquals(listOf(CrashEffect.CHECK_IN), run.effects.map { it.second })
        // The candidate starts at about 3.02 s and re-arms 5 s later if not confirmed.
        assertTrue("check-in at ${run.effects.single().first}", run.effects.single().first < 3.02 + CrashTuning().confirmS)
    }

    @Test
    fun `GPS-only - impact at 50 km per h, then no further fixes - check-in`() {
        // The tumbled phone loses GPS entirely: the last 50 km/h reading must expire, not linger.
        val run = gpsRide(10.0, impactAccel, impactRotation) { second -> if (second <= 3) 50.0 else NO_FIX }
        assertChecksInWithinConfirmWindow(run)
    }

    @Test
    fun `GPS-only - impact at 50 km per h, then fixes with no usable speed - check-in`() {
        // Degraded GPS keeps delivering positions but no trustworthy speed.
        val run = gpsRide(10.0, impactAccel, impactRotation) { second -> if (second <= 3) 50.0 else null }
        assertChecksInWithinConfirmWindow(run)
    }

    @Test
    fun `GPS-only - impact at 50 km per h, then valid fixes reading zero - check-in`() {
        val run = gpsRide(10.0, impactAccel, impactRotation) { second -> if (second <= 3) 50.0 else 0.0 }
        assertChecksInWithinConfirmWindow(run)
    }

    @Test
    fun `GPS-only - one pothole while the rider keeps riding at speed - no check-in`() {
        val run = gpsRide(12.0, accel = { t -> if (window(t, 3.0, 3.03)) 6.0 else road(t) }, rotation = { 0.4 }) { 60.0 }
        assertTrue(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
        assertEquals(CrashPhase.ARMED, run.state.phase)
    }

    /** Impact-only crash (8 g, 60 ms, little rotation) at [at] s, then stillness. */
    private fun impactOnlyAt(at: Double): Pair<(Double) -> Double, (Double) -> Double> =
        { t: Double -> when { t < at -> road(t); window(t, at, at + 0.06) -> 8.0; else -> 0.02 } } to
            { t: Double -> if (window(t, at, at + 0.06)) 3.0 else if (t < at) 0.4 else 0.02 }

    @Test
    fun `GPS-only - into a tunnel at 60 km per h, impact 10 s later - the gate stays open, check-in`() {
        // Fixes until t = 3 s, then none in the tunnel; the impact comes at t = 13 s.
        val (accel, rotation) = impactOnlyAt(13.0)
        val run = gpsRide(20.0, accel, rotation) { second -> if (second <= 3) 60.0 else NO_FIX }
        assertTrue(run.sawCandidate)
        assertEquals(listOf(CrashEffect.CHECK_IN), run.effects.map { it.second })
        assertTrue(run.effects.single().first < 13.02 + CrashTuning().confirmS)
    }

    @Test
    fun `GPS-only - an impact 20 s into a tunnel no longer opens the gate`() {
        val (accel, rotation) = impactOnlyAt(23.0)
        val run = gpsRide(30.0, accel, rotation) { second -> if (second <= 3) 60.0 else NO_FIX }
        assertFalse(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
    }

    @Test
    fun `GPS-only - a hard jolt while stopped at a light does not open the gate`() {
        // 50 km/h, braking to a stop by t = 5 s; GPS keeps working and reads 0; a jolt at t = 14 s.
        val (accel, rotation) = impactOnlyAt(14.0)
        val run = gpsRide(20.0, accel, rotation) { second -> if (second < 5) 50.0 - second * 10.0 else 0.0 }
        assertFalse(run.sawCandidate)
        assertTrue(run.effects.isEmpty())
    }

    // ---- Reported, not retuned: traces where the current engine misbehaves --------

    @Ignore("Reported: phone dropped while parked (speed known 0) raises a check-in via the impact+tumble path")
    @Test
    fun `phone dropped while stationary - no check-in`() {
        // Parked (0 km/h). The phone slips from the mount: 0.45 s fall spinning at 8 rad/s,
        // 12 g for 30 ms on the ground while still spinning, a small bounce, then it lies still.
        val run = ride(8.0,
            accel = { t -> when { t < 2.0 -> 0.02; t < 2.45 -> 1.0; window(t, 2.45, 2.48) -> 12.0; t < 2.6 -> 2.0; else -> 0.01 } },
            rotation = { t -> if (window(t, 2.0, 2.55)) 8.0 else 0.02 },
            speed = { 0.0 })
        assertTrue(run.effects.isEmpty())
    }

    @Ignore("Reported: two potholes within 5 s at speed raise a check-in (the second jolt confirms the first)")
    @Test
    fun `two potholes a second and a half apart at speed - no check-in`() {
        val run = ride(9.0,
            accel = { t -> if (window(t, 2.0, 2.03) || window(t, 3.5, 3.53)) 6.0 else road(t) },
            rotation = { 0.4 },
            speed = { 60.0 })
        assertTrue(run.effects.isEmpty())
    }

    @Ignore("Reported: a speed source that keeps reporting 50 km/h after a real crash blocks the stillness " +
        "confirmation. In a live session the GPS feed can no longer do this (a fix without speed is unknown, and " +
        "the crash detector drops GPS speed after 2 s), but a mock relay's fixed scenario speed, or a receiver " +
        "that keeps reporting a valid but wrong speed, still can.")
    @Test
    fun `real impact with a speed reading that stays stale - still checks in`() {
        // As the real-impact scenario, but the speed source keeps reporting 50 km/h
        // after the crash (a relay ride.context that is not refreshed from GPS).
        val run = ride(10.0,
            accel = { t -> when { t < 3.0 -> road(t); window(t, 3.0, 3.06) -> 8.0; else -> 0.02 } },
            rotation = { t -> if (window(t, 3.0, 3.06)) 3.0 else if (t < 3.0) 0.4 else 0.02 },
            speed = { 50.0 })
        assertEquals(listOf(CrashEffect.CHECK_IN), run.effects.map { it.second })
    }
}
