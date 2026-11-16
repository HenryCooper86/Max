package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.TurnState

internal const val MIC_DOCK_NOISE_FLOOR = 0.035f
internal const val MIC_DOCK_SENSITIVITY = 1.7f

internal enum class MicDockMode { IDLE, CONNECTING, LIVE, MUTED }

internal data class MicDockPresentation(
    val mode: MicDockMode,
    val label: String,
    val accessibilityLabel: String,
    val displayLevel: Float
)

internal fun isVoiceInputActive(state: AgentSession.State): Boolean =
    state.handsFree &&
        state.connection == ConnectionState.READY &&
        !state.micMuted &&
        (state.turnState == TurnState.LISTENING || state.turnState == TurnState.HEARING)

internal fun micDisplayLevel(state: AgentSession.State): Float {
    if (!isVoiceInputActive(state)) return 0f
    return ((state.voiceLevel - MIC_DOCK_NOISE_FLOOR).coerceAtLeast(0f) * MIC_DOCK_SENSITIVITY)
        .coerceIn(0f, 1f)
}

internal fun micDockPresentation(state: AgentSession.State): MicDockPresentation {
    val mode = when {
        !state.handsFree -> MicDockMode.IDLE
        state.connection != ConnectionState.READY -> MicDockMode.CONNECTING
        state.micMuted -> MicDockMode.MUTED
        else -> MicDockMode.LIVE
    }
    val label = when (mode) {
        MicDockMode.IDLE -> tr(Str.HF_BEGIN)
        MicDockMode.CONNECTING -> tr(Str.CONN_CONNECTING)
        MicDockMode.LIVE, MicDockMode.MUTED -> tr(Str.HF_END)
    }
    val accessibilityLabel = when (mode) {
        MicDockMode.IDLE -> tr(Str.HF_BEGIN)
        MicDockMode.CONNECTING -> tr(Str.HF_CANCEL_HINT)
        MicDockMode.LIVE, MicDockMode.MUTED -> tr(Str.HF_END)
    }
    return MicDockPresentation(mode, label, accessibilityLabel, micDisplayLevel(state))
}

internal fun micMeterHeights(level: Float): List<Float> {
    val value = level.coerceIn(0f, 1f)
    return listOf(6f + 8f * value, 6f + 12f * value, 6f + 9f * value)
}
