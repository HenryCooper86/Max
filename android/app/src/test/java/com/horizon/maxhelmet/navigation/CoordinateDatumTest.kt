package com.horizon.maxhelmet.navigation

import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoordinateDatumTest {
    @Test
    fun `leaves points outside china untouched`() {
        val tokyo = LatLon(35.683861, 139.77492)
        assertEquals(tokyo, CoordinateDatum.wgs84ToGcj02(tokyo))
    }

    @Test
    fun `matches the published shanghai vector`() {
        // Same eviltransform vector tests/geo.test.ts and the Swift port pin.
        val gcj = CoordinateDatum.wgs84ToGcj02(LatLon(31.1774276, 121.5272106))
        assertEquals(31.17530398, gcj.lat, 1e-4)
        assertEquals(121.53146073, gcj.lon, 1e-4)
    }

    @Test
    fun `china offset is plausible`() {
        // Degree-hypot bound matches tests/geo.test.ts (0.0009..0.008).
        val wgs = LatLon(31.2304, 121.4737)
        val gcj = CoordinateDatum.wgs84ToGcj02(wgs)
        val offset = hypot(gcj.lat - wgs.lat, gcj.lon - wgs.lon)
        assertTrue("offset $offset too small", offset > 0.0009)
        assertTrue("offset $offset too large", offset < 0.008)
    }
}
