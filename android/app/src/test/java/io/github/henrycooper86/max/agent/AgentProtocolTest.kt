package io.github.henrycooper86.max.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.json.JSONObject

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

    private fun startJson(voiceProvider: String? = null) = org.json.JSONObject(
        buildSessionStart(
            voiceGender = VoiceGender.FEMALE,
            voicePersonality = VoicePersonality.CONCISE,
            rideMode = RideMode.RIDE,
            scenario = DemoScenario.COMMUTE,
            lat = null,
            lon = null,
            voiceProvider = voiceProvider
        )
    )

    @Test
    fun `session start carries voiceProvider only when chosen`() {
        assertEquals("live", startJson("live").getString("voiceProvider"))
        assertEquals(false, startJson(null).has("voiceProvider"))
        assertEquals(false, startJson("  ").has("voiceProvider"))
        assertEquals("female", startJson("live").getString("voiceGender"))
    }

    @Test
    fun `session start declares protocol version 1 for the relay's mismatch log`() {
        val start = startJson()
        assertEquals(1, start.getInt("protocol"))
        assertEquals(PROTOCOL_VERSION, start.getInt("protocol"))
    }

    private fun started(fields: String) = parseAgentEvent(
        """{"type":"session.started","provider":"openai","mode":"live","capabilities":{},$fields}"""
    ) as AgentEvent.SessionStarted

    @Test
    fun `session start sends the resume id only when reconnecting`() {
        fun startJson(resume: String?) = JSONObject(
            buildSessionStart(
                voiceGender = VoiceGender.FEMALE,
                voicePersonality = VoicePersonality.CONCISE,
                rideMode = RideMode.RIDE,
                scenario = DemoScenario.COMMUTE,
                lat = null,
                lon = null,
                resume = resume
            )
        )
        // A new conversation leaves it out; only a reconnect sends the relay's id back.
        assertEquals(false, startJson(null).has("resume"))
        assertEquals(false, startJson("").has("resume"))
        assertEquals("rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s", startJson("rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s").getString("resume"))
    }

    @Test
    fun `session started keeps the resume id and the relay's protocol version`() {
        val current = started(""""protocol":2,"resume":"rsm_abc"""")
        assertEquals("rsm_abc", current.resume)
        assertEquals(2, current.relayProtocol)
        // A relay older than resumption and the version handshake says neither.
        val older = started("")
        assertNull(older.resume)
        assertNull(older.relayProtocol)
    }

    @Test
    fun `session started keeps only a resume id that can be sent back and a version that is a number`() {
        assertNull(started(""""resume":""""").resume)
        assertNull(started(""""resume":17""").resume)
        assertEquals(2, started(""""protocol":2.0""").relayProtocol)
        assertNull(started(""""protocol":"2"""").relayProtocol)
    }

    @Test
    fun `session ended and agent changed are parsed instead of dropped`() {
        assertEquals(AgentEvent.SessionEnded("max_duration"), parseAgentEvent("""{"type":"session.ended","reason":"max_duration"}"""))
        assertEquals(AgentEvent.SessionEnded("agent"), parseAgentEvent("""{"type":"session.ended","reason":"agent"}"""))
        assertEquals(AgentEvent.AgentChanged("billing"), parseAgentEvent("""{"type":"agent.changed","agent":"billing"}"""))
        // A reason that is not a string still ends the conversation, without a named cause.
        assertEquals(AgentEvent.SessionEnded("ended"), parseAgentEvent("""{"type":"session.ended","reason":null}"""))
        // An agent that is not a name is no event.
        assertEquals(AgentEvent.Unhandled, parseAgentEvent("""{"type":"agent.changed","agent":""}"""))
        assertEquals(AgentEvent.Unhandled, parseAgentEvent("""{"type":"agent.changed","agent":7}"""))
    }
}
