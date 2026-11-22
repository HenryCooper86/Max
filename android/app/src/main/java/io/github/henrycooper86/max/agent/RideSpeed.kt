package io.github.henrycooper86.max.agent

/** Above this 68% speed uncertainty (about 11 km/h) a reading cannot tell walking pace from riding. */
private const val MAX_SPEED_ACCURACY_MPS = 3f

/** Faster than any road motorcycle: a receiver glitch, not a speed. */
const val MAX_PLAUSIBLE_SPEED_KMH = 400.0

/** How long a GPS speed counts for the SMS rule, the typing lock and the HUD. */
const val SPEED_FRESH_MS = 5_000L

/**
 * How long a GPS speed counts for crash detection. Shorter, because a speed
 * left over from before an impact vetoes the stillness check that confirms a
 * crash; after a fall the phone often gets no new usable fix for seconds.
 */
const val CRASH_SPEED_FRESH_MS = 2_000L

/**
 * How long the last usable GPS speed keeps the crash detector's speed gate
 * open. Through a tunnel, or with fixes too inaccurate for a speed, the gate
 * would otherwise close within seconds and an impact alone could no longer
 * start an incident. It never feeds the stillness check.
 */
const val CRASH_GATE_SPEED_FRESH_MS = 15_000L

/**
 * Ground speed in km/h from one `android.location.Location`, or null when the
 * fix carries no usable speed. Speed accuracy exists from Android 8 (the app's
 * minimum), but older receivers may not report it; then the reading is kept.
 */
fun gpsSpeedKmh(hasSpeed: Boolean, speedMps: Float, hasSpeedAccuracy: Boolean, speedAccuracyMps: Float): Double? {
    if (!hasSpeed || !speedMps.isFinite() || speedMps < 0f) return null
    if (hasSpeedAccuracy && !(speedAccuracyMps.isFinite() && speedAccuracyMps in 0f..MAX_SPEED_ACCURACY_MPS)) return null
    return (speedMps * 3.6).takeIf { it <= MAX_PLAUSIBLE_SPEED_KMH }
}

/**
 * The phone's own idea of how fast the rider is going.
 *
 * The phone's GPS is the source: crash detection must work when the relay is
 * unreachable. A GPS fix without a usable speed records "unknown" at its time,
 * so an old reading never outlives the fix that should have replaced it.
 * Network-provider fixes carry no speed and only add a position; they are
 * ignored here so they cannot erase a GPS reading taken a moment earlier.
 *
 * A live relay's ride.context speed is only the phone's own location.update
 * speed echoed back, with no age, so it is never used. A mock (demo) relay's
 * speed is the scenario speed and counts behind fresh GPS for SMS, typing and
 * the HUD, never for crash detection: a constant demo speed would veto the
 * stillness check after every impact. The mode is unknown until
 * session.started and forgotten whenever the socket closes or reconnects;
 * meanwhile relay speed is ignored.
 *
 * Times are SystemClock.elapsedRealtime millis. Fixes and relay events arrive
 * on the main thread; the crash detector and device actions read from others.
 */
class RideSpeed(private val clock: () -> Long) {
    private var gpsKmh: Double? = null
    private var gpsAtMs = Long.MIN_VALUE
    private var gateKmh: Double? = null
    private var gateAtMs = Long.MIN_VALUE
    private var mockSession = false
    private var relayKmh: Double? = null

    @Synchronized
    fun onGps(kmh: Double?, fixAtMs: Long, fromGps: Boolean) {
        val usable = kmh?.takeIf { it.isFinite() && it in 0.0..MAX_PLAUSIBLE_SPEED_KMH }
        if (usable != null && fixAtMs >= gateAtMs) {
            gateKmh = usable
            gateAtMs = fixAtMs
        }
        if (usable == null && !fromGps) return
        if (fixAtMs < gpsAtMs) return
        gpsKmh = usable
        gpsAtMs = fixAtMs
    }

    /** session.started: the relay's speed is trusted only when the mode is exactly "mock". */
    @Synchronized
    fun onSessionMode(mode: String) {
        mockSession = mode == "mock"
        relayKmh = null
    }

    /** The socket closed or a reconnect began: the next session must say its mode again. */
    @Synchronized
    fun onSocketClosed() {
        mockSession = false
        relayKmh = null
    }

    /** ride.context: the relay's speedKmh, or null when it did not send one. */
    @Synchronized
    fun onRelay(kmh: Double?) {
        relayKmh = kmh?.takeIf { mockSession && it.isFinite() && it in 0.0..MAX_PLAUSIBLE_SPEED_KMH }
    }

    @Synchronized
    fun freshGpsKmh(maxAgeMs: Long = SPEED_FRESH_MS): Double? = gpsKmh?.takeIf { clock() - gpsAtMs <= maxAgeMs }

    /** For the SMS rule, the typing lock, the HUD and location.update. */
    @Synchronized
    fun current(): Double? = freshGpsKmh(SPEED_FRESH_MS) ?: relayKmh

    /** For the crash detector's stillness check: phone GPS only, unknown rather than a stale pre-impact speed. */
    @Synchronized
    fun forCrash(): Double? = freshGpsKmh(CRASH_SPEED_FRESH_MS)

    /** For the crash detector's speed gate: the last usable GPS speed, up to 15 s old. */
    @Synchronized
    fun forCrashGate(): Double? = gateKmh?.takeIf { clock() - gateAtMs <= CRASH_GATE_SPEED_FRESH_MS }

    /** When the current GPS reading stops being fresh, or null when there is none. */
    @Synchronized
    fun freshUntilMs(): Long? = gpsKmh?.let { gpsAtMs + SPEED_FRESH_MS }?.takeIf { it >= clock() }

    @Synchronized
    fun reset() {
        gpsKmh = null
        gpsAtMs = Long.MIN_VALUE
        gateKmh = null
        gateAtMs = Long.MIN_VALUE
        mockSession = false
        relayKmh = null
    }
}
