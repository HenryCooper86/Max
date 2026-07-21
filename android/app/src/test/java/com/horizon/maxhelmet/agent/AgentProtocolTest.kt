package com.horizon.maxhelmet.agent

import org.junit.Assert.assertEquals
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
}
