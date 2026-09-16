package com.horizon.maxhelmet.agent

import com.horizon.maxhelmet.navigation.LatLon
import com.horizon.maxhelmet.navigation.ManeuverStep
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavProtocolTest {

    // ---- generated contract --------------------------------------------

    @Test
    fun `nav wire events are registered in the generated contract`() {
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.NAV_ROUTE))
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.NAV_ERROR))
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.DEVICE_COMMAND))
        assertEquals(
            setOf("type", "commandId", "destinationName", "destination", "distanceMeters", "etaSeconds", "polyline", "steps"),
            SERVER_EVENT_REQUIRED_FIELDS["nav.route"]
        )
    }

    // ---- device.command ---------------------------------------------------

    @Test
    fun `parses a navigation-start device command with its query`() {
        val json = """
            {"type":"device.command","commandId":"cmd-1","action":"navigation.start","args":{"query":"人民广场"},"tier":"confirm"}
        """.trimIndent()

        assertEquals(
            AgentEvent.DeviceCommand("cmd-1", "navigation.start", "人民广场", mapOf("query" to "人民广场")),
            parseAgentEvent(json)
        )
    }

    @Test
    fun `parses a navigation-stop device command with no query`() {
        val json = """
            {"type":"device.command","commandId":"cmd-2","action":"navigation.stop","args":{},"tier":"confirm"}
        """.trimIndent()

        assertEquals(
            AgentEvent.DeviceCommand("cmd-2", "navigation.stop", null),
            parseAgentEvent(json)
        )
    }

    // ---- nav.route ----------------------------------------------------------

    private val fullNavRouteJson = """
        {
          "type": "nav.route",
          "commandId": "cmd-3",
          "destinationName": "人民广场",
          "destination": {"lat": 31.23, "lon": 121.47},
          "distanceMeters": 1500.5,
          "etaSeconds": 605,
          "polyline": [
            {"lat": 31.2, "lon": 121.4},
            {"lat": 31.21, "lon": 121.42},
            {"lat": 31.23, "lon": 121.47}
          ],
          "steps": [
            {"instruction": "直行300米", "lat": 31.205, "lon": 121.405, "alongRouteMeters": 0},
            {"instruction": "右转进入人民路", "lat": 31.215, "lon": 121.425, "alongRouteMeters": 300}
          ]
        }
    """.trimIndent()

    @Test
    fun `parses a full nav-route event field by field with GCJ coordinates unshifted`() {
        val event = parseAgentEvent(fullNavRouteJson)
        assertTrue(event is AgentEvent.NavRoute)
        val data = (event as AgentEvent.NavRoute).data

        assertEquals("cmd-3", data.commandId)
        assertEquals("人民广场", data.destinationName)
        assertEquals(LatLon(31.23, 121.47), data.destination)
        assertEquals(1500.5, data.distanceMeters, 0.0)
        // Integer JSON literal must bridge to Double (org.json getDouble semantics).
        assertEquals(605.0, data.etaSeconds, 0.0)
        assertEquals(
            listOf(LatLon(31.2, 121.4), LatLon(31.21, 121.42), LatLon(31.23, 121.47)),
            data.polyline
        )
        assertEquals(
            listOf(
                ManeuverStep("直行300米", LatLon(31.205, 121.405), 0.0),
                ManeuverStep("右转进入人民路", LatLon(31.215, 121.425), 300.0)
            ),
            data.steps
        )

        // GCJ-02 passthrough: exact equality with the wire input, no datum shift.
        assertEquals(31.23, data.destination.lat, 0.0)
        assertEquals(121.47, data.destination.lon, 0.0)

        // Whole-object equality as a second, stronger check on top of the field asserts.
        assertEquals(
            AgentEvent.NavRoute(
                NavRouteData(
                    commandId = "cmd-3",
                    destinationName = "人民广场",
                    destination = LatLon(31.23, 121.47),
                    polyline = listOf(LatLon(31.2, 121.4), LatLon(31.21, 121.42), LatLon(31.23, 121.47)),
                    steps = listOf(
                        ManeuverStep("直行300米", LatLon(31.205, 121.405), 0.0),
                        ManeuverStep("右转进入人民路", LatLon(31.215, 121.425), 300.0)
                    ),
                    distanceMeters = 1500.5,
                    etaSeconds = 605.0
                )
            ),
            event
        )
    }

    @Test
    fun `rejects a nav-route whose polyline entry is missing lon`() {
        val json = """
            {
              "type": "nav.route",
              "commandId": "cmd-5",
              "destinationName": "目的地",
              "destination": {"lat": 31.23, "lon": 121.47},
              "distanceMeters": 100,
              "etaSeconds": 60,
              "polyline": [{"lat": 31.2}],
              "steps": []
            }
        """.trimIndent()

        assertEquals(AgentEvent.Unhandled, parseAgentEvent(json))
    }

    @Test
    fun `rejects a nav-route whose step has a non-numeric lat`() {
        val json = """
            {
              "type": "nav.route",
              "commandId": "cmd-6",
              "destinationName": "目的地",
              "destination": {"lat": 31.23, "lon": 121.47},
              "distanceMeters": 100,
              "etaSeconds": 60,
              "polyline": [{"lat": 31.2, "lon": 121.4}],
              "steps": [{"instruction": "turn", "lat": "north", "lon": 121.4, "alongRouteMeters": 0}]
            }
        """.trimIndent()

        assertEquals(AgentEvent.Unhandled, parseAgentEvent(json))
    }

    @Test
    fun `rejects a nav-route whose destination has a non-numeric lat`() {
        val json = """
            {
              "type": "nav.route",
              "commandId": "cmd-7",
              "destinationName": "目的地",
              "destination": {"lat": "north", "lon": 121.47},
              "distanceMeters": 100,
              "etaSeconds": 60,
              "polyline": [{"lat": 31.2, "lon": 121.4}],
              "steps": []
            }
        """.trimIndent()

        assertEquals(AgentEvent.Unhandled, parseAgentEvent(json))
    }

    // ---- nav.error ----------------------------------------------------------

    @Test
    fun `parses a nav-error event`() {
        val json = """{"type":"nav.error","commandId":"cmd-4","code":"destination.notFound"}"""

        assertEquals(
            AgentEvent.NavError("cmd-4", "destination.notFound"),
            parseAgentEvent(json)
        )
    }

    // ---- buildNavRequest ------------------------------------------------

    @Test
    fun `builds a nav-request start payload with query and no destination fields`() {
        val json = JSONObject(
            buildNavRequest(
                commandId = "cmd-7",
                reason = "start",
                originLat = 31.23,
                originLon = 121.47,
                query = "人民广场"
            )
        )

        assertEquals("nav.request", json.getString("type"))
        assertEquals("cmd-7", json.getString("commandId"))
        assertEquals("start", json.getString("reason"))
        assertEquals(31.23, json.getJSONObject("origin").getDouble("lat"), 0.0)
        assertEquals(121.47, json.getJSONObject("origin").getDouble("lon"), 0.0)
        assertEquals("人民广场", json.getString("query"))
        assertFalse(json.has("destination"))
        assertFalse(json.has("destinationName"))
    }

    @Test
    fun `builds a nav-request reroute payload with destination and no query`() {
        val json = JSONObject(
            buildNavRequest(
                commandId = "cmd-8",
                reason = "reroute",
                originLat = 31.20,
                originLon = 121.40,
                destinationLat = 31.23,
                destinationLon = 121.47,
                destinationName = "人民广场"
            )
        )

        assertEquals("nav.request", json.getString("type"))
        assertEquals("reroute", json.getString("reason"))
        assertEquals(31.20, json.getJSONObject("origin").getDouble("lat"), 0.0)
        assertEquals(121.40, json.getJSONObject("origin").getDouble("lon"), 0.0)
        assertEquals(31.23, json.getJSONObject("destination").getDouble("lat"), 0.0)
        assertEquals(121.47, json.getJSONObject("destination").getDouble("lon"), 0.0)
        assertEquals("人民广场", json.getString("destinationName"))
        assertFalse(json.has("query"))
    }

    // ---- buildDeviceResult ------------------------------------------------

    @Test
    fun `builds a device-result with a reason`() {
        val json = JSONObject(buildDeviceResult("c1", "unsupported", "route.unavailable"))

        assertEquals("device.result", json.getString("type"))
        assertEquals("c1", json.getString("commandId"))
        assertEquals("unsupported", json.getString("status"))
        assertEquals("route.unavailable", json.getString("reason"))
    }

    @Test
    fun `builds a device-result without a reason key when reason is null`() {
        val json = JSONObject(buildDeviceResult("c2", "ok"))

        assertEquals("device.result", json.getString("type"))
        assertEquals("c2", json.getString("commandId"))
        assertEquals("ok", json.getString("status"))
        assertFalse(json.has("reason"))
    }
}
