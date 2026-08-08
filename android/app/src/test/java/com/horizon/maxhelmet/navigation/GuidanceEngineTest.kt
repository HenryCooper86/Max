package com.horizon.maxhelmet.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Kotlin port of tests/guidance.test.ts's table (and its Swift superset,
 * ios/MaxHelmetTests/GuidanceEngineTests.swift) — same coordinate literals,
 * so this file can be diffed against either sibling directly. See
 * GuidanceEngine.kt's port-contract comment for the six rules this table
 * exercises.
 */
class GuidanceEngineTest {

    // Straight north-bound route along lon 121.47: 31.23 -> 31.24 (~1109 m),
    // one right turn at 31.235 (555 m in), arriving at 31.24 (1109 m in).
    private fun route(): NavigationRoute = NavigationRoute(
        destinationName = "测试终点",
        destination = LatLon(31.24, 121.47),
        polyline = listOf(
            LatLon(31.23, 121.47),
            LatLon(31.235, 121.47),
            LatLon(31.24, 121.47)
        ),
        steps = listOf(
            ManeuverStep(instruction = "右转", coordinate = LatLon(31.235, 121.47), alongRouteMeters = 555.0),
            ManeuverStep(instruction = "到达终点", coordinate = LatLon(31.24, 121.47), alongRouteMeters = 1109.0)
        ),
        distanceMeters = 1109.0,
        etaSeconds = 240.0
    )

    private fun fresh(): GuidanceProgress = GuidanceProgress(maneuverIndex = 0, firedThresholds = emptySet(), arrived = false)

    private fun step(lat: Double, progress: GuidanceProgress): GuidanceUpdate =
        GuidanceEngine.step(LatLon(lat, 121.47), route(), progress)

    private fun assertMatchesFarNearTemplate(prompt: String?) {
        assertTrue("expected a spoken prompt", prompt != null)
        assertTrue("\"$prompt\" does not match the far/near template", Regex("^前方\\d+米，右转$").matches(prompt!!))
    }

    @Test
    fun `haversine measures across the test route`() {
        val a = LatLon(31.23, 121.47)
        val b = LatLon(31.24, 121.47)
        // vitest's toBeCloseTo(1109, -1): delta 15 (matches Swift's accuracy 5, widened per brief).
        assertEquals(1109.0, Geo.haversineMeters(a, b), 15.0)
    }

    @Test
    fun `reports distance to the first maneuver from the start`() {
        val u = step(31.23, fresh())
        assertTrue(u.distanceToManeuverMeters > 540)
        assertTrue(u.distanceToManeuverMeters < 570)
        assertFalse(u.offRoute)
        assertNull(u.spokenPrompt) // 555 m > far threshold
        assertEquals("右转", u.currentInstruction)
    }

    @Test
    fun `fires far once then near once then now once`() {
        var progress = fresh()
        fun at(lat: Double): GuidanceUpdate {
            val u = step(lat, progress)
            progress = u.progress
            return u
        }

        val far = at(31.2320) // ~333 m -> far
        assertMatchesFarNearTemplate(far.spokenPrompt)
        assertEquals(PromptThreshold.FAR, far.firedThreshold)

        val between = at(31.2325) // between far and near: nothing fires
        assertNull(between.spokenPrompt)
        assertNull(between.firedThreshold)

        val near = at(31.2340) // ~111 m -> near
        assertMatchesFarNearTemplate(near.spokenPrompt)
        assertEquals(PromptThreshold.NEAR, near.firedThreshold)

        val now = at(31.2348) // ~22 m -> now
        assertEquals("右转", now.spokenPrompt)
        assertEquals(PromptThreshold.NOW, now.firedThreshold)

        val repeat = at(31.2348) // repeat fix at the same position: fires nothing
        assertNull(repeat.spokenPrompt)
        assertNull(repeat.firedThreshold)
    }

    @Test
    fun `now prompt fires before advancement on the same tick`() {
        // ~22 m along-route from a fresh start: crosses "now" and the 30 m
        // reached radius in the same fix. The prompt for the maneuver just
        // completed must still be reported alongside the post-advance progress.
        val u = step(31.2348, fresh())
        assertEquals("右转", u.spokenPrompt)
        assertEquals(PromptThreshold.NOW, u.firedThreshold)
        assertEquals(1, u.progress.maneuverIndex)
    }

    @Test
    fun `advances past the maneuver and clears thresholds`() {
        var progress = fresh()
        for (lat in listOf(31.2320, 31.2340, 31.2348, 31.2355)) {
            progress = step(lat, progress).progress
        }
        assertEquals(1, progress.maneuverIndex)
        assertEquals(emptySet<PromptThreshold>(), progress.firedThresholds)

        val u = step(31.2355, progress)
        assertEquals("到达终点", u.currentInstruction)
    }

    @Test
    fun `off-route flags beyond 50 m cross-track and speaks no prompt`() {
        // 0.001 degree lon at lat 31.232 is ~95 m east of the line.
        val u = GuidanceEngine.step(LatLon(31.2320, 121.4710), route(), fresh())
        assertTrue(u.offRoute)
        assertNull(u.spokenPrompt)
        assertNull(u.firedThreshold)
    }

    @Test
    fun `off-route freezes maneuverIndex and firedThresholds even past the maneuver`() {
        // Along-route projection lands past the first maneuver's 555 m, but
        // ~95 m cross-track keeps this fix off-route: progression must freeze,
        // carrying the seeded firedThresholds through unchanged.
        val seeded = GuidanceProgress(
            maneuverIndex = 0,
            firedThresholds = setOf(PromptThreshold.FAR, PromptThreshold.NEAR),
            arrived = false
        )
        val u = GuidanceEngine.step(LatLon(31.2360, 121.4710), route(), seeded)
        assertTrue(u.offRoute)
        assertEquals(0, u.progress.maneuverIndex)
        assertEquals(setOf(PromptThreshold.FAR, PromptThreshold.NEAR), u.progress.firedThresholds)
    }

    @Test
    fun `arrives within 30 m of the destination and stays sticky`() {
        var progress = fresh()
        for (lat in listOf(31.2320, 31.2340, 31.2348, 31.2355, 31.2399)) {
            progress = step(lat, progress).progress
        }
        assertTrue(progress.arrived)

        // Sticky: a later far-away fix must not un-arrive the rider (rule 4).
        val farAway = step(31.20, progress)
        assertTrue(farAway.arrived)
        assertTrue(farAway.progress.arrived)
    }

    @Test
    fun `scales remaining time from remaining distance`() {
        val u = step(31.235, fresh())
        assertTrue(u.remainingMeters > 520)
        assertTrue(u.remainingMeters < 590)
        assertTrue(u.remainingSeconds > 110)
        assertTrue(u.remainingSeconds < 130)
    }
}
