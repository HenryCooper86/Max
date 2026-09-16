package com.horizon.maxhelmet.agent

/**
 * Pure ownership gate for asynchronous hands-free startup.
 *
 * Location, permissions, and microphone setup complete on different threads.
 * Each start receives a generation; callbacks may acquire resources only while
 * that generation remains current. Stopping invalidates every pending callback.
 */
class SessionLifecycle {
    private var generation = 0
    private var active = false

    @Synchronized
    fun begin(): Int? {
        if (active) return null
        active = true
        generation += 1
        return generation
    }

    @Synchronized
    fun accepts(candidate: Int): Boolean = active && candidate == generation

    @Synchronized
    fun current(): Int? = generation.takeIf { active }

    @Synchronized
    fun stop(): Boolean {
        if (!active) return false
        active = false
        generation += 1
        return true
    }
}
