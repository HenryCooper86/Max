package io.github.henrycooper86.max.ui

import androidx.compose.ui.graphics.Color
import io.github.henrycooper86.max.agent.AgentSession
import io.github.henrycooper86.max.agent.ConnectionState
import io.github.henrycooper86.max.agent.TurnState
import io.github.henrycooper86.max.ui.theme.VisorColors
import io.github.henrycooper86.max.ui.theme.parseAccentHex
import io.github.henrycooper86.max.ui.theme.visorColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class VisorThemeTest {
    @Test
    fun `default tokens match the Visor spec`() {
        val c = VisorColors()
        assertEquals(Color(0xFF0B0C0E), c.bg)
        assertEquals(Color(0xFF131518), c.surface1)
        assertEquals(Color(0xFF1A1D21), c.surface2)
        assertEquals(Color(0xFF23272C), c.surface3)
        assertEquals(Color(0xFFF2F4F5), c.text)
        assertEquals(Color(0xFFA3ABB3), c.textSecondary)
        assertEquals(Color(0xFF6B737C), c.textTertiary)
        assertEquals(Color(0xFFC6F432), c.accent)
        assertEquals(Color(0xFFFF7A45), c.user)
        assertEquals(Color(0xFFFF5A4D), c.danger)
        assertEquals(Color(0xFFFFC53D), c.warn)
        assertEquals(Color(0xFF3DDC97), c.ok)
        assertEquals(0.08f, c.line.alpha, 0.005f)
        assertEquals(0.14f, c.lineStrong.alpha, 0.005f)
    }

    @Test
    fun `accent is a runtime value and accentSoft follows it at 14 percent`() {
        val branded = visorColors(Color(0xFF3366FF))
        assertEquals(Color(0xFF3366FF), branded.accent)
        assertEquals(0.14f, branded.accentSoft.alpha, 0.005f)
        assertEquals(branded.accent.copy(alpha = 0.14f), branded.accentSoft)
    }

    @Test
    fun `accent hex parsing accepts RRGGBB only`() {
        assertEquals(Color(0xFF112233), parseAccentHex("#112233"))
        assertEquals(Color(0xFFAABBCC), parseAccentHex(" aabbcc "))
        assertNull(parseAccentHex("#12345"))
        assertNull(parseAccentHex("#GGHHII"))
        assertNull(parseAccentHex(null))
    }

    private fun state(handsFree: Boolean = true, connection: ConnectionState = ConnectionState.READY,
                      turn: TurnState = TurnState.IDLE, muted: Boolean = false) =
        AgentSession.State(handsFree = handsFree, connection = connection, turnState = turn, micMuted = muted)

    @Test
    fun `visor mode follows session state`() {
        assertEquals(VisorMode.IDLE, visorMode(state(handsFree = false, connection = ConnectionState.OFFLINE)))
        assertEquals(VisorMode.OFFLINE, visorMode(state(connection = ConnectionState.OFFLINE)))
        assertEquals(VisorMode.OFFLINE, visorMode(state(connection = ConnectionState.DEGRADED)))
        assertEquals(VisorMode.CONNECTING, visorMode(state(connection = ConnectionState.CONNECTING)))
        assertEquals(VisorMode.CONNECTING, visorMode(state(connection = ConnectionState.PROVIDER)))
        assertEquals(VisorMode.LISTENING, visorMode(state(turn = TurnState.LISTENING)))
        assertEquals(VisorMode.LISTENING, visorMode(state(turn = TurnState.HEARING)))
        assertEquals(VisorMode.THINKING, visorMode(state(turn = TurnState.THINKING)))
        assertEquals(VisorMode.SPEAKING, visorMode(state(turn = TurnState.SPEAKING)))
        assertEquals(VisorMode.IDLE, visorMode(state(turn = TurnState.LISTENING, muted = true)))
    }

    @Test
    fun `idle wave is flat and listening energy tracks the mic level`() {
        val flat = (0..20).maxOf { abs(visorWave(it / 20f, visorEnergy(VisorMode.IDLE, 0f), 0.3f)) }
        assertTrue("idle should be nearly flat, was $flat", flat < 0.05f)
        assertEquals(0f, visorEnergy(VisorMode.CONNECTING, 0.9f), 0f)
        assertTrue(visorEnergy(VisorMode.LISTENING, 0.9f) > visorEnergy(VisorMode.LISTENING, 0.1f))
        assertTrue(visorEnergy(VisorMode.SPEAKING, 0f) > visorEnergy(VisorMode.THINKING, 0f))
        // Ends always taper to the baseline.
        assertEquals(0f, visorWave(0f, 1f, 0.4f), 1e-4f)
        assertEquals(0f, visorWave(1f, 1f, 0.4f), 1e-4f)
    }
}
