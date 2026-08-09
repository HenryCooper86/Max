package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.NavRouteData
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
        hasPermission: () -> Boolean = { true },
        // Nav-fast-follow Task 4: overridable so the hoist test can inject a
        // short-but-generous relay timeout — bounding how long a pre-hoist
        // regression would take to resolve on its own, without the whole
        // suite riding out the real default (~7 s, under the relay's own 8 s
        // device backstop).
        relayTimeoutMillis: Long = 7_000
    ) {
        var clockMillis: Long = 0L
        val sent = CopyOnWriteArrayList<String>()
        val results = CopyOnWriteArrayList<String>()
        val guidanceUpdates = CopyOnWriteArrayList<NavGuidanceState?>()
        val locationSource = FakeLocationSource()
        val speaker = FakeSpeaker()
        val relay = RelayNavigationSearch(send = { sent.add(it) }, timeoutMillis = relayTimeoutMillis)
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

    // Nav-parity-closure Task 4: stop-cancels. No route has committed yet
    // (unlike the tests above, nothing is navigating at all), but a start is
    // genuinely in flight — mirrors web's `cancelHeldStart` semantics and
    // iOS Task 3's `stopGuidance`: the stop itself succeeds, and the
    // cancelled start gets its own truthful `navigation.cancelled` result
    // rather than hanging until its own timeout.

    @Test
    fun `stop mid first-fix cancels the in-flight start, and a later idle stop is not stuck ok`() = runBlocking {
        val h = Harness(firstFixTimeoutMillis = 5_000) // long enough that the timeout never fires in this test
        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-1", "navigation.start", "终点")
        }
        awaitCondition(description = "start reaches the first-fix wait") { h.locationSource.started }

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)
        val stopResult = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-stop" })
        assertEquals("ok", stopResult.getString("status"))

        job.join()
        val startResult = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-1" })
        assertEquals("failed", startResult.getString("status"))
        assertEquals("navigation.cancelled", startResult.getString("reason"))
        assertTrue("nothing installs", h.guidanceUpdates.none { it != null })
        assertFalse("the source is stopped", h.locationSource.started)
        assertTrue("no nav.request was ever sent — cancelled before reaching the relay", h.sent.isEmpty())

        // The stop above already cleared `starting` alongside its own
        // generation bump — a genuinely idle stop right after must not find
        // it stuck true (the same lesson iOS's fix round paid for).
        h.controller.handleCommand("cmd-idle-stop", "navigation.stop", null)
        val idleStopResult = JSONObject(h.results.last())
        assertEquals("failed", idleStopResult.getString("status"))
        assertEquals("navigation.notActive", idleStopResult.getString("reason"))
    }

    @Test
    fun `stop mid relay-await cancels the in-flight start via search-failPending`() = runBlocking {
        val h = Harness()
        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-1", "navigation.start", "终点")
        }
        feedFixUntil(h, neutralWgsFix, description = "nav.request sent") { h.sent.size == 1 }

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)
        val stopResult = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-stop" })
        assertEquals("ok", stopResult.getString("status"))

        // Without search.failPending() wired through, this would hang until
        // RelayNavigationSearch's own 7 s timeout instead of resolving here.
        job.join()
        val startResult = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-1" })
        assertEquals("failed", startResult.getString("status"))
        assertEquals("navigation.cancelled", startResult.getString("reason"))
        assertTrue("nothing installs", h.guidanceUpdates.none { it != null })
        assertFalse("the source is stopped", h.locationSource.started)
    }

    // Nav-fast-follow Task 4: the parity-review hoist. The test above only
    // covers the "no route yet" branch, which already called
    // `search.failPending()` pre-hoist. This is the ROUTE-ACTIVE branch: a
    // stop there must fail a second, in-flight start's held search too, not
    // just tear down the active route — otherwise the rider hears
    // "已停止导航。" and then, up to the relay's own ~7 s timeout later, the
    // superseded start's own "已取消导航。" arrives as a stray non-sequitur.
    @Test
    fun `stop with an active route fails an in-flight second start's pending search promptly`() = runBlocking {
        // Generous relative to the bounded check below (mirrors
        // RelayNavigationSearch's real default): pre-hoist, B is only
        // resolved once this fires — the bounded check below must catch it
        // resolved long before that, not ride it out.
        val h = Harness(relayTimeoutMillis = 5_000)
        commitRoute(h, commandId = "cmd-A") // route A resolves and becomes the committed, active route

        // A second start for a NEW destination is suspended at the relay
        // await while route A is still active — a committed route AND an
        // in-flight second start coexisting.
        val jobB = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-B", "navigation.start", "第二目的地")
        }
        val baseline = h.sent.size
        feedFixUntil(h, neutralWgsFix, description = "B's nav.request sent") { h.sent.size > baseline }

        h.controller.handleCommand("cmd-stop", "navigation.stop", null)
        val stopResult = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-stop" })
        assertEquals("ok", stopResult.getString("status"))
        assertTrue(
            "the active route's own stop confirmation still fires",
            h.speaker.spoken.contains(STOP_TEXT to false)
        )

        // The bounded-wait assertion: B must already have resolved well
        // under the relay's own (generous) injected timeout — this is what
        // fails RED promptly (B still pending here) rather than as a slow
        // hang riding out relayTimeoutMillis.
        withTimeout(1_000) { jobB.join() }
        val resultB = JSONObject(h.results.single { JSONObject(it).getString("commandId") == "cmd-B" })
        assertEquals("failed", resultB.getString("status"))
        assertEquals("navigation.cancelled", resultB.getString("reason"))

        // Safety premise (Global Constraints): the stop's generation bump
        // (plus route == null once the route-active branch clears it) makes
        // this stale answer fail performReroute's own guard (generation
        // match AND route != null), so failing it early can never trigger
        // the reroute-failure teardown speech.
        assertFalse(
            "no reroute-teardown speech from the failed pending search",
            h.speaker.spoken.contains(REROUTE_FAILED_TEXT to false)
        )
    }

    // Nav-fast-follow Task 4 item 2 (deferred-identity watchdog pin) is
    // deliberately NOT here. Investigated thoroughly — including writing
    // and running the scenario below — and confirmed the premise is false
    // for Android's actual implementation; see the task report for the
    // full proof. Summary: `RerouteAttempt.generation` is captured at
    // reroute-SEND time, and `performReroute`'s failure branch only runs
    // its OWN generation-bumping "else" path when that captured value still
    // equals `navigationGeneration` at ANSWER time. Any second
    // `navigation.start` (the would-be "B") bumps `navigationGeneration`
    // unconditionally the instant it begins — before it ever reaches its
    // own first-fix registration — so if B starts before the reroute's
    // answer arrives, the answer is always discarded as stale (the "else"
    // branch never runs, no further bump, no teardown speech: confirmed by
    // running exactly this ordering, which timed out waiting for
    // REROUTE_FAILED_TEXT). The only alternative ordering — triggering A's
    // off-route fix AFTER B is already parked, so the captured generation
    // matches — is blocked by a different wall: EVERY fix delivery
    // (including the one needed to trigger the reroute) runs through the
    // single shared `onFix`, whose first line unconditionally resolves
    // whatever first-fix wait is currently pending — so it would resolve
    // B's wait directly, violating "no fix fed to B" and collapsing the
    // scenario into something a generation-only guard would ALSO pass
    // (proven: nothing bumps `navigationGeneration` again after B's own
    // start in that ordering, so identity and generation are
    // indistinguishable there — no regression protection). Every other
    // generation-bump site (`handleStart`'s own supersession preempting via
    // `awaitFirstFix`'s registration, `handleStop`, `teardown`) already
    // resolves or steals any pending first-fix wait directly, as part of
    // its own bump — none of them exercise the watchdog's identity guard
    // either. `performReroute`'s failure branch is the only site that
    // doesn't touch `firstFixContinuation` at all, which is exactly what
    // makes it structurally unable to coexist with an untouched, parked B.

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
            // B's start already superseded A's generation by the time A's
            // search resolves null (RelayNavigationSearch's single-outstanding
            // slot preempted A) — a cancellation, not a genuine route failure.
            assertEquals("failed", resultA.getString("status"))
            assertEquals("navigation.cancelled", resultA.getString("reason"))

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

    // Final-review fix-wave regression coverage: the pre-await
    // `locationSource.start(::onFix)` in `handleStart` used to run outside
    // `lock`, and the first-fix watchdog used to guard on generation rather
    // than deferred identity. Both fakes below are built ad hoc (not via
    // [Harness]) since they exercise `NavigationController` directly against
    // a purpose-built `LocationSource`, not [FakeLocationSource].

    /** Detects concurrent entry into `start()` by widening the critical
     *  section with a sleep. Deterministic, not timing-sensitive: as long as
     *  `NavigationController` holds its lock around every call to
     *  `locationSource.start`, two genuinely parallel callers can never both
     *  be inside this method at once, however the sleep lands relative to
     *  the scheduler — the exclusion is a hard guarantee from the lock, not
     *  a probabilistic one from the timing. If the lock were ever dropped
     *  from the line-149 call site, two truly parallel
     *  `handleCommand("navigation.start")` invocations racing into this
     *  method would be caught with near certainty (a 30 ms window versus
     *  microsecond-scale scheduling jitter). */
    private class ExclusionProbeLocationSource : LocationSource {
        private val entered = AtomicBoolean(false)

        @Volatile
        var concurrentEntryDetected = false
            private set

        override fun start(onFix: (LatLon) -> Unit) {
            if (!entered.compareAndSet(false, true)) {
                concurrentEntryDetected = true
                return
            }
            try {
                Thread.sleep(30)
            } finally {
                entered.set(false)
            }
        }

        override fun stop() {}
    }

    @Test
    fun `two concurrent starts never enter locationSource-start concurrently`() = runBlocking {
        val probe = ExclusionProbeLocationSource()
        val results = CopyOnWriteArrayList<String>()
        val controller = NavigationController(
            search = RelayNavigationSearch(send = {}),
            locationSource = probe,
            speaker = FakeSpeaker(),
            sendResult = { results.add(it) },
            onGuidance = {},
            hasLocationPermission = { true },
            now = { 0L },
            firstFixTimeoutMillis = 50
        )

        val jobA = launch(Dispatchers.Default) { controller.handleCommand("cmd-A", "navigation.start", "第一目的地") }
        val jobB = launch(Dispatchers.Default) { controller.handleCommand("cmd-B", "navigation.start", "第二目的地") }
        withTimeout(2_000) {
            jobA.join()
            jobB.join()
        }

        assertFalse(
            "locationSource.start must never be entered concurrently — the pre-await call must stay inside the lock",
            probe.concurrentEntryDetected
        )
        // Both attempts still resolve on their own (no fix ever delivered, 50 ms timeout).
        assertEquals(2, results.size)
    }

    // Fix-round-1: `locationSource.start` used to live in its OWN
    // `synchronized(lock) { ... }` block, separate from the one right above
    // it that bumped the generation and set `starting = true`. A concurrent
    // stop/teardown landing in the gap BETWEEN those two blocks (the lock is
    // released and reacquired) would call `locationSource.stop()`, and then
    // this block's own `locationSource.start()` — carrying no generation
    // re-check — would unconditionally undo it, restarting a GPS listener
    // nothing could ever stop again: `stopSourceIfOrphaned`'s
    // `generation == navigationGeneration` guard forever refuses once this
    // generation is stale, so the listener leaks for the process lifetime,
    // feeding phantom fixes into the shared onFix/resolveFirstFix path.
    // `locationSource.start` is now folded into the SAME synchronized block
    // as the bump, closing that gap BY CONSTRUCTION: a `synchronized(lock)`
    // block is a JVM monitor critical section, so a concurrent stop/
    // teardown's own `synchronized(lock)` acquisition — from a genuinely
    // different THREAD — can only run entirely before this block or
    // entirely after it, never interleaved within it. That guarantee comes
    // from the JVM's mutual-exclusion semantics, not from timing, and the
    // cross-thread race it closes is not independently pinnable by a test:
    // it lived between two lock sections on ONE coroutine with no
    // suspension point between them, so only a genuinely parallel OS thread
    // could ever have raced it, and no seam in this file lets a test force
    // that interleaving deterministically without either a flaky,
    // timing-dependent test or a production-code seam added purely for
    // test control (out of scope).
    //
    // The test below pins a RELATED, deterministically triggerable shape
    // instead: a reentrant call arriving DURING `locationSource.start`
    // itself (legal — Kotlin's `synchronized` is a JVM monitor, reentrant
    // per-thread — this is a same-thread nested call, not a genuine
    // concurrent race, but it is the closest deterministic proxy available
    // for "a stop/teardown contemporaneous with this start's own setup").
    // Fix-round-2 (see handleStart's doc comment) hoists `generation`'s
    // capture to BEFORE this call, specifically so a reentrant bump landing
    // inside it is NOT folded into this start's own snapshot — proven here
    // by the RED/GREEN discriminator swap below (reason flips from
    // route.unavailable to navigation.cancelled once the hoist is in
    // place — verified against a temporary revert of the hoist, matching
    // this plan's RED-honesty standard). One property this reentrant proxy
    // does NOT (and structurally cannot) prove either way: whether the
    // source ends up literally stopped. `locationSource.start` is called
    // exactly once per attempt, and a naive "started" flag on this fake
    // would be set true as ITS OWN LAST ACTION, after the nested teardown's
    // `stop()` already ran — no generation discipline inside
    // `NavigationController` can retroactively undo a side effect a single,
    // already-atomic `locationSource.start` call performs internally. That
    // is a characteristic of testing a nested reentrant call this way, not a
    // regression of the cross-thread fix above: no REAL `LocationSource`
    // implementation calls back into the controller from within its own
    // `start()`, so this shape does not arise in production. Nav-fast-follow
    // Task 4 polish: this fake used to carry exactly that flag (`started`,
    // written in both `start()` and `stop()`) with nothing ever asserting
    // it — deleted rather than asserted, since the paragraph above is
    // precisely why its final value would prove nothing either way. What IS
    // asserted below is `stopCalls`, confirming teardown's own `stop()`
    // genuinely ran.
    @Test
    fun `a teardown reentering from within locationSource-start makes the start stale relative to itself`() =
        runBlocking {
            lateinit var controllerRef: NavigationController
            var teardownTriggered = false
            var stopCalls = 0
            val locationSource = object : LocationSource {
                override fun start(onFix: (LatLon) -> Unit) {
                    if (!teardownTriggered) {
                        teardownTriggered = true
                        controllerRef.teardown()
                    }
                }
                override fun stop() {
                    stopCalls++
                }
            }
            val results = CopyOnWriteArrayList<String>()
            val controller = NavigationController(
                search = RelayNavigationSearch(send = {}),
                locationSource = locationSource,
                speaker = FakeSpeaker(),
                sendResult = { results.add(it) },
                onGuidance = {},
                hasLocationPermission = { true },
                now = { 0L },
                firstFixTimeoutMillis = 50
            )
            controllerRef = controller

            val job = launch(Dispatchers.Default) {
                controller.handleCommand("cmd-1", "navigation.start", "人民广场")
            }
            // Bounded: a generation-only watchdog guard would hang this
            // start forever (its own registration outlives the teardown's
            // bump); a deferred-identity guard (see awaitFirstFix's own doc
            // comment) resolves it at the 50 ms timeout regardless.
            withTimeout(2_000) { job.join() }

            assertEquals(1, results.size)
            val result = JSONObject(results[0])
            // Fix-round-2: `generation` is captured BEFORE
            // `locationSource.start` runs, so the reentrant teardown's bump
            // is NOT folded into this start's own snapshot — this start is
            // stale relative to itself, exactly as if a genuinely concurrent
            // stop had landed before it (the invariant the hoist protects:
            // this attempt must never be mistaken for current again, which
            // also keeps a stale attempt from passing the commit guard onto
            // a torn-down session). A cancellation, not a genuine first-fix
            // failure — before the hoist this asserted
            // unsupported/route.unavailable instead (verified via a
            // temporary revert).
            assertEquals("failed", result.getString("status"))
            assertEquals("navigation.cancelled", result.getString("reason"))
            // teardown()'s own stop() ran exactly once; stopSourceIfOrphaned
            // declines (this generation is stale, by design — see the class
            // comment above for why that's a deliberate trade-off here, not
            // a leak `NavigationController` is responsible for closing).
            assertEquals(1, stopCalls)

            // teardown() must clear the `starting` latch alongside its own
            // generation bump (same lesson as the iOS fix round): a
            // genuinely idle stop right after must not find it stuck true.
            controller.handleCommand("cmd-idle-stop", "navigation.stop", null)
            val idleStopResult = JSONObject(results.last())
            assertEquals("failed", idleStopResult.getString("status"))
            assertEquals("navigation.notActive", idleStopResult.getString("reason"))
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
