package io.github.henrycooper86.max.navigation

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HudCastClientTest {
    @Test fun `explicit disconnect persists while navigation ending retains the bond`() {
        var stored = """{"address":"192.168.50.9:8080","token":"test-token","enabled":true}"""
        val client = HudCastClient(readBond = { stored }, writeBond = { stored = it; true })
        client.update(null)
        assertTrue(JSONObject(stored).getBoolean("enabled"))
        client.stop()
        assertFalse(JSONObject(stored).getBoolean("enabled"))
        val restored = HudCastClient(readBond = { stored }, writeBond = { stored = it; true })
        assertEquals("192.168.50.9:8080", restored.savedAddress)
        val points = listOf(LatLon(31.0, 121.0), LatLon(31.1, 121.1))
        val route = NavigationRoute("终点", points.last(), points, emptyList(), 2000.0, 300.0)
        restored.update(NavGuidanceState("终点", "直行", 120.0, 2000.0, 300.0, false, false, route, points.first()))
        assertFalse(restored.state.value.active)
        restored.stop()
    }

    @Test fun `only local addresses with explicit ports are accepted`() {
        assertEquals("http://192.168.1.20:8080/cast/socket", HudCastClient.endpoint("192.168.1.20:8080"))
        assertNotNull(HudCastClient.endpoint("rdk.local:8080"))
        for (address in listOf("example.com:8080", "192.168.1.20", "user@192.168.1.20:8080", "10.1.2.3.evil:8080", "192.168.1.20:8080/path")) {
            assertNull(address, HudCastClient.endpoint(address))
        }
    }
    @Test fun `frames preserve GCJ02 endpoints and bound geometry`() {
        val points = (0..4096).map { LatLon(31.0 + it / 100000.0, 121.47) }
        val route = NavigationRoute("终点", points.last(), points, listOf(ManeuverStep("右转", points[10], 120.0)), 2000.0, 300.0)
        val guidance = NavGuidanceState("终点", "右转", 120.0, 2000.0, 300.0, false, false, route, points.first())
        val frame = JSONObject(HudCastClient.frame(guidance, 7)!!)
        val line = frame.getJSONArray("polyline")
        assertEquals(2048, line.length())
        assertEquals(points.first().lat, line.getJSONObject(0).getDouble("lat"), 0.0)
        assertEquals(points.last().lat, line.getJSONObject(2047).getDouble("lat"), 0.0)
        assertEquals(7, frame.getInt("sequence"))
        assertEquals("右转", frame.getString("instruction"))
        val turns = frame.getJSONArray("turns")
        assertEquals(1, turns.length())
        assertEquals(120.0, turns.getJSONObject(0).getDouble("distance"), 0.0)
        assertEquals(points[10].lat, turns.getJSONObject(0).getDouble("lat"), 0.0)
        assertNull(HudCastClient.frame(guidance.copy(confirmationId = "pending"), 8))
        assertNull(HudCastClient.frame(guidance.copy(route = null), 8))
        assertNull(HudCastClient.frame(guidance.copy(remainingSeconds = Double.NaN), 8))
    }
}
