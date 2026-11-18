package io.github.henrycooper86.max.ui

import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.ConnectionState
import io.github.henrycooper86.max.agent.TurnState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceMicDockTest {
    @Test
    fun `maps idle connecting live and muted states`() {
        val idle = AgentSession.State()
        val connecting = idle.copy(handsFree = true, connection = ConnectionState.PROVIDER)
        val live = connecting.copy(connection = ConnectionState.READY)
        val muted = live.copy(micMuted = true)

        assertEquals(MicDockMode.IDLE, micDockPresentation(idle).mode)
        assertEquals("开始免提", micDockPresentation(idle).label)
        assertEquals(MicDockMode.CONNECTING, micDockPresentation(connecting).mode)
        assertEquals("连接中", micDockPresentation(connecting).label)
        assertEquals(MicDockMode.LIVE, micDockPresentation(live).mode)
        assertEquals("结束免提", micDockPresentation(live).label)
        assertEquals(MicDockMode.MUTED, micDockPresentation(muted).mode)
    }

    @Test
    fun `animates only ready unmuted rider input`() {
        val base = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.READY,
            turnState = TurnState.LISTENING,
            voiceLevel = 0.5f
        )

        assertTrue(isVoiceInputActive(base))
        assertTrue(isVoiceInputActive(base.copy(turnState = TurnState.HEARING)))
        assertFalse(isVoiceInputActive(base.copy(turnState = TurnState.THINKING)))
        assertFalse(isVoiceInputActive(base.copy(turnState = TurnState.SPEAKING)))
        assertFalse(isVoiceInputActive(base.copy(connection = ConnectionState.DEGRADED)))
        assertFalse(isVoiceInputActive(base.copy(micMuted = true)))
    }

    @Test
    fun `applies the noise floor sensitivity and clamp`() {
        val state = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.READY,
            turnState = TurnState.LISTENING
        )

        assertEquals(0f, micDisplayLevel(state.copy(voiceLevel = 0.035f)), 0.0001f)
        assertEquals(0.7905f, micDisplayLevel(state.copy(voiceLevel = 0.5f)), 0.0001f)
        assertEquals(1f, micDisplayLevel(state.copy(voiceLevel = 1f)), 0.0001f)
        assertEquals(0f, micDisplayLevel(state.copy(turnState = TurnState.THINKING, voiceLevel = 1f)), 0.0001f)
    }

    @Test
    fun `returns stable three bar geometry`() {
        assertEquals(listOf(6f, 6f, 6f), micMeterHeights(0f))
        assertEquals(listOf(14f, 18f, 15f), micMeterHeights(1f))
        assertEquals(listOf(14f, 18f, 15f), micMeterHeights(2f))
    }
}
