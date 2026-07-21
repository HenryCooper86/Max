package com.horizon.maxhelmet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeneratedAgentProtocolTest {
    @Test
    fun `transcript contract requires server issued identifiers`() {
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.TRANSCRIPT))
        assertEquals(
            setOf("type", "turnId", "deliveryId", "speaker", "text"),
            SERVER_EVENT_REQUIRED_FIELDS[ServerEventTypes.TRANSCRIPT]
        )
    }

    @Test
    fun `feedback event is generated for native clients`() {
        assertTrue(ClientEventTypes.all.contains(ClientEventTypes.TURN_FEEDBACK))
    }
}
