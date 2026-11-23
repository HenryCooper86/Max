package io.github.henrycooper86.max.agent

import org.junit.Assert.*
import org.junit.Test

/** Stops at the existing transform observer; no AudioTrack or capture is constructed. */
class PcmAdmissionTest {
    private class Admitted : RuntimeException()

    @Test fun `old socket bytes rejected before counters or transform in a newly prepared epoch`() {
        val player = PcmPlayer()
        val oldSocket = Any(); var currentSocket: Any? = oldSocket
        player.prepare(); player.release(); player.prepare()
        currentSocket = Any()
        var transformed = false
        player.syntheticPipelineObserver = { stage, _ ->
            if (stage == "pcm.gain.begin") { transformed = true; throw Admitted() }
        }
        try { player.play(ByteArray(256)) { oldSocket === currentSocket } } catch (_: Admitted) { }
        assertFalse("Stale socket bytes reached gain processing", transformed)
        val state = player.playbackDiagnostics()
        assertEquals(0L, state.totalQueuedSamples)
        assertEquals(0L, state.queuedSamples)
        assertEquals(0, state.pendingBuffers)
        assertFalse(state.running)
        player.release()
    }

    @Test fun `source decision is evaluated inside ticket lock and valid admission remains accounted`() {
        val player = PcmPlayer(); player.prepare()
        var checked = false
        player.syntheticPipelineObserver = { stage, _ -> if (stage == "pcm.gain.begin") throw Admitted() }
        try {
            player.play(ByteArray(256)) {
                checked = true
                assertTrue("Source ownership check was outside the ticket fence", Thread.holdsLock(player))
                true
            }
        } catch (_: Admitted) { }
        assertTrue(checked)
        assertEquals(128L, player.playbackDiagnostics().totalQueuedSamples)
        player.release()
        assertEquals(128L, player.playbackDiagnostics().totalDiscardedSamples)
    }
}
