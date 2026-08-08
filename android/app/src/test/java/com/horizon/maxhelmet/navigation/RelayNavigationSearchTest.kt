package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.NavRouteData
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayNavigationSearchTest {

    private val origin = LatLon(31.20, 121.40)

    private fun sampleRouteData(commandId: String): NavRouteData = NavRouteData(
        commandId = commandId,
        destinationName = "人民广场",
        destination = LatLon(31.23, 121.47),
        polyline = listOf(LatLon(31.20, 121.40), LatLon(31.21, 121.42), LatLon(31.23, 121.47)),
        steps = listOf(
            ManeuverStep("直行300米", LatLon(31.205, 121.405), 0.0),
            ManeuverStep("右转进入人民路", LatLon(31.215, 121.425), 300.0)
        ),
        distanceMeters = 1500.5,
        etaSeconds = 605.0
    )

    private fun expectedRoute(commandId: String): NavigationRoute {
        val data = sampleRouteData(commandId)
        return NavigationRoute(
            destinationName = data.destinationName,
            destination = data.destination,
            polyline = data.polyline,
            steps = data.steps,
            distanceMeters = data.distanceMeters,
            etaSeconds = data.etaSeconds
        )
    }

    /** Bounded busy-wait for an observable condition instead of an arbitrary
     *  Thread.sleep hope. Only sound because the coroutine under test runs on
     *  Dispatchers.Default (a real thread pool), never runBlocking's own
     *  thread — otherwise this poll loop would starve it. */
    private fun awaitCondition(timeoutMs: Long = 2_000, description: String = "condition", check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!check()) {
            if (System.currentTimeMillis() > deadline) {
                throw AssertionError("Timed out waiting for $description")
            }
            Thread.sleep(5)
        }
    }

    @Test
    fun `route sends a start request and resumes with the wire route on a matching answer`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) })

        val resultDeferred = async(Dispatchers.Default) { relay.route("人民广场", origin) }
        awaitCondition { sent.size == 1 }

        val requestJson = JSONObject(sent[0])
        assertEquals("nav.request", requestJson.getString("type"))
        assertEquals("start", requestJson.getString("reason"))
        assertEquals(origin.lat, requestJson.getJSONObject("origin").getDouble("lat"), 0.0)
        assertEquals(origin.lon, requestJson.getJSONObject("origin").getDouble("lon"), 0.0)
        assertEquals("人民广场", requestJson.getString("query"))
        assertFalse(requestJson.has("destination"))
        assertFalse(requestJson.has("destinationName"))

        val commandId = requestJson.getString("commandId")
        assertTrue(commandId.startsWith("nav-"))

        launch(Dispatchers.Default) {
            delay(20)
            relay.handleNavRoute(sampleRouteData(commandId))
        }

        val result = resultDeferred.await()
        assertEquals(expectedRoute(commandId), result)
        // GCJ-02 passthrough: exact equality with the wire input, no datum shift.
        assertEquals(31.23, result?.destination?.lat ?: 0.0, 0.0)
        assertEquals(121.47, result?.destination?.lon ?: 0.0, 0.0)
    }

    @Test
    fun `handleNavError resumes null`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) })

        val resultDeferred = async(Dispatchers.Default) { relay.route("人民广场", origin) }
        awaitCondition { sent.size == 1 }
        val commandId = JSONObject(sent[0]).getString("commandId")

        launch(Dispatchers.Default) {
            delay(20)
            relay.handleNavError(commandId, "destination.notFound")
        }

        assertNull(resultDeferred.await())
    }

    @Test
    fun `a mismatched commandId is ignored and the request times out to null`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) }, timeoutMillis = 50)

        val resultDeferred = async(Dispatchers.Default) { relay.route("人民广场", origin) }
        awaitCondition { sent.size == 1 }

        // A stale/unrelated answer must not resolve the pending request; it
        // keeps waiting for its own answer or its own timeout.
        relay.handleNavRoute(sampleRouteData("nav-someone-else"))
        relay.handleNavError("nav-someone-else", "destination.notFound")

        assertNull(resultDeferred.await())
    }

    @Test
    fun `failPending resumes null`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) })

        val resultDeferred = async(Dispatchers.Default) { relay.route("人民广场", origin) }
        awaitCondition { sent.size == 1 }

        launch(Dispatchers.Default) {
            delay(20)
            relay.failPending()
        }

        assertNull(resultDeferred.await())
    }

    @Test
    fun `a second concurrent route call fails the first and proceeds`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) })

        val firstResultDeferred = async(Dispatchers.Default) { relay.route("第一目的地", origin) }
        awaitCondition { sent.size == 1 }

        val secondResultDeferred = async(Dispatchers.Default) { relay.route("第二目的地", origin) }
        // Poll `sent` before completing the second: proves the second request
        // was actually dispatched, not merely that the first was preempted.
        awaitCondition { sent.size == 2 }

        assertNull(firstResultDeferred.await())

        val secondCommandId = JSONObject(sent[1]).getString("commandId")
        relay.handleNavRoute(sampleRouteData(secondCommandId))

        assertEquals(expectedRoute(secondCommandId), secondResultDeferred.await())
    }

    @Test
    fun `two truly parallel route calls never orphan the loser's deferred`() = runBlocking {
        // Fix-round-1 regression coverage: the original awaitAnswer called
        // failPending() (one lock acquisition) and THEN re-locked to
        // register the new request (a second, separate acquisition). Two
        // real threads racing through that gap could both register after
        // both had already found nothing pending to preempt, silently
        // orphaning one deferred until its own full timeoutMillis elapsed.
        // Unlike the "second concurrent route call" test above, this one
        // does NOT poll `sent` between starting the two calls — their
        // prologues are launched together, unserialized, on Dispatchers.Default
        // real threads, so whichever wins the registration race is not
        // predetermined by the test.
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) }, timeoutMillis = 5_000)
        // NavigationRoute carries no commandId, so the assembled route is
        // byte-for-byte identical regardless of which of the two commandIds
        // it was built from — one fixed expectation covers whichever call
        // turns out to be the survivor.
        val expected = expectedRoute("nav-irrelevant-content-identical-either-way")

        val startedAt = System.currentTimeMillis()
        val firstResultDeferred = async(Dispatchers.Default) { relay.route("第一目的地", origin) }
        val secondResultDeferred = async(Dispatchers.Default) { relay.route("第二目的地", origin) }

        awaitCondition { sent.size == 2 }

        // By the time both sends are observed, whichever call lost the
        // registration race has already been preempted to null (the winner
        // completes the loser's deferred before it ever calls send() for its
        // own request) — so trying both commandIds here is safe: the live
        // one resolves with a real route, the dead one is a no-op mismatch.
        sent.map { JSONObject(it).getString("commandId") }.forEach { commandId ->
            relay.handleNavRoute(sampleRouteData(commandId))
        }

        val firstResult = firstResultDeferred.await()
        val secondResult = secondResultDeferred.await()
        val elapsedMs = System.currentTimeMillis() - startedAt

        // Both callers must resolve promptly, well under the 5s timeout: an
        // orphaned-deferred regression would dead-wait the loser out to the
        // full timeout instead of resolving it immediately on preemption.
        assertTrue("resolved in ${elapsedMs}ms, expected well under 1000ms", elapsedMs < 1_000)

        val results = listOf(firstResult, secondResult)
        assertEquals("exactly one call must be preempted to null", 1, results.count { it == null })
        assertEquals("exactly one call must receive the routed answer", 1, results.count { it != null })
        assertEquals(expected, results.single { it != null })
    }

    @Test
    fun `reroute sends a reroute request with destination and destinationName and no query`() = runBlocking {
        val sent = CopyOnWriteArrayList<String>()
        val relay = RelayNavigationSearch(send = { sent.add(it) }, timeoutMillis = 50)
        val destination = LatLon(31.23, 121.47)

        val resultDeferred = async(Dispatchers.Default) { relay.reroute(destination, "人民广场", origin) }
        awaitCondition { sent.size == 1 }

        val requestJson = JSONObject(sent[0])
        assertEquals("nav.request", requestJson.getString("type"))
        assertEquals("reroute", requestJson.getString("reason"))
        assertEquals(origin.lat, requestJson.getJSONObject("origin").getDouble("lat"), 0.0)
        assertEquals(origin.lon, requestJson.getJSONObject("origin").getDouble("lon"), 0.0)
        assertEquals(destination.lat, requestJson.getJSONObject("destination").getDouble("lat"), 0.0)
        assertEquals(destination.lon, requestJson.getJSONObject("destination").getDouble("lon"), 0.0)
        assertEquals("人民广场", requestJson.getString("destinationName"))
        assertFalse(requestJson.has("query"))

        // Let the unanswered request time out (50ms) instead of leaving a
        // child coroutine running past this test function's return.
        assertNull(resultDeferred.await())
    }
}
