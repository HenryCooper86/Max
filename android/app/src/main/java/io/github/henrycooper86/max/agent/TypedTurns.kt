package io.github.henrycooper86.max.agent

import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.tr
import org.json.JSONObject

/** What the transient tool status line shows. */
data class ToolStatus(val name: String, val failed: Boolean)

/**
 * Turns tool.activity events into one status line. Several calls can run in
 * one turn, so the most recently started one is shown until none is left. A
 * failure stays up briefly; a call whose end never arrives expires after the
 * relay's own 15-second tool timeout has certainly passed.
 */
class ToolActivityTracker(private val failureShownMs: Long = 3_000, private val staleMs: Long = 20_000) {
    private data class Running(val name: String, val startedAt: Long)
    private val running = LinkedHashMap<String, Running>()
    private var failure: Pair<String, Long>? = null

    @Synchronized
    fun apply(event: AgentEvent.ToolActivity, nowMs: Long): ToolStatus? {
        when (event.state) {
            "started" -> { running.remove(event.callId); running[event.callId] = Running(event.name, nowMs) }
            "succeeded" -> running.remove(event.callId)
            "failed" -> { running.remove(event.callId); failure = event.name to nowMs }
        }
        return current(nowMs)
    }

    @Synchronized
    fun current(nowMs: Long): ToolStatus? {
        running.values.removeAll { nowMs - it.startedAt >= staleMs }
        running.values.lastOrNull()?.let { return ToolStatus(it.name, failed = false) }
        val (name, at) = failure ?: return null
        if (nowMs - at >= failureShownMs) { failure = null; return null }
        return ToolStatus(name, failed = true)
    }

    @Synchronized
    fun clear() { running.clear(); failure = null }

    /** How long until [current] may change on its own, so the session can refresh the line. */
    @Synchronized
    fun nextExpiryIn(nowMs: Long): Long? = (running.values.map { it.startedAt + staleMs } +
        listOfNotNull(failure?.let { it.second + failureShownMs })).minOrNull()?.let { (it - nowMs).coerceAtLeast(0) }
}

/** Tool ids are code-style ("get_order_status"); the status line shows them as words. */
fun toolStatusText(status: ToolStatus): String {
    val name = status.name.replace('_', ' ').replace('-', ' ').trim().ifEmpty { "…" }
    return tr(if (status.failed) Str.TOOL_FAILED else Str.TOOL_RUNNING, "tool" to name)
}

/**
 * The answer to a tool.call. This app declares no client tools, so a call can
 * only be a relay mistake; docs/protocol.md requires exactly one tool.result per
 * call, and answering at once spares the model the 15-second timeout. A call id
 * the relay itself would reject cannot be answered and is ignored.
 */
fun unexpectedToolCallReply(call: AgentEvent.ToolCall): String? {
    if (call.callId.isEmpty() || call.callId.length > 128) return null
    return JSONObject().put("type", ClientEventTypes.TOOL_RESULT).put("callId", call.callId)
        .put("error", "unknown tool").toString()
}

enum class TypedInputMode { HIDDEN, STOP_TO_TYPE, READY }


/**
 * Whether the conversation shows the typing field. It exists only when the
 * backend accepts typed turns; while the effective speed (fresh GPS, else a mock
 * relay's) is at or above walking pace it asks the rider to stop first. Unknown speed
 * fails open: without a GPS fix the rider is usually indoors or parked, and a
 * locked field would make typed turns unusable exactly where they make sense.
 */
fun typedInputMode(state: AgentSession.State): TypedInputMode = when {
    !state.handsFree || state.connection != ConnectionState.READY || !state.capabilities.textInput -> TypedInputMode.HIDDEN
    // The walking-pace limit SMS composition uses: locked at 5.0 km/h and above.
    (state.speedKmh ?: 0.0) >= io.github.henrycooper86.max.actions.WALKING_PACE_KMH -> TypedInputMode.STOP_TO_TYPE
    else -> TypedInputMode.READY
}
