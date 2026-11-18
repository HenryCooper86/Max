package io.github.henrycooper86.max.ui

import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.ConnectionState
import io.github.henrycooper86.max.navigation.NavGuidanceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavPresentationTest {
    private val guidance = NavGuidanceState(
        destinationName = "人民广场",
        currentInstruction = "前方200米右转",
        distanceToManeuverMeters = 200.0,
        remainingMeters = 1500.0,
        remainingSeconds = 300.0,
        offRoute = false,
        arrived = false
    )

    private fun navState(handsFree: Boolean, connection: ConnectionState, navGuidance: NavGuidanceState?) =
        AgentSession.State(handsFree = handsFree, connection = connection, navGuidance = navGuidance)

    @Test
    fun `off-session guidance does not activate nav presentation`() {
        assertFalse(
            isNavPresentationActive(navState(handsFree = false, connection = ConnectionState.READY, navGuidance = guidance))
        )
    }

    @Test
    fun `connecting with guidance does not activate nav presentation`() {
        assertFalse(
            isNavPresentationActive(
                navState(handsFree = true, connection = ConnectionState.CONNECTING, navGuidance = guidance)
            )
        )
    }

    @Test
    fun `hands-free connected without guidance does not activate nav presentation`() {
        assertFalse(
            isNavPresentationActive(navState(handsFree = true, connection = ConnectionState.READY, navGuidance = null))
        )
    }

    @Test
    fun `hands-free connected with guidance activates nav presentation`() {
        assertTrue(
            isNavPresentationActive(navState(handsFree = true, connection = ConnectionState.READY, navGuidance = guidance))
        )
        assertTrue(
            isNavPresentationActive(navState(handsFree = true, connection = ConnectionState.RELAY, navGuidance = guidance))
        )
    }

    @Test
    fun `formatRemaining uses kilometers with one decimal at or above 1000 meters`() {
        assertEquals("1.2公里 · 4分钟", formatRemaining(1234.0, 240.0))
    }

    @Test
    fun `formatRemaining uses whole meters below 1000 meters`() {
        assertEquals("850米 · 2分钟", formatRemaining(850.0, 90.0))
    }

    @Test
    fun `formatRemaining rounds minutes up and treats 1000 meters as kilometers`() {
        assertEquals("1.0公里 · 1分钟", formatRemaining(1000.0, 1.0))
    }
}
