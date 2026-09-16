package com.horizon.maxhelmet.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLifecycleTest {
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
