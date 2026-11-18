package io.github.henrycooper86.max.navigation

import org.junit.Assert.*
import org.junit.Test

class MapPresentationTest {
    private val route = NavigationRoute("终点", LatLon(31.24, 121.47),
        listOf(LatLon(31.23, 121.47), LatLon(31.24, 121.47)), emptyList(), 1000.0, 120.0)

    @Test fun `consent gates all sdk access even with a configured key`() {
        assertEquals(MapAvailability.CONSENT_REQUIRED, mapAvailability(false, "configured", route))
    }
    @Test fun `missing key and malformed geometry remain truthful fallbacks`() {
        assertEquals(MapAvailability.MISSING_KEY, mapAvailability(true, "", route))
        assertEquals(MapAvailability.INVALID_ROUTE, mapAvailability(true, "key", route.copy(polyline = listOf(LatLon(Double.NaN, 0.0), LatLon(1.0, 0.0)))))
        assertEquals(MapAvailability.INVALID_ROUTE, mapAvailability(true, "key", route.copy(polyline = emptyList())))
        assertEquals(MapAvailability.INVALID_ROUTE, mapAvailability(true, "key", route.copy(destination = LatLon(91.0, 0.0))))
    }
    @Test fun `route geometry remains in GCJ02 without another conversion`() {
        assertEquals(MapAvailability.READY, mapAvailability(true, "key", route))
        assertEquals(LatLon(31.23, 121.47), route.polyline.first())
    }
}
