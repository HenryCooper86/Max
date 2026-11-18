package io.github.henrycooper86.max.agent

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

    @Test
    fun `RDK companion and navigation prompt events are generated for native clients`() {
        assertTrue(ClientEventTypes.all.contains(ClientEventTypes.NAV_PROMPT))
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.COMPANION_PAIRING))
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.PHONE_LOCATION))
        assertTrue(ServerEventTypes.all.contains(ServerEventTypes.PHONE_LOCATION_STATUS))
    }
}
