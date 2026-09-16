package com.horizon.maxhelmet.actions

import com.horizon.maxhelmet.agent.AgentEvent
import com.horizon.maxhelmet.agent.parseAgentEvent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceActionsTest {
    @Test fun `preserves every action argument including explicit false`() {
        val event = parseAgentEvent("""{"type":"device.command","commandId":"c1","action":"torch.set","args":{"on":false},"tier":"execute"}""") as AgentEvent.DeviceCommand
        assertEquals(false, event.args["on"])
        assertTrue(validDeviceArguments(event.action, event.args))
    }
    @Test fun `does not default malformed hardware commands to destructive actions`() {
        assertFalse(validDeviceArguments("torch.set", emptyMap()))
        assertFalse(validDeviceArguments("camera.record", mapOf("start" to "false")))
        assertFalse(validDeviceArguments("volume.set", mapOf("direction" to "maximum")))
        assertFalse(validDeviceArguments("music.control", mapOf("control" to "delete")))
        assertFalse(validDeviceArguments("future.action", emptyMap()))
    }
    @Test fun `all supported core actions accept their relay arguments`() {
        val commands = mapOf(
            "torch.set" to mapOf("on" to true), "volume.set" to mapOf("direction" to "up"),
            "music.control" to mapOf("control" to "pause", "app" to "网易云音乐"),
            "call.dial" to mapOf("number" to "120"), "sms.compose" to mapOf("name" to "老王", "body" to "晚点到"),
            "camera.photo" to emptyMap(), "camera.record" to mapOf("start" to false),
            "gallery.open" to emptyMap(), "gallery.describe" to mapOf("kind" to "video", "question" to "看到了什么")
        )
        commands.forEach { (action, args) -> assertTrue(action, validDeviceArguments(action, args)) }
    }
    @Test fun `unknown negative or moving speed refuses SMS`() {
        listOf(null, Double.NaN, Double.POSITIVE_INFINITY, -1.0, 5.01, 42.0).forEach { assertFalse(safeToComposeMessage(it)) }
        assertTrue(safeToComposeMessage(0.0)); assertTrue(safeToComposeMessage(5.0))
    }
    @Test fun `voice gain stays within safe range and can increase from shipped default`() {
        assertEquals(2.5f, nextVoiceGain(2f, "up"))
        assertEquals(4f, nextVoiceGain(4f, "up"))
        assertEquals(0.5f, nextVoiceGain(0.5f, "down"))
    }
    @Test fun `dial input excludes uri and USSD injection`() {
        assertTrue(isDialableNumber("+86 138-0000-0000")); assertTrue(isDialableNumber("120"))
        listOf("", "老王", "tel:120", "*123#", "123;456").forEach { assertFalse(isDialableNumber(it)) }
    }
    @Test fun `vision chunks carry command identity and omit missing question`() {
        val first = JSONObject(buildVisionFrame("capture-1", 0, 8, "jpeg", null))
        assertEquals("vision.frames", first.getString("type"))
        assertEquals("capture-1", first.getString("commandId"))
        assertEquals(8, first.getInt("total")); assertFalse(first.has("question"))
        assertEquals("说明", JSONObject(buildVisionFrame("c", 1, 2, "jpeg", "说明")).getString("question"))
    }
    @Test fun `failed actions produce a result rather than a timeout`() {
        val json = JSONObject(DeviceResult.denied("permission.camera").json("cmd"))
        assertEquals("device.result", json.getString("type"))
        assertEquals("cmd", json.getString("commandId")); assertEquals("denied", json.getString("status"))
        assertEquals("permission.camera", json.getString("reason"))
        assertFalse(json.has("detail"))
    }
}
