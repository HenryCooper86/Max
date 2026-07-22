package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.HazardLevel

internal fun isHazardPresentationActive(state: AgentSession.State): Boolean =
    state.handsFree &&
        (state.connection == ConnectionState.RELAY || state.connection == ConnectionState.READY) &&
        state.fusedHazard != HazardLevel.NORMAL
