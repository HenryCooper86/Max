package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TypedInputAndToolsTest {
    @After fun resetLanguage() = Localization.forTest(AppLanguage.ZH)

    private fun started(capabilities: String) = parseAgentEvent(
        """{"type":"session.started","provider":"openai","mode":"live","capabilities":$capabilities}"""
    ) as AgentEvent.SessionStarted

    @Test
    fun `session started reports typed input and tools`() {
        val caps = started("""{"serverVad":true,"tools":true,"textInput":true}""").capabilities
        assertTrue(caps.textInput)
        assertTrue(caps.tools)
        assertTrue(caps.serverVad)
    }

    @Test
    fun `relays older than typed input are treated as not supporting it`() {
        val caps = started("""{"serverVad":true}""").capabilities
        assertFalse(caps.textInput)
        assertFalse(caps.tools)
        assertFalse(started("""{"textInput":false,"tools":false}""").capabilities.textInput)
    }

    @Test
    fun `tool activity is parsed with its optional duration and error`() {
        assertEquals(
            AgentEvent.ToolActivity("call_8f2", "get_order_status", "server", "succeeded", 412, null),
            parseAgentEvent("""{"type":"tool.activity","callId":"call_8f2","name":"get_order_status","where":"server","state":"succeeded","durationMs":412}""")
        )
        assertEquals(
            AgentEvent.ToolActivity("c2", "weather", "server", "failed", null, "timeout"),
            parseAgentEvent("""{"type":"tool.activity","callId":"c2","name":"weather","where":"server","state":"failed","error":"timeout"}""")
        )
        assertEquals(
            AgentEvent.Unhandled,
            parseAgentEvent("""{"type":"tool.activity","callId":"c3","name":"weather","state":"started"}""")
        )
    }

    @Test
    fun `tool call keeps the call id for the mandatory answer`() {
        assertEquals(
            AgentEvent.ToolCall("call_1", "open_page"),
            parseAgentEvent("""{"type":"tool.call","callId":"call_1","name":"open_page","arguments":{"path":"/"}}""")
        )
        // No arguments: malformed per the schema, so it is not treated as a call.
        assertEquals(AgentEvent.Unhandled, parseAgentEvent("""{"type":"tool.call","callId":"call_1","name":"open_page"}"""))
    }

    @Test
    fun `an undeclared tool call is answered once with an error`() {
        val reply = JSONObject(unexpectedToolCallReply(AgentEvent.ToolCall("call_1", "open_page"))!!)
        assertEquals("tool.result", reply.getString("type"))
        assertEquals("call_1", reply.getString("callId"))
        assertEquals("unknown tool", reply.getString("error"))
        assertFalse(reply.has("output"))
        assertEquals(setOf("type", "callId", "error"), reply.keys().asSequence().toSet())
    }

    @Test
    fun `a call id the relay would reject is not answered`() {
        assertNull(unexpectedToolCallReply(AgentEvent.ToolCall("", "open_page")))
        assertNull(unexpectedToolCallReply(AgentEvent.ToolCall("x".repeat(129), "open_page")))
        assertTrue(unexpectedToolCallReply(AgentEvent.ToolCall("x".repeat(128), "open_page")) != null)
    }

    @Test
    fun `typed input is trimmed, capped and never sent empty`() {
        val typed = JSONObject(buildTextInput("  Where is the next fuel stop?\n")!!)
        assertEquals(setOf("type", "text"), typed.keys().asSequence().toSet())
        assertEquals("text.input", typed.getString("type"))
        assertEquals("Where is the next fuel stop?", typed.getString("text"))
        assertNull(buildTextInput("   \n "))
        assertEquals(2000, JSONObject(buildTextInput("a".repeat(2500))!!).getString("text").length)
        // The cut never splits a surrogate pair into an unpaired half.
        val emoji = "a".repeat(1999) + "😀"
        val text = JSONObject(buildTextInput(emoji)!!).getString("text")
        assertEquals("a".repeat(1999), text)
    }

    private fun activity(callId: String, name: String, state: String) =
        AgentEvent.ToolActivity(callId, name, "server", state, null, null)

    @Test
    fun `the status line shows a running tool and clears when it finishes`() {
        val tracker = ToolActivityTracker()
        assertEquals(ToolStatus("get_weather", failed = false), tracker.apply(activity("c1", "get_weather", "started"), 0))
        assertEquals(ToolStatus("find_fuel", failed = false), tracker.apply(activity("c2", "find_fuel", "started"), 10))
        assertEquals(ToolStatus("get_weather", failed = false), tracker.apply(activity("c2", "find_fuel", "succeeded"), 20))
        assertNull(tracker.apply(activity("c1", "get_weather", "succeeded"), 30))
    }

    @Test
    fun `a failure shows briefly and a call that never finishes expires`() {
        val tracker = ToolActivityTracker(failureShownMs = 3_000, staleMs = 20_000)
        assertEquals(ToolStatus("get_weather", failed = true), tracker.apply(activity("c1", "get_weather", "failed"), 1_000))
        assertEquals(ToolStatus("get_weather", failed = true), tracker.current(3_999))
        assertNull(tracker.current(4_000))

        tracker.apply(activity("c2", "find_fuel", "started"), 5_000)
        assertEquals(ToolStatus("find_fuel", failed = false), tracker.current(24_999))
        assertNull(tracker.current(25_000))
    }

    @Test
    fun `the status text is localised with a readable tool name`() {
        Localization.forTest(AppLanguage.EN)
        assertEquals("Using get order status…", toolStatusText(ToolStatus("get_order_status", failed = false)))
        assertEquals("Couldn't finish find fuel", toolStatusText(ToolStatus("find-fuel", failed = true)))
        Localization.forTest(AppLanguage.ZH)
        assertEquals("正在使用工具：get order status…", toolStatusText(ToolStatus("get_order_status", failed = false)))
        assertEquals("工具未完成：find fuel", toolStatusText(ToolStatus("find-fuel", failed = true)))
    }

    private fun readyState(textInput: Boolean = true, speed: Int? = null) = AgentSession.State(
        handsFree = true,
        connection = ConnectionState.READY,
        capabilities = ProviderCapabilities(textInput = textInput),
        speedKmh = speed?.toDouble()
    )

    @Test
    fun `the typing field appears only when the backend accepts typed turns`() {
        assertEquals(TypedInputMode.READY, typedInputMode(readyState()))
        assertEquals(TypedInputMode.HIDDEN, typedInputMode(readyState(textInput = false)))
        assertEquals(TypedInputMode.HIDDEN, typedInputMode(readyState().copy(connection = ConnectionState.CONNECTING)))
        assertEquals(TypedInputMode.HIDDEN, typedInputMode(readyState().copy(handsFree = false)))
    }

    @Test
    fun `typing waits until the bike is stopped`() {
        assertEquals(TypedInputMode.READY, typedInputMode(readyState(speed = 0)))
        assertEquals(TypedInputMode.READY, typedInputMode(readyState(speed = 4)))
        assertEquals(TypedInputMode.STOP_TO_TYPE, typedInputMode(readyState(speed = 5)))
    }
}
