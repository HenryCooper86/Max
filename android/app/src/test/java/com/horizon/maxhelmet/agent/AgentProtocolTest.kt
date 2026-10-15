package com.horizon.maxhelmet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentProtocolTest {
    @Test
    fun `appends an encoded token before a URL fragment`() {
        assertEquals(
            "wss://relay.example/agent?token=new+token#debug",
            appendAuthToken("wss://relay.example/agent#debug", " new token ")
        )
    }

    @Test
    fun `replaces an existing token without disturbing other query parameters`() {
        assertEquals(
            "wss://relay.example/agent?region=cn&token=fresh#debug",
            appendAuthToken("wss://relay.example/agent?region=cn&token=stale#debug", "fresh")
        )
    }
    @Test
    fun `preserves an actual zero latency sample but excludes zero packet counters`() {
        val realZero = parseAgentEvent("""{"type":"metric","latencyMs":0}""") as AgentEvent.Metric
        assertEquals(0, realZero.latencyMs)
        for (field in listOf("outgoingFps", "droppedFrames")) {
            val counter = parseAgentEvent("""{"type":"metric","latencyMs":0,"$field":0}""") as AgentEvent.Metric
            assertNull("$field is a packet counter, not a new latency measurement", counter.latencyMs)
        }
        val mixed = parseAgentEvent("""{"type":"metric","latencyMs":23,"outgoingFps":50}""") as AgentEvent.Metric
        assertEquals(23, mixed.latencyMs)
    }
}
