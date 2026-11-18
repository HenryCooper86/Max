package io.github.henrycooper86.max.music

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppMusicPlaybackTest {
    private class Driver : AppMusicDriver {
        lateinit var prepared: (String) -> Unit
        lateinit var completed: () -> Unit
        lateinit var failed: () -> Unit
        var plays = 0; var pauses = 0; var releases = 0
        var starts = true
        var pauseFails = false
        var track = ""
        override fun prepare(track: String, prepared: (String) -> Unit, completed: () -> Unit, failed: () -> Unit) {
            this.track = track; this.prepared = prepared; this.completed = completed; this.failed = failed
        }
        override fun play(): Boolean { plays++; return starts }
        override fun pause() { pauses++; if (pauseFails) error("pause failed") }
        override fun release() { releases++ }
    }
    private class Fixture(scope: CoroutineScope) {
        val drivers = mutableListOf<Driver>()
        val player = AppMusicPlayback(scope) { Driver().also(drivers::add) }.apply { setForeground(true) }
        val current get() = drivers.last()
        fun select() { player.select(listOf("one", "two")) }
    }

    @Test fun `leaving Max pauses and returning never resumes automatically`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("Song one")
        f.player.setForeground(false)
        assertFalse(f.player.state.value.playing); assertEquals(1, f.current.pauses)
        assertEquals("failed", f.player.execute("play").status)
        f.player.setForeground(true)
        assertFalse(f.player.state.value.playing); assertEquals(1, f.current.plays)
        assertEquals("ok", f.player.execute("play").status)
        assertEquals(2, f.current.plays)
    }

    @Test fun `stop interrupts preparation and late callback cannot play`() = runTest {
        val f = Fixture(this); f.select(); val old = f.current
        assertEquals("ok", f.player.execute("pause").status)
        old.prepared("Late song")
        assertEquals(0, old.plays); assertEquals(1, old.releases)
        assertFalse(f.player.state.value.busy); assertFalse(f.player.state.value.playing)
    }

    @Test fun `closing card preserves queue but prevents pending work from reopening it`() = runTest {
        val f = Fixture(this); f.select(); val old = f.current
        f.player.stop(dismiss = true); old.prepared("Late")
        assertFalse(f.player.state.value.visible)
        val resume = async { f.player.execute("play") }; runCurrent()
        f.current.prepared("One")
        assertEquals("ok", resume.await().status)
        assertEquals("one", f.current.track)
    }

    @Test fun `skip confirmation waits until replacement actually plays`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("One")
        val skip = async { f.player.execute("next") }; runCurrent()
        assertFalse(skip.isCompleted); assertEquals("two", f.current.track)
        f.current.prepared("Two")
        assertEquals("ok", skip.await().status); assertEquals("Two", f.player.state.value.title)
    }

    @Test fun `failed skip cannot report successful playback`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("One")
        val skip = async { f.player.execute("next") }; runCurrent()
        f.current.failed()
        assertEquals("music.unavailable", skip.await().reason)
        assertFalse(f.player.state.value.playing)
    }

    @Test fun `closing session cancels a skip waiting for playback`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("One")
        val skip = async { f.player.execute("next") }; runCurrent(); val old = f.current
        f.player.stop(); old.prepared("Two")
        assertEquals("action.cancelled", skip.await().reason); assertEquals(0, old.plays)
    }

    @Test fun `superseded preparation and completion cannot advance new queue`() = runTest {
        val f = Fixture(this); f.select(); val old = f.current
        f.player.select(listOf("replacement")); old.prepared("One"); old.completed()
        assertEquals(0, old.plays); assertEquals(2, f.drivers.size)
        f.current.prepared("Replacement")
        assertEquals("Replacement", f.player.state.value.title)
    }

    @Test fun `loading timeout releases player and reports an error`() = runTest {
        val f = Fixture(this); f.select(); val old = f.current
        advanceTimeBy(6001); runCurrent()
        old.prepared("Late")
        assertEquals(1, old.releases); assertEquals(0, old.plays)
        assertFalse(f.player.state.value.busy); assertNotNull(f.player.state.value.message)
    }

    @Test fun `picker result before activity start plays exactly once after return`() = runTest {
        val f = Fixture(this)
        val ticket = f.player.beginSelection()!!
        f.player.setForeground(false)
        f.player.completeSelection(ticket, listOf("selected"))
        assertTrue(f.drivers.isEmpty())
        f.player.setForeground(true); f.current.prepared("Selected")
        f.player.setForeground(true)
        assertEquals(1, f.drivers.size); assertEquals(1, f.current.plays)
    }

    @Test fun `ending session invalidates a result from an open picker`() = runTest {
        val f = Fixture(this); val ticket = f.player.beginSelection()!!
        f.player.setForeground(false); f.player.stop(dismiss = true)
        f.player.completeSelection(ticket, listOf("late")); f.player.setForeground(true)
        assertTrue(f.drivers.isEmpty()); assertFalse(f.player.state.value.playing)
    }

    @Test fun `background invalidates prepared callback without losing user queue`() = runTest {
        val f = Fixture(this); f.select(); val old = f.current
        f.player.setForeground(false); old.prepared("One"); f.player.setForeground(true)
        assertEquals(0, old.plays); assertFalse(f.player.state.value.busy)
        f.player.control("play"); assertEquals("one", f.current.track)
        f.current.prepared("One")
    }

    @Test fun `queue boundary returns failure instead of pretending to skip`() = runTest {
        val f = Fixture(this); f.player.select(listOf("one")); f.current.prepared("One")
        assertEquals("music.queueEnd", f.player.execute("next").reason)
        assertEquals("music.queueEnd", f.player.execute("previous").reason)
        assertEquals(1, f.drivers.size)
    }

    @Test fun `external player requests never take over another app`() = runTest {
        val f = Fixture(this)
        assertEquals("player.unsupported", f.player.execute("play", "Spotify").reason)
        assertTrue(f.drivers.isEmpty())
    }

    @Test fun `failed pause releases the driver so audio cannot continue`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("One"); f.current.pauseFails = true
        f.player.stop()
        assertEquals(1, f.current.releases); assertFalse(f.player.state.value.playing)
    }

    @Test fun `command cancellation releases pending player`() = runTest {
        val f = Fixture(this); f.select(); f.current.prepared("One")
        val skip = async { f.player.execute("next") }; runCurrent(); val old = f.current
        skip.cancelAndJoin(); old.prepared("Late")
        assertEquals(1, old.releases); assertEquals(0, old.plays)
    }
}
