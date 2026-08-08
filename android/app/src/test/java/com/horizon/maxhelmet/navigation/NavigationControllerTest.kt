package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.NavRouteData
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Controller-level copies of the exact spoken lines (binding per the brief) —
// kept here, not imported, since NavigationController's own constants are
// private; a drift between these and the implementation is exactly what
// these tests exist to catch.
private const val STOP_TEXT = "已停止导航。"
private const val ARRIVED_TEXT = "已到达目的地。"
private const val REROUTE_SENDING_TEXT = "已偏离路线，正在重新规划。"
private const val REROUTE_FAILED_TEXT = "无法重新规划路线，已停止导航。"

/**
 * The route fixture is defined in WGS-84 (same literal lat/lon progression as
 * GuidanceEngineTest's north-bound route) and transformed through the SAME
 * `CoordinateDatum.wgs84ToGcj02` the controller uses at its `onFix` boundary,
 * so a WGS-84 fix fed via `FakeLocationSource.fix` and the GCJ-02 route
 * geometry stay mutually consistent — the controller does exactly one
 * datum conversion, and this fixture mirrors that single conversion rather
 * than trying to hand-place already-shifted coordinates.
 */
private val wgsDestination = LatLon(31.24, 121.47)
private val wgsPolyline = listOf(LatLon(31.23, 121.47), LatLon(31.235, 121.47), LatLon(31.24, 121.47))

/** The route's own start vertex: on-route (zero cross-track), 555 m short of
 *  the first maneuver (past every prompt threshold) and ~1109 m short of
 *  arrival. Safe to feed at any time, including while this fixture route is
 *  already active — used purely to unblock a start's first-fix wait without
 *  perturbing a DIFFERENT, already-committed navigation under test. */
private val neutralWgsFix = LatLon(31.23, 121.47)

private fun sampleRouteData(commandId: String): NavRouteData = NavRouteData(
    commandId = commandId,
    destinationName = "测试终点",
    destination = CoordinateDatum.wgs84ToGcj02(wgsDestination),
    polyline = wgsPolyline.map(CoordinateDatum::wgs84ToGcj02),
    steps = listOf(
        ManeuverStep("右转", CoordinateDatum.wgs84ToGcj02(LatLon(31.235, 121.47)), 555.0),
        ManeuverStep("到达终点", CoordinateDatum.wgs84ToGcj02(wgsDestination), 1109.0)
    ),
    distanceMeters = 1109.0,
    etaSeconds = 240.0
)

class NavigationControllerTest {

    private class FakeLocationSource : LocationSource {
        var started = false
            private set
        var startCalls = 0
            private set
        var stopCalls = 0
            private set
        private var callback: ((LatLon) -> Unit)? = null

        override fun start(onFix: (LatLon) -> Unit) {
            startCalls++
            started = true
            callback = onFix
        }

        override fun stop() {
            stopCalls++
            started = false
        }

        /** Invokes the last-captured callback synchronously — mirrors a real
         *  location callback firing on whatever thread calls this. */
        fun fix(lat: Double, lon: Double) {
            callback?.invoke(LatLon(lat, lon))
        }
    }

    private class FakeSpeaker : NavSpeaker {
        override var hazardActive: Boolean = false
        val spoken = CopyOnWriteArrayList<Pair<String, Boolean>>()
        override fun speak(text: String, interrupt: Boolean) {
            spoken.add(text to interrupt)
        }
    }

    private class Harness(
        firstFixTimeoutMillis: Long = 3_000,
        hasPermission: () -> Boolean = { true }
    ) {
        var clockMillis: Long = 0L
        val sent = CopyOnWriteArrayList<String>()
        val results = CopyOnWriteArrayList<String>()
        val guidanceUpdates = CopyOnWriteArrayList<NavGuidanceState?>()
        val locationSource = FakeLocationSource()
        val speaker = FakeSpeaker()
        val relay = RelayNavigationSearch(send = { sent.add(it) })
        val controller = NavigationController(
            search = relay,
            locationSource = locationSource,
            speaker = speaker,
            sendResult = { results.add(it) },
            onGuidance = { guidanceUpdates.add(it) },
            hasLocationPermission = hasPermission,
            now = { clockMillis },
            firstFixTimeoutMillis = firstFixTimeoutMillis
        )
    }

    /** Bounded busy-wait for an observable condition instead of an arbitrary
     *  Thread.sleep hope. Only sound because the coroutine under test runs on
     *  Dispatchers.Default (a real thread pool), never runBlocking's own
     *  thread — otherwise this poll loop would starve it. Mirrors
     *  RelayNavigationSearchTest's idiom. */
    private fun awaitCondition(timeoutMs: Long = 2_000, description: String = "condition", check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!check()) {
            if (System.currentTimeMillis() > deadline) {
                throw AssertionError("Timed out waiting for $description")
            }
            Thread.sleep(5)
        }
    }

    /** The complement of [awaitCondition] for proving an absence: actively
     *  re-checks the invariant throughout the window instead of sleeping
     *  once and hoping, and fails the instant it's violated. */
    private fun assertConditionHoldsFor(windowMs: Long = 250, description: String, holds: () -> Boolean) {
        val deadline = System.currentTimeMillis() + windowMs
        while (System.currentTimeMillis() < deadline) {
            assertTrue(description, holds())
            Thread.sleep(5)
        }
    }

    /** Repeatedly redelivers [wgsFix] until [condition] holds. A single-shot
     *  delivery races a start's own coroutine reaching its `awaitFirstFix`
     *  registration — arriving first, it would be silently lost (nothing is
     *  pending yet to resolve) and the wait would hang until the timeout.
     *  Safe to loop: once already consumed, or once a route is active and
     *  [wgsFix] is [neutralWgsFix] (inert against it — see its doc), further
     *  redelivery has no additional effect. */
    private fun feedFixUntil(
        h: Harness,
        wgsFix: LatLon,
        timeoutMs: Long = 2_000,
        description: String = "condition",
        condition: () -> Boolean
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            h.locationSource.fix(wgsFix.lat, wgsFix.lon)
            if (System.currentTimeMillis() > deadline) {
                throw AssertionError("Timed out waiting for $description")
            }
            Thread.sleep(5)
        }
    }

    /** Drives a full navigation.start to a committed route: launches
     *  `handleCommand` on its own coroutine, feeds the first fix (retrying
     *  until it lands — see [feedFixUntil]), answers the resulting
     *  nav.request, and joins. */
    private suspend fun commitRoute(
        h: Harness,
        commandId: String = "cmd-start",
        query: String = "测试目的地",
        wgsFix: LatLon = neutralWgsFix
    ) = coroutineScope {
        val baseline = h.sent.size
        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand(commandId, "navigation.start", query)
        }
        feedFixUntil(h, wgsFix, description = "nav.request sent") { h.sent.size > baseline }
        val reqCommandId = JSONObject(h.sent.last()).getString("commandId")
        h.relay.handleNavRoute(sampleRouteData(reqCommandId))
        job.join()
    }

    // ---- navigation.start ---------------------------------------------

    @Test
    fun `start is held until the relay answers, then resolves ok with a datum-shifted origin`() = runBlocking {
        val h = Harness()
        val wgsFix = LatLon(31.2304, 121.4737)
        val expectedOrigin = CoordinateDatum.wgs84ToGcj02(wgsFix)

        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-1", "navigation.start", "人民广场")
        }
        feedFixUntil(h, wgsFix, description = "nav.request sent") { h.sent.size == 1 }

        assertTrue("no device.result before the relay answers", h.results.isEmpty())

        val requestJson = JSONObject(h.sent[0])
        assertEquals("start", requestJson.getString("reason"))
        val origin = requestJson.getJSONObject("origin")
        // The datum edge: the request origin is the GCJ-02 shift of the fed
        // WGS-84 fix, not the raw fix itself.
        assertTrue(
            "origin must be datum-shifted, not the raw WGS-84 fix",
            kotlin.math.abs(origin.getDouble("lat") - wgsFix.lat) > 1e-4 ||
                kotlin.math.abs(origin.getDouble("lon") - wgsFix.lon) > 1e-4
        )
        assertEquals(expectedOrigin.lat, origin.getDouble("lat"), 1e-9)
        assertEquals(expectedOrigin.lon, origin.getDouble("lon"), 1e-9)

        val commandId = requestJson.getString("commandId")
        h.relay.handleNavRoute(sampleRouteData(commandId))
        job.join()

        assertEquals(1, h.results.size)
        val result = JSONObject(h.results[0])
        assertEquals("cmd-1", result.getString("commandId"))
        assertEquals("ok", result.getString("status"))
        assertTrue(h.locationSource.started)
    }

    @Test
    fun `denied permission short-circuits with exactly one denied result and no request`() = runBlocking {
        val h = Harness(hasPermission = { false })

        h.controller.handleCommand("cmd-2", "navigation.start", "人民广场")

        assertEquals(1, h.results.size)
        val result = JSONObject(h.results[0])
        assertEquals("denied", result.getString("status"))
        assertEquals("permission.location", result.getString("reason"))
        assertTrue(h.sent.isEmpty())
    }

    @Test
    fun `no fix within the timeout resolves unsupported without ever reaching the relay`() = runBlocking {
        val h = Harness(firstFixTimeoutMillis = 50)

        h.controller.handleCommand("cmd-3", "navigation.start", "人民广场")

        assertEquals(1, h.results.size)
        val result = JSONObject(h.results[0])
        assertEquals("unsupported", result.getString("status"))
        assertEquals("route.unavailable", result.getString("reason"))
        assertTrue(h.sent.isEmpty())
        assertFalse(h.locationSource.started)
    }

    // ---- navigation.stop -------------------------------------------------

    @Test
    fun `stop with nothing active resolves failed navigationNotActive`() = runBlocking {
        val h = Harness()

        h.controller.handleCommand("cmd-4", "navigation.stop", null)

        assertEquals(1, h.results.size)
        val result = JSONObject(h.results[0])
        assertEquals("failed", result.getString("status"))
        assertEquals("navigation.notActive", result.getString("reason"))
    }

    @Test
    fun `stop with an active route resolves ok, speaks, clears guidance, and stops the source`() = runBlocking {
        val h = Harness()
        commitRoute(h)
        h.results.clear()
        h.speaker.spoken.clear()
        h.guidanceUpdates.clear()

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)

        assertEquals(1, h.results.size)
        val result = JSONObject(h.results[0])
        assertEquals("ok", result.getString("status"))
        assertEquals(listOf(STOP_TEXT to false), h.speaker.spoken)
        assertEquals(listOf<NavGuidanceState?>(null), h.guidanceUpdates)
        assertFalse(h.locationSource.started)
    }

    // ---- concurrency -------------------------------------------------

    @Test
    fun `two concurrent starts each resolve exactly once, and the second's commit lands on a started source`() =
        runBlocking {
            val h = Harness()
            val jobA = launch(Dispatchers.Default) {
                h.controller.handleCommand("cmd-A", "navigation.start", "第一目的地")
            }
            feedFixUntil(h, neutralWgsFix, description = "A's nav.request sent") { h.sent.size == 1 }

            val jobB = launch(Dispatchers.Default) {
                h.controller.handleCommand("cmd-B", "navigation.start", "第二目的地")
            }
            feedFixUntil(h, neutralWgsFix, description = "B's nav.request sent") { h.sent.size == 2 } // B's own first fix

            jobA.join()
            val resultA = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-A" })
            assertEquals("unsupported", resultA.getString("status"))
            assertEquals("route.unavailable", resultA.getString("reason"))

            val commandIdB = JSONObject(h.sent[1]).getString("commandId")
            h.relay.handleNavRoute(sampleRouteData(commandIdB))
            jobB.join()

            val resultB = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-B" })
            assertEquals("ok", resultB.getString("status"))
            assertTrue("B's commit must land on a started source", h.locationSource.started)
        }

    @Test
    fun `a failed concurrent re-start does not disturb the already-active route`() = runBlocking {
        val h = Harness()
        commitRoute(h, commandId = "cmd-A")

        val jobB = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-B", "navigation.start", "第二目的地")
        }
        val baseline = h.sent.size
        feedFixUntil(h, neutralWgsFix, description = "B's nav.request sent") { h.sent.size > baseline } // B's own first fix
        val commandIdB = JSONObject(h.sent.last()).getString("commandId")
        h.relay.handleNavError(commandIdB, "destination.notFound")
        jobB.join()

        val resultB = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-B" })
        assertEquals("unsupported", resultB.getString("status"))
        assertEquals("route.unavailable", resultB.getString("reason"))
        assertTrue("route A's source must still be running", h.locationSource.started)

        h.guidanceUpdates.clear()
        h.locationSource.fix(31.2320, 121.47) // still a fix on route A's polyline
        assertTrue("route A must still publish guidance after B's failure", h.guidanceUpdates.isNotEmpty())
        assertNotNull(h.guidanceUpdates.last())
    }

    // ---- prompts -------------------------------------------------------

    @Test
    fun `far prompt speaks without interrupt, now prompt speaks with interrupt, keyed on threshold identity`() =
        runBlocking {
            val h = Harness()
            commitRoute(h)

            h.locationSource.fix(31.2320, 121.47) // ~333 m -> FAR
            assertEquals(1, h.speaker.spoken.size)
            val (farText, farInterrupt) = h.speaker.spoken[0]
            assertTrue(farText.contains("右转"))
            assertFalse("far must not interrupt", farInterrupt)

            h.locationSource.fix(31.2348, 121.47) // ~22 m -> NOW
            assertEquals(2, h.speaker.spoken.size)
            val (nowText, nowInterrupt) = h.speaker.spoken[1]
            assertEquals("右转", nowText)
            assertTrue("now must interrupt, keyed on threshold identity", nowInterrupt)
        }

    @Test
    fun `a hazard-active prompt is dropped, not queued, and never re-spoken once its threshold has fired`() =
        runBlocking {
            val h = Harness()
            commitRoute(h)
            h.speaker.hazardActive = true

            h.locationSource.fix(31.2320, 121.47) // FAR would fire, but hazard-active
            assertTrue("hazard-active must drop the prompt, not speak it", h.speaker.spoken.isEmpty())

            h.speaker.hazardActive = false
            h.locationSource.fix(31.2320, 121.47) // same position: threshold already fired
            assertTrue("an already-fired threshold must not be spoken retroactively", h.speaker.spoken.isEmpty())
        }

    // ---- arrival -------------------------------------------------------

    @Test
    fun `arrival speaks the arrival line, clears guidance, and stops the source`() = runBlocking {
        val h = Harness()
        commitRoute(h)
        h.guidanceUpdates.clear()

        // Exactly the destination vertex — also exactly the final maneuver's
        // own coordinate, so its own NOW prompt legitimately fires alongside
        // arrival (GuidanceEngine's rules 1/6: an independent metric, not
        // mutually exclusive with a threshold firing on the same tick — the
        // dedicated prompt tests above cover that in isolation). This test
        // only asserts what arrival itself is responsible for.
        h.locationSource.fix(31.24, 121.47)

        assertTrue(
            "the arrival line must be spoken without interrupt",
            h.speaker.spoken.contains(ARRIVED_TEXT to false)
        )
        assertEquals(listOf<NavGuidanceState?>(null), h.guidanceUpdates)
        assertFalse(h.locationSource.started)
    }

    @Test
    fun `a start in flight during arrival still commits on the re-asserted source`() = runBlocking {
        val h = Harness()
        commitRoute(h, commandId = "cmd-A")

        val jobB = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-B", "navigation.start", "第二目的地")
        }
        val baseline = h.sent.size
        feedFixUntil(h, neutralWgsFix, description = "B's nav.request sent") { h.sent.size > baseline } // B's own first fix
        val commandIdB = JSONObject(h.sent.last()).getString("commandId")

        h.locationSource.fix(31.24, 121.47) // route A arrives while B awaits the relay
        assertFalse("arrival stops the source", h.locationSource.started)

        h.relay.handleNavRoute(sampleRouteData(commandIdB))
        jobB.join()

        val resultB = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-B" })
        assertEquals("ok", resultB.getString("status"))
        assertTrue("B's commit must re-assert the source arrival just stopped", h.locationSource.started)
    }

    // ---- reroute -------------------------------------------------------

    @Test
    fun `off-route sends a reroute echoing the stored destination, and a second within cooldown sends nothing`() =
        runBlocking {
            val h = Harness()
            commitRoute(h)
            h.clockMillis = 1_000

            h.locationSource.fix(31.2320, 121.4710) // ~95 m cross-track -> off-route
            assertEquals(listOf(REROUTE_SENDING_TEXT to false), h.speaker.spoken)
            awaitCondition(description = "reroute nav.request sent") { h.sent.size == 2 }

            val rerouteReq = JSONObject(h.sent[1])
            assertEquals("reroute", rerouteReq.getString("reason"))
            val expectedDestination = CoordinateDatum.wgs84ToGcj02(wgsDestination)
            assertEquals(expectedDestination.lat, rerouteReq.getJSONObject("destination").getDouble("lat"), 1e-9)
            assertEquals(expectedDestination.lon, rerouteReq.getJSONObject("destination").getDouble("lon"), 1e-9)
            assertEquals("测试终点", rerouteReq.getString("destinationName"))
            assertFalse(rerouteReq.has("query"))

            val commandId = rerouteReq.getString("commandId")
            h.relay.handleNavRoute(sampleRouteData(commandId))
            awaitCondition(description = "reroute commit re-asserts the source") { h.locationSource.startCalls >= 2 }

            // Still inside the 20 s cooldown from the send stamped at clockMillis=1000.
            h.clockMillis += 5_000
            h.locationSource.fix(31.2320, 121.4710)
            assertEquals("no new request while the cooldown is still active", 2, h.sent.size)
        }

    @Test
    fun `reroute failure speaks the failure line, clears the route, and stops the source`() = runBlocking {
        val h = Harness()
        commitRoute(h)

        h.locationSource.fix(31.2320, 121.4710) // off-route -> reroute sent
        awaitCondition(description = "reroute nav.request sent") { h.sent.size == 2 }
        val commandId = JSONObject(h.sent[1]).getString("commandId")

        h.relay.handleNavError(commandId, "route.unavailable")
        awaitCondition(description = "failure line spoken") { h.speaker.spoken.size == 2 }
        assertEquals(REROUTE_FAILED_TEXT to false, h.speaker.spoken[1])
        awaitCondition(description = "guidance cleared") { h.guidanceUpdates.isNotEmpty() && h.guidanceUpdates.last() == null }
        assertFalse(h.locationSource.started)

        h.controller.handleCommand("cmd-stop-after-fail", "navigation.stop", null)
        val stopResult = JSONObject(h.results.last())
        assertEquals("failed", stopResult.getString("status"))
        assertEquals("navigation.notActive", stopResult.getString("reason"))
    }

    @Test
    fun `a reroute answer arriving after navigation stop is ignored, and the latch still clears`() = runBlocking {
        val h = Harness()
        commitRoute(h)

        h.locationSource.fix(31.2320, 121.4710) // off-route -> reroute sent
        awaitCondition(description = "reroute nav.request sent") { h.sent.size == 2 }
        val commandId = JSONObject(h.sent[1]).getString("commandId")

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)
        assertEquals("ok", JSONObject(h.results.last()).getString("status"))
        h.guidanceUpdates.clear()
        h.speaker.spoken.clear()

        h.relay.handleNavRoute(sampleRouteData(commandId))
        assertConditionHoldsFor(windowMs = 250, description = "a stale reroute answer must not revive guidance") {
            h.guidanceUpdates.isEmpty() && h.speaker.spoken.isEmpty() && !h.locationSource.started
        }
    }

    @Test
    fun `a fresh start after stop does not inherit the previous route's cooldown`() = runBlocking {
        val h = Harness()
        commitRoute(h, commandId = "cmd-1")
        h.clockMillis = 1_000
        h.locationSource.fix(31.2320, 121.4710) // off-route -> reroute #1 sent, cooldown stamped at 1000
        awaitCondition(description = "reroute #1 sent") { h.sent.size == 2 }

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)
        assertEquals("ok", JSONObject(h.results.last()).getString("status"))

        h.clockMillis = 2_000 // well inside what would have been reroute #1's 20 s cooldown
        commitRoute(h, commandId = "cmd-2")

        h.locationSource.fix(31.2320, 121.4710) // immediately off-route again
        awaitCondition(description = "reroute #2 sent") { h.sent.size == 4 } // start,reroute,start,reroute
        val newReroute = JSONObject(h.sent[3])
        assertEquals("reroute", newReroute.getString("reason"))
    }

    // Fix-round-1 regression coverage (Important #2): arrival deliberately
    // does not bump the generation (an unrelated concurrent start must still
    // be free to land), so a reroute already in flight for THIS SAME route
    // needs its own route-null guard — the generation check alone is not
    // enough to stop its eventual answer from reviving what arrival just
    // retired.

    @Test
    fun `a reroute answer landing after arrival on the same route does not revive guidance on success`() =
        runBlocking {
            val h = Harness()
            commitRoute(h)

            h.locationSource.fix(31.2320, 121.4710) // off-route, not yet arrived -> reroute sent
            awaitCondition(description = "reroute nav.request sent") { h.sent.size == 2 }
            val rerouteCommandId = JSONObject(h.sent[1]).getString("commandId")

            // The very next fix arrives, while the reroute above is still in flight.
            h.locationSource.fix(31.24, 121.47)
            assertTrue(h.speaker.spoken.contains(ARRIVED_TEXT to false))
            assertEquals(null, h.guidanceUpdates.last())
            assertFalse(h.locationSource.started)

            h.guidanceUpdates.clear()
            h.speaker.spoken.clear()

            h.relay.handleNavRoute(sampleRouteData(rerouteCommandId)) // succeeds AFTER arrival retired the route
            assertConditionHoldsFor(windowMs = 250, description = "a post-arrival reroute success must not revive guidance") {
                h.guidanceUpdates.isEmpty() && !h.locationSource.started
            }
        }

    @Test
    fun `a reroute answer landing after arrival on the same route does not speak a spurious failure`() =
        runBlocking {
            val h = Harness()
            commitRoute(h)

            h.locationSource.fix(31.2320, 121.4710) // off-route, not yet arrived -> reroute sent
            awaitCondition(description = "reroute nav.request sent") { h.sent.size == 2 }
            val rerouteCommandId = JSONObject(h.sent[1]).getString("commandId")

            // The very next fix arrives, while the reroute above is still in flight.
            h.locationSource.fix(31.24, 121.47)
            assertTrue(h.speaker.spoken.contains(ARRIVED_TEXT to false))
            assertFalse(h.locationSource.started)

            h.guidanceUpdates.clear()
            h.speaker.spoken.clear()

            h.relay.handleNavError(rerouteCommandId, "route.unavailable") // fails AFTER arrival retired the route
            assertConditionHoldsFor(
                windowMs = 250,
                description = "a post-arrival reroute failure must not speak the failure line"
            ) {
                h.speaker.spoken.isEmpty() && h.guidanceUpdates.isEmpty() && !h.locationSource.started
            }
        }

    // ---- teardown -------------------------------------------------------

    @Test
    fun `teardown silently stops an active route with no speech and no result`() = runBlocking {
        val h = Harness()
        commitRoute(h)
        h.speaker.spoken.clear()
        h.results.clear()
        h.guidanceUpdates.clear()

        h.controller.teardown()

        assertTrue(h.speaker.spoken.isEmpty())
        assertTrue(h.results.isEmpty())
        assertEquals(listOf<NavGuidanceState?>(null), h.guidanceUpdates)
        assertFalse(h.locationSource.started)

        h.controller.handleCommand("cmd-after-teardown", "navigation.stop", null)
        assertEquals("failed", JSONObject(h.results.last()).getString("status"))
    }

    @Test
    fun `teardown with nothing active still silently stops the source and clears guidance`() = runBlocking {
        val h = Harness()

        h.controller.teardown()

        // No speech, no result — teardown never has anyone to talk to. The
        // source-stop/guidance-clear DO run unconditionally (see teardown's
        // KDoc) but are harmless no-ops when nothing was ever active.
        assertTrue(h.results.isEmpty())
        assertTrue(h.speaker.spoken.isEmpty())
        assertEquals(listOf<NavGuidanceState?>(null), h.guidanceUpdates)
        assertFalse(h.locationSource.started)
    }

    // Fix-round-1 regression coverage (Important #1): teardown() used to
    // early-return whenever `route == null`, which includes the exact
    // instant a start is suspended awaiting the relay's answer (its first
    // fix already resolved `route` is still null). That skipped the
    // generation bump entirely, so the eventual answer could still commit —
    // starting GPS on a session nothing can ever stop again.
    @Test
    fun `teardown while a start is suspended at the relay await prevents its eventual answer from committing`() =
        runBlocking {
            val h = Harness()
            val job = launch(Dispatchers.Default) {
                h.controller.handleCommand("cmd-1", "navigation.start", "人民广场")
            }
            feedFixUntil(h, neutralWgsFix, description = "nav.request sent") { h.sent.size == 1 }
            val commandId = JSONObject(h.sent[0]).getString("commandId")

            h.controller.teardown() // the socket dies while suspended awaiting the relay
            assertFalse("teardown must stop the source even though no route was ever committed", h.locationSource.started)

            h.relay.handleNavRoute(sampleRouteData(commandId)) // the relay answers anyway, after teardown
            job.join()

            assertFalse("a torn-down attempt's late answer must never restart the source", h.locationSource.started)
            assertTrue("nor may it publish a committed route's guidance", h.guidanceUpdates.none { it != null })
        }
}
