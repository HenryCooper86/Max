package io.github.henrycooper86.max.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandingTest {
    @Test
    fun `parses assistant branding and voice backends from health`() {
        val info = parseHealth(
            """{"ok":true,
              "assistant":{"name":"Aria","device":"glasses","wakePhrase":"hey aria","accentColor":"#3366FF"},
              "voice":{"active":"live","switching":true,"providers":[
                {"id":"demo","label":"Demo","kind":"demo","configured":true},
                {"id":"live","label":"Live","kind":"live","configured":false,"description":"Realtime"}]}}"""
        )!!
        assertEquals("Aria", info.assistant?.name)
        assertEquals(DeviceKind.GLASSES, info.assistant?.device)
        assertEquals("hey aria", info.assistant?.wakePhrase)
        assertEquals("#3366FF", info.assistant?.accentHex)
        val voice = info.voice!!
        assertTrue(voice.switching)
        assertEquals("Live", voice.activeLabel)
        assertEquals(2, voice.providers.size)
        assertFalse(voice.providers[1].configured)
        assertEquals("Realtime", voice.providers[1].description)
        assertNull(voice.providers[0].description)
    }

    @Test
    fun `absent optional parts leave defaults alone`() {
        val info = parseHealth("""{"ok":true}""")!!
        assertNull(info.assistant)
        assertNull(info.voice)
        assertNotNull(parseHealth("{}"))
        assertNull(parseHealth("not json"))
    }

    @Test
    fun `voice block without switching is read only and bad providers are dropped`() {
        val voice = parseHealth("""{"voice":{"active":"demo","providers":[{"label":"no id"},{"id":"demo","kind":"demo"}]}}""")!!.voice!!
        assertFalse(voice.switching)
        assertEquals(1, voice.providers.size)
        assertEquals("demo", voice.activeLabel)
    }

    @Test
    fun `orbCaption uses the assistant name`() {
        val state = io.github.henrycooper86.max.agent.AgentSession.State(
            handsFree = true,
            connection = io.github.henrycooper86.max.agent.ConnectionState.READY,
            turnState = io.github.henrycooper86.max.agent.TurnState.THINKING
        )
        assertEquals("Aria 思考中…", orbCaption(state, "Aria"))
        assertEquals("Max 思考中…", orbCaption(state))
    }
}
