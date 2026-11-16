package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.AgentEvent
import com.horizon.maxhelmet.agent.HazardSpeech
import com.horizon.maxhelmet.agent.hazardSpeechPath
import com.horizon.maxhelmet.agent.parseAgentEvent
import com.horizon.maxhelmet.agent.ttsLocaleFor
import com.horizon.maxhelmet.ui.AppLanguage
import com.horizon.maxhelmet.ui.Localization
import com.horizon.maxhelmet.ui.Str
import com.horizon.maxhelmet.ui.tr
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

class NavLocalizationTest {
    @After
    fun reset() = Localization.forTest(AppLanguage.ZH)

    private fun routeJson(withLocalized: Boolean) = """
        {"type":"nav.route","commandId":"c1","destinationName":"人民广场","destination":{"lat":31.24,"lon":121.47},
         "distanceMeters":1109,"etaSeconds":240,
         "polyline":[{"lat":31.23,"lon":121.47},{"lat":31.24,"lon":121.47}],
         "steps":[{"instruction":"右转进入南京东路","lat":31.235,"lon":121.47,"alongRouteMeters":555}${
            if (withLocalized) ",{\"instruction\":\"到达终点\",\"localizedInstruction\":\"Arrive at the destination\",\"lat\":31.24,\"lon\":121.47,\"alongRouteMeters\":1109}" else ""
        }]}
    """.trimIndent()

    @Test
    fun `parses nav route steps with and without a localized instruction`() {
        val without = (parseAgentEvent(routeJson(false)) as AgentEvent.NavRoute).data.steps
        assertNull(without[0].localizedInstruction)
        assertEquals("右转进入南京东路", without[0].spoken)
        val with = (parseAgentEvent(routeJson(true)) as AgentEvent.NavRoute).data.steps
        assertEquals("到达终点", with[1].instruction)
        assertEquals("Arrive at the destination", with[1].localizedInstruction)
        assertEquals("Arrive at the destination", with[1].spoken)
    }

    private fun route(localized: String?) = NavigationRoute(
        "终点", LatLon(31.24, 121.47),
        listOf(LatLon(31.23, 121.47), LatLon(31.235, 121.47), LatLon(31.24, 121.47)),
        listOf(
            ManeuverStep("右转进入南京东路", LatLon(31.235, 121.47), 555.0, localizedInstruction = localized),
            ManeuverStep("到达终点", LatLon(31.24, 121.47), 1109.0)
        ),
        1109.0, 240.0
    )

    private fun fresh() = GuidanceProgress(0, emptySet(), false)

    @Test
    fun `english lead-in lowercases the instruction and chinese wording is unchanged`() {
        // 555 m route step, rider ~200 m before it: lat 31.2332 is about 200 m short of 31.235.
        val english = GuidanceEngine.step(LatLon(31.2332, 121.47), route("Turn right onto 南京东路"), fresh())
        assertEquals("In 200 metres, turn right onto 南京东路", english.spokenPrompt)
        val chinese = GuidanceEngine.step(LatLon(31.2332, 121.47), route(null), fresh())
        assertEquals("前方200米，右转进入南京东路", chinese.spokenPrompt)
        // At the turn the bare localized instruction is spoken.
        assertEquals("Turn right onto 南京东路", maneuverPrompt(route("Turn right onto 南京东路").steps[0], now = true, roundedMeters = 0))
        assertEquals("右转进入南京东路", maneuverPrompt(route(null).steps[0], now = true, roundedMeters = 0))
    }

    @Test
    fun `display prefers the localized text while icon parsing keeps the original`() {
        val update = GuidanceEngine.step(LatLon(31.2332, 121.47), route("Turn right onto 南京东路"), fresh())
        assertEquals("右转进入南京东路", update.currentInstruction)
        assertEquals("Turn right onto 南京东路", update.currentInstructionLocalized)
        val state = NavGuidanceState("终点", update.currentInstruction, 200.0, 900.0, 200.0, false, false,
            currentInstructionLocalized = update.currentInstructionLocalized)
        assertEquals("Turn right onto 南京东路", state.displayInstruction)
        assertEquals("右转进入南京东路", state.currentInstruction)
        assertEquals("右转", NavGuidanceState("终点", "右转", 1.0, 1.0, 1.0, false, false).displayInstruction)
    }

    @Test
    fun `navigation speech comes from the table in the app language`() {
        assertEquals("已到达目的地。", tr(Str.NAV_ARRIVED))
        assertEquals("已到达目的地。", tr(Str.NAV_ARRIVED))
        assertEquals("已停止导航。", tr(Str.NAV_STOP))
        assertEquals("已偏离路线，正在重新规划。", tr(Str.NAV_OFF_ROUTE))
        assertEquals("无法重新规划路线，已停止导航。", tr(Str.NAV_REROUTE_FAILED))
        assertEquals("正在定位…", tr(Str.NAV_LOCATING))
        Localization.forTest(AppLanguage.EN)
        assertEquals("You have arrived.", tr(Str.NAV_ARRIVED))
        assertEquals("You're off the route. Recalculating.", tr(Str.NAV_OFF_ROUTE))
        assertEquals("I couldn't find a new route. Navigation has stopped.", tr(Str.NAV_REROUTE_FAILED))
        assertEquals("Confirm the destination: 人民广场. Say “confirm navigation” or tap Confirm to start turn-by-turn guidance.", tr(Str.NAV_CONFIRM_PROMPT, "name" to "人民广场"))
    }

    @Test
    fun `hazard speech path follows the app language and voice follows the text`() {
        assertEquals(HazardSpeech.CLIP, hazardSpeechPath(AppLanguage.ZH, "注意，后方车辆高速接近。"))
        assertEquals(HazardSpeech.DEVICE_TTS, hazardSpeechPath(AppLanguage.EN, "Caution, a vehicle is approaching fast from behind."))
        assertEquals(HazardSpeech.CLIP, hazardSpeechPath(AppLanguage.EN, ""))
        assertEquals(Locale.SIMPLIFIED_CHINESE, ttsLocaleFor("请确认目的地"))
        assertEquals(Locale.US, ttsLocaleFor("Turn right onto Main Street"))
        assertEquals(Locale.SIMPLIFIED_CHINESE, ttsLocaleFor("Turn right onto 南京东路"))
        Localization.forTest(AppLanguage.EN)
        assertEquals("Behind", tr(Str.DIR_REAR))
        assertEquals("Ahead", tr(Str.DIR_FRONT))
        assertEquals("Left rear", tr(Str.DIR_LEFT_REAR))
        assertEquals("Right rear", tr(Str.DIR_RIGHT_REAR))
    }
}
