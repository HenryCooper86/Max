package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.actions.smsSpeedRefusal
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RideSpeedTest {
    private var now = 100_000L
    private val speed = RideSpeed(clock = { now })

    @Test
    fun `a GPS fix converts metres per second to km per h and rejects unusable readings`() {
        assertEquals(36.0, gpsSpeedKmh(hasSpeed = true, speedMps = 10f, hasSpeedAccuracy = true, speedAccuracyMps = 0.5f)!!, 1e-6)
        // Older receivers report no speed accuracy: the reading is still usable.
        assertEquals(18.0, gpsSpeedKmh(true, 5f, hasSpeedAccuracy = false, speedAccuracyMps = 0f)!!, 1e-6)
        assertEquals(0.0, gpsSpeedKmh(true, 0f, true, 0.3f)!!, 0.0)
        assertNull(gpsSpeedKmh(hasSpeed = false, speedMps = 10f, hasSpeedAccuracy = true, speedAccuracyMps = 0.5f))
        assertNull(gpsSpeedKmh(true, -1f, true, 0.5f))
        assertNull(gpsSpeedKmh(true, Float.NaN, true, 0.5f))
        assertNull("too uncertain to tell walking from riding", gpsSpeedKmh(true, 3f, true, 3.5f))
        assertNull(gpsSpeedKmh(true, 3f, true, Float.NaN))
        assertNull("faster than any motorcycle", gpsSpeedKmh(true, 120f, true, 0.5f))
    }

    private fun gps(kmh: Double?, at: Long = now) = speed.onGps(kmh, at, fromGps = true)

    @Test
    fun `a fresh GPS speed wins over the mock relay`() {
        speed.onSessionMode("mock")
        speed.onRelay(0.0)
        gps(47.0, now - 1_000)
        assertEquals(47.0, speed.current()!!, 0.0)
        assertEquals(47.0, speed.forCrash()!!, 0.0)
    }

    @Test
    fun `the crash detector never uses the relay speed, even in a mock session`() {
        speed.onSessionMode("mock")
        speed.onRelay(58.0)
        assertEquals("the mock speed still serves SMS, typing and the HUD", 58.0, speed.current()!!, 0.0)
        assertNull(speed.forCrash())
        assertNull(speed.forCrashGate())
    }

    @Test
    fun `only a mode of exactly mock is trusted`() {
        for (mode in listOf("live", "Mock", "demo", "")) {
            speed.onSessionMode(mode)
            speed.onRelay(58.0)
            assertNull(mode, speed.current())
        }
    }

    @Test
    fun `a closed socket or a reconnect forgets the relay speed and the mode`() {
        speed.onSessionMode("mock")
        speed.onRelay(58.0)
        speed.onSocketClosed()
        assertNull(speed.current())
        speed.onRelay(58.0) // a late ride.context before the next session.started
        assertNull(speed.current())
    }

    @Test
    fun `the gate speed outlives a tunnel for fifteen seconds`() {
        gps(60.0)
        now += 3_000
        gps(null) // fixes without a usable speed: the reading goes unknown, the gate remembers
        assertNull(speed.forCrash())
        assertEquals(60.0, speed.forCrashGate()!!, 0.0)
        now += CRASH_GATE_SPEED_FRESH_MS - 3_000
        assertEquals(60.0, speed.forCrashGate()!!, 0.0)
        now += 1
        assertNull(speed.forCrashGate())
        assertEquals(15_000L, CRASH_GATE_SPEED_FRESH_MS)
    }

    @Test
    fun `a newer usable reading always replaces the gate speed, even a lower one`() {
        gps(60.0)
        now += 1_000
        gps(0.0)
        assertEquals(0.0, speed.forCrashGate()!!, 0.0)
        speed.onGps(null, now + 500, fromGps = false)
        assertEquals(0.0, speed.forCrashGate()!!, 0.0)
        gps(55.0, now - 5_000) // an older fix arriving late
        assertEquals(0.0, speed.forCrashGate()!!, 0.0)
    }

    @Test
    fun `a stale GPS speed falls back to the mock relay, then to unknown`() {
        speed.onSessionMode("mock")
        gps(47.0)
        now += 5_001
        speed.onRelay(12.0)
        assertEquals(12.0, speed.current()!!, 0.0)
        speed.onRelay(null)
        assertNull(speed.current())
        assertNull(speed.freshGpsKmh())
    }

    @Test
    fun `a fix exactly at the freshness edge is still fresh`() {
        gps(30.0)
        now += SPEED_FRESH_MS
        assertEquals(30.0, speed.current()!!, 0.0)
    }

    @Test
    fun `the crash detector forgets a GPS speed after two seconds, other uses after five`() {
        gps(50.0)
        now += CRASH_SPEED_FRESH_MS
        assertEquals(50.0, speed.forCrash()!!, 0.0)
        now += 1
        assertNull(speed.forCrash())
        assertEquals(50.0, speed.current()!!, 0.0)
        assertEquals(2_000L, CRASH_SPEED_FRESH_MS)
        assertEquals(5_000L, SPEED_FRESH_MS)
    }

    @Test
    fun `a GPS fix without a usable speed makes the speed unknown at once`() {
        gps(50.0)
        now += 500
        gps(null)
        assertNull(speed.current())
        assertNull(speed.forCrash())
    }

    @Test
    fun `a network fix without speed never erases a fresh GPS reading`() {
        gps(50.0)
        now += 500
        speed.onGps(null, now, fromGps = false)
        assertEquals(50.0, speed.current()!!, 0.0)
    }

    @Test
    fun `an older fix arriving late never replaces a newer one`() {
        gps(50.0)
        gps(0.0, now - 2_000)
        gps(null, now - 1_000)
        assertEquals(50.0, speed.current()!!, 0.0)
    }

    @Test
    fun `reset forgets the last session's speed and mode`() {
        speed.onSessionMode("mock")
        speed.onRelay(30.0)
        gps(50.0)
        speed.reset()
        assertNull(speed.current())
        assertNull(speed.forCrashGate())
        speed.onRelay(30.0)
        assertNull("mode unknown until session.started", speed.current())
    }

    @Test
    fun `a live relay's speed is the phone's own echo and is never used`() {
        speed.onSessionMode("live")
        speed.onRelay(0.0)
        assertNull(speed.current())
        assertNull(speed.forCrash())
    }

    @Test
    fun `a mock session still sees the scenario speed`() {
        speed.onRelay(58.0) // before session.started: unknown mode, ignored
        assertNull(speed.current())
        speed.onSessionMode("mock")
        speed.onRelay(58.0)
        assertEquals(58.0, speed.current()!!, 0.0)
    }

    @Test
    fun `learning the mode clears a relay speed from before it`() {
        speed.onSessionMode("mock")
        speed.onRelay(58.0)
        speed.onSessionMode("mock")
        assertNull(speed.current())
    }

    @Test
    fun `stopped at a light, then into a tunnel - SMS stays refused`() {
        speed.onSessionMode("live")
        gps(0.0)
        speed.onRelay(0.0) // the relay echoes the phone's last location.update speed
        assertNull(smsSpeedRefusal(speed.current()))
        // Riding off into a tunnel: no more fixes.
        now += 5_001
        assertNull(speed.current())
        assertTrue(smsSpeedRefusal(speed.current()) != null)
        assertEquals(TypedInputMode.READY, typedInputMode(readyState(speed.current())))
    }

    @Test
    fun `the relay's ride context speed is optional, never a silent zero`() {
        fun context(extra: String) = (parseAgentEvent(
            """{"type":"ride.context","mode":"ride","modeLabel":"Ride","scenario":"commute","scenarioLabel":"Commute","hazardLevel":"normal","glanceableFocus":"x"$extra}"""
        ) as AgentEvent.RideContextUpdate).rideContext.speedKmh
        assertNull(context(""))
        assertEquals(58, context(""","speedKmh":58"""))
        assertEquals(0, context(""","speedKmh":0"""))
        assertNull(context(""","speedKmh":null"""))
        assertNull(context(""","speedKmh":"fast""""))
        assertNull(context(""","speedKmh":-3"""))
        assertNull(context(""","speedKmh":1000"""))
        assertNull(RideContext().speedKmh)
    }

    @Test
    fun `location update carries the GPS speed only when one is known`() {
        val withSpeed = JSONObject(buildLocationUpdate(31.2, 121.4, speedKmh = 42.26))
        assertEquals("location.update", withSpeed.getString("type"))
        assertEquals(31.2, withSpeed.getDouble("lat"), 0.0)
        assertEquals(121.4, withSpeed.getDouble("lon"), 0.0)
        assertEquals(42.3, withSpeed.getDouble("speedKmh"), 1e-9)
        assertFalse(JSONObject(buildLocationUpdate(31.2, 121.4, speedKmh = null)).has("speedKmh"))
        assertFalse(JSONObject(buildLocationUpdate(31.2, 121.4, speedKmh = Double.NaN)).has("speedKmh"))
        assertFalse(JSONObject(buildLocationUpdate(31.2, 121.4, speedKmh = 401.0)).has("speedKmh"))
        assertEquals(0.0, JSONObject(buildLocationUpdate(31.2, 121.4, speedKmh = 0.0)).getDouble("speedKmh"), 0.0)
    }

    @Test
    fun `SMS stays refused when speed is unknown, and says why`() {
        assertNull(smsSpeedRefusal(0.0))
        assertNull(smsSpeedRefusal(4.99))
        assertTrue("5.0 km/h is already too fast", smsSpeedRefusal(5.0) != null)
        val moving = smsSpeedRefusal(42.0)!!
        assertEquals("denied", moving.status)
        assertEquals("unsafe.speed", moving.reason)
        assertNull("the relay's own line covers riding", moving.detail)
        val unknown = smsSpeedRefusal(null)!!
        assertEquals("unsafe.speed", unknown.reason)
        assertTrue("unknown speed explains itself instead of claiming the rider is riding", !unknown.detail.isNullOrBlank())
    }

    private fun readyState(speed: Double?) = AgentSession.State(
        handsFree = true,
        connection = ConnectionState.READY,
        capabilities = ProviderCapabilities(textInput = true),
        speedKmh = speed
    )

    @Test
    fun `typing follows the effective speed and stays usable when it is unknown`() {
        assertEquals(TypedInputMode.READY, typedInputMode(readyState(null)))
        assertEquals(TypedInputMode.READY, typedInputMode(readyState(4.99)))
        assertEquals(TypedInputMode.STOP_TO_TYPE, typedInputMode(readyState(5.0)))
    }
}
