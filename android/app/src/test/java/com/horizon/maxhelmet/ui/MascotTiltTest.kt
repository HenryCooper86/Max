package com.horizon.maxhelmet.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class MascotTiltTest {
    private val dt = 1f / 30f

    @Test
    fun aPhoneHeldStillLeavesTheBirdAtHome() {
        val tilt = MascotTilt()
        repeat(90) { tilt.step(-0.1f, 0.95f, dt) }
        assertEquals(0f, tilt.x, 0.001f)
        assertEquals(0f, tilt.y, 0.001f)
    }

    @Test
    fun tippingRightSlidesTheBirdRightThenItSettlesBack() {
        val tilt = MascotTilt()
        repeat(30) { tilt.step(0f, 1f, dt) }
        // Android reports the right edge going down as a negative x.
        repeat(15) { tilt.step(-0.25f, 0.97f, dt) }
        assertTrue(tilt.x > 0.2f)
        repeat(600) { tilt.step(-0.25f, 0.97f, dt) }
        assertEquals(0f, tilt.x, 0.02f)
    }

    @Test
    fun tippingTheTopAwaySlidesTheBirdUp() {
        val tilt = MascotTilt()
        repeat(30) { tilt.step(0f, 1f, dt) }
        repeat(15) { tilt.step(0f, 0.75f, dt) }
        assertTrue(tilt.y < -0.2f)
    }

    @Test
    fun aHardShakeNeverThrowsTheBirdPastItsLimit() {
        val tilt = MascotTilt()
        repeat(300) { index ->
            val swing = if (index % 2 == 0) 1f else -1f
            tilt.step(swing, swing, dt)
            assertTrue(abs(tilt.x) <= MascotTilt.LIMIT_X + 0.0001f)
            assertTrue(abs(tilt.y) <= MascotTilt.LIMIT_Y + 0.0001f)
        }
    }
}
