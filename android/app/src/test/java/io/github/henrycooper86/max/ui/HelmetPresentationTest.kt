package io.github.henrycooper86.max.ui

import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.ConnectionState
import io.github.henrycooper86.max.agent.HazardLevel
import io.github.henrycooper86.max.agent.RideContext
import io.github.henrycooper86.max.ui.AppLanguage
import io.github.henrycooper86.max.ui.Localization
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test
    fun `muted ready caution keeps hazard caption prefix`() {
        val state = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.READY,
            micMuted = true,
            rideContext = RideContext(hazardLevel = HazardLevel.CAUTION)
        )

        assertEquals("注意路况 · 麦克风已静音", orbCaption(state))
    }

    @Test
    fun `muted relay critical keeps hazard caption prefix`() {
        val state = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.RELAY,
            micMuted = true,
            rideContext = RideContext(hazardLevel = HazardLevel.CRITICAL)
        )

        assertEquals("高风险 · 优先安全 · 麦克风已静音", orbCaption(state))
    }

    @Test
    fun `an idle screen says why the last session ended only when it failed`() {
        val ended = AgentSession.State(connection = ConnectionState.DEGRADED, statusText = tr(Str.STATUS_MINUTES_USED_UP))

        assertEquals("本月语音时长已用完，下月恢复", endedSessionNotice(ended))
        assertNull("a session that ended normally keeps the start hint", endedSessionNotice(ended.copy(connection = ConnectionState.OFFLINE)))
        assertNull("while live the hint stays about the session", endedSessionNotice(ended.copy(handsFree = true)))
        try {
            Localization.forTest(AppLanguage.EN)
            assertEquals("Voice minutes used up for this month. Back next month.", endedSessionNotice(ended))
        } finally {
            Localization.forTest(AppLanguage.ZH)
        }
    }
}
