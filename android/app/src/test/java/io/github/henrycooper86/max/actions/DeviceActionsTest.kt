package io.github.henrycooper86.max.actions

import io.github.henrycooper86.max.agent.AgentEvent
import io.github.henrycooper86.max.agent.parseAgentEvent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceActionsTest {
    @Test fun `preserves every action argument including explicit false`() {
        val event = parseAgentEvent("""{"type":"device.command","commandId":"c1","action":"torch.set","args":{"on":false},"tier":"execute"}""") as AgentEvent.DeviceCommand
        assertEquals(false, event.args["on"])
        assertNull(unsupportedDeviceCommandReason(event.action, event.args))
    }
    @Test fun `malformed hardware commands are refused, never defaulted to destructive actions`() {
        // A torch with no `on` must not switch off; a recording with no `start` must not stop.
        assertEquals("action.invalid", unsupportedDeviceCommandReason("torch.set", emptyMap()))
        assertEquals("action.invalid", unsupportedDeviceCommandReason("camera.record", mapOf("start" to "false")))
        assertEquals("action.invalid", unsupportedDeviceCommandReason("volume.set", mapOf("direction" to "maximum")))
        assertEquals("action.invalid", unsupportedDeviceCommandReason("music.control", mapOf("control" to "delete")))
        assertEquals("action.invalid", unsupportedDeviceCommandReason("music.control", mapOf("control" to "play", "app" to 3)))
    }
    @Test fun `an action this build has never heard of is refused as unknown`() {
        // A newer relay's action is refused as such: the relay hears "unsupported" at once, not a timeout.
        assertEquals("action.unknown", unsupportedDeviceCommandReason("future.action", emptyMap()))
        assertEquals("action.unknown", unsupportedDeviceCommandReason("camera.look", mapOf("on" to true)))
    }
    @Test fun `all supported core actions accept their relay arguments`() {
        val commands = mapOf(
            "torch.set" to mapOf("on" to true), "volume.set" to mapOf("direction" to "up"),
            "music.control" to mapOf("control" to "pause", "app" to "网易云音乐"),
            "call.dial" to mapOf("number" to "120"), "sms.compose" to mapOf("name" to "老王", "body" to "晚点到"),
            "camera.photo" to emptyMap(), "camera.record" to mapOf("start" to false),
            "gallery.open" to emptyMap(), "gallery.describe" to mapOf("kind" to "video", "question" to "看到了什么")
        )
        commands.forEach { (action, args) -> assertNull(action, unsupportedDeviceCommandReason(action, args)) }
    }
    @Test fun `a command id the relay would refuse is not answered`() {
        for (json in listOf(
            """{"type":"device.command","commandId":"","action":"torch.set","args":{"on":true},"tier":"low"}""",
            """{"type":"device.command","commandId":"  ","action":"torch.set","args":{"on":true},"tier":"low"}""",
            """{"type":"device.command","commandId":"${"x".repeat(121)}","action":"camera.look","args":{},"tier":"low"}"""
        )) assertEquals(json, AgentEvent.Unhandled, parseAgentEvent(json))
        // A missing or misshapen envelope is still answered, and so is an id at the relay's limit.
        for (json in listOf(
            """{"type":"device.command","commandId":"c","action":"torch.set"}""",
            """{"type":"device.command","commandId":"c","action":"torch.set","args":"on","tier":"low"}""",
            """{"type":"device.command","commandId":"${"x".repeat(120)}","action":"camera.look","args":{},"tier":"low"}"""
        )) assertTrue(json, parseAgentEvent(json) is AgentEvent.DeviceCommand)
        val missingArgs = parseAgentEvent("""{"type":"device.command","commandId":"c","action":"torch.set"}""") as AgentEvent.DeviceCommand
        assertEquals("action.invalid", unsupportedDeviceCommandReason(missingArgs.action, missingArgs.args))
    }
    @Test fun `an unsupported command result carries its reason`() {
        val json = JSONObject(DeviceResult.unsupported("action.unknown").json("cmd-9"))
        assertEquals("device.result", json.getString("type"))
        assertEquals("cmd-9", json.getString("commandId"))
        assertEquals("unsupported", json.getString("status"))
        assertEquals("action.unknown", json.getString("reason"))
    }
    @Test fun `unknown negative or moving speed refuses SMS`() {
        listOf(null, Double.NaN, Double.POSITIVE_INFINITY, -1.0, 5.0, 5.01, 42.0).forEach { assertFalse(safeToComposeMessage(it)) }
        assertTrue(safeToComposeMessage(0.0)); assertTrue(safeToComposeMessage(4.99))
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
