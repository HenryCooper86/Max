package io.github.henrycooper86.max.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class SessionLifecycleTest {
    @Test
    fun `terminal error is published after queued resource teardown`() = runTest {
        for (error in listOf("microphone unavailable", "HTTP 400", "HTTP 401", "idle close", "reconnect exhausted")) {
            val lifecycle = SessionLifecycle()
            val generation = lifecycle.begin()!!
            val states = mutableListOf<String>()
            var micActive = true
            lifecycle.finishOn(this, generation,
                teardown = { micActive = false; lifecycle.stop(); states.add("offline") },
                publish = { assertFalse(micActive); states.add(error) })
            assertTrue(states.isEmpty())
            advanceUntilIdle()
            assertEquals(listOf("offline", error), states)
        }
    }

    @Test
    fun `queued failure from old session cannot tear down the next session`() = runTest {
        val lifecycle = SessionLifecycle()
        val generation = lifecycle.begin()!!
        var teardownCount = 0
        var published = false
        lifecycle.finishOn(this, generation, teardown = { teardownCount++ }, publish = { published = true })
        lifecycle.stop()
        val next = lifecycle.begin()!!
        advanceUntilIdle()
        assertEquals(0, teardownCount)
        assertFalse(published)
        assertTrue(lifecycle.accepts(next))
    }
    @Test
    fun `stop invalidates delayed startup callbacks`() {
        val lifecycle = SessionLifecycle()
        val generation = lifecycle.begin()

        assertNull(SessionLifecycle().current())
        assertTrue(lifecycle.current() == generation)
        assertNotNull(generation)
        assertTrue(lifecycle.accepts(generation!!))
        assertTrue(lifecycle.stop())
        assertFalse(lifecycle.accepts(generation))
        assertNull(lifecycle.current())
    }

    @Test
    fun `only one start owns resources at a time`() {
        val lifecycle = SessionLifecycle()

        assertNotNull(lifecycle.begin())
        assertNull(lifecycle.begin())
        assertTrue(lifecycle.stop())
        assertNotNull(lifecycle.begin())
    }
}
