package io.github.henrycooper86.max.music

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class QQMusicPlaybackTest {
    private class Session : QQMusicSession {
        var current = QQMusicSnapshot("one", "First", playing = true, actions = setOf("play", "pause", "next", "previous"))
        val commands = mutableListOf<String>()
        override fun snapshot() = current
        override fun send(action: String) { commands += action }
    }
    @Test fun `permission denied never queries sessions or sends controls`() = runTest {
        val player = QQMusicPlayback({ false }, { error("Must not query") })
        assertEquals("permission.musicControl", player.execute("next").reason)
        assertTrue(player.state.value.visible)
        assertFalse(player.state.value.busy)
    }
    @Test fun `no QQ session asks user to start playback`() = runTest {
        val player = QQMusicPlayback({ true }, { null })
        assertEquals("music.playerUnavailable", player.execute("play").reason)
    }
    @Test fun `skip waits for changed item and active playback`() = runTest {
        val session = Session()
        val player = QQMusicPlayback({ true }, { session })
        val result = async { player.execute("next") }
        runCurrent()
        assertEquals(listOf("next"), session.commands)
        session.current = session.current.copy(identity = "two", title = "Second", playing = false)
        advanceTimeBy(200); runCurrent()
        assertFalse(result.isCompleted)
        session.current = session.current.copy(playing = true)
        advanceTimeBy(100); runCurrent()
        assertEquals("ok", result.await().status)
        assertEquals("Second", player.state.value.title)
    }
    @Test fun `no-op skip and unsupported actions never claim success`() = runTest {
        val session = Session()
        val player = QQMusicPlayback({ true }, { session }, attempts = 2)
        assertEquals("music.controlUnavailable", player.execute("next").reason)
        session.current = session.current.copy(actions = emptySet())
        assertEquals("music.controlUnavailable", player.execute("previous").reason)
        assertEquals(listOf("next"), session.commands)
    }
    @Test fun `pause requires paused state and does not mistake buffering for pause`() = runTest {
        val session = Session()
        val player = QQMusicPlayback({ true }, { session })
        val result = async { player.execute("pause") }; runCurrent()
        session.current = session.current.copy(playing = false)
        advanceTimeBy(200); runCurrent(); assertFalse(result.isCompleted)
        session.current = session.current.copy(paused = true)
        advanceTimeBy(100); runCurrent()
        assertEquals("ok", result.await().status)
    }
    @Test fun `closing cancels pending acknowledgement without reopening the card`() = runTest {
        val session = Session()
        val player = QQMusicPlayback({ true }, { session })
        val result = async { player.execute("next") }; runCurrent()
        player.dismiss()
        session.current = session.current.copy(identity = "two")
        advanceTimeBy(100); runCurrent()
        assertEquals("action.cancelled", result.await().reason)
        assertFalse(player.state.value.visible)
        assertFalse(player.state.value.busy)
    }
    @Test fun `permission revoked during command cannot yield success`() = runTest {
        var permission = true
        val session = Session()
        val player = QQMusicPlayback({ permission }, { session })
        val result = async { player.execute("next") }; runCurrent()
        permission = false
        session.current = session.current.copy(identity = "two")
        advanceTimeBy(100); runCurrent()
        assertEquals("permission.musicControl", result.await().reason)
    }
    @Test fun `pause cancels an older pending skip`() = runTest {
        val session = Session()
        val player = QQMusicPlayback({ true }, { session })
        val skip = async { player.execute("next") }; runCurrent()
        val pause = async { player.execute("pause") }; runCurrent()
        session.current = session.current.copy(playing = false, paused = true)
        advanceTimeBy(100); runCurrent()
        assertEquals("action.cancelled", skip.await().reason)
        assertEquals("ok", pause.await().status)
    }
}
