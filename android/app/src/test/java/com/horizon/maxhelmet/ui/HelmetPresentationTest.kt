package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.HazardLevel
import com.horizon.maxhelmet.agent.RideContext
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HelmetPresentationTest {
    private fun hazardState(handsFree: Boolean, connection: ConnectionState) = AgentSession.State(
        handsFree = handsFree,
        connection = connection,
        rideContext = RideContext(hazardLevel = HazardLevel.CRITICAL)
    )

    @Test
    fun `off-session hazard does not activate helmet presentation`() {
        assertFalse(isHazardPresentationActive(hazardState(handsFree = false, connection = ConnectionState.READY)))
    }

    @Test
    fun `connecting hazard does not activate helmet presentation`() {
        assertFalse(isHazardPresentationActive(hazardState(handsFree = true, connection = ConnectionState.CONNECTING)))
    }

    @Test
    fun `ready and relay hazards activate helmet presentation`() {
        assertTrue(isHazardPresentationActive(hazardState(handsFree = true, connection = ConnectionState.READY)))
        assertTrue(isHazardPresentationActive(hazardState(handsFree = true, connection = ConnectionState.RELAY)))
    }
}
