package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.HazardLevel
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt

internal fun isHazardPresentationActive(state: AgentSession.State): Boolean =
    state.handsFree &&
        (state.connection == ConnectionState.RELAY || state.connection == ConnectionState.READY) &&
        state.fusedHazard != HazardLevel.NORMAL

/** Whether the guidance card should render: hands-free, the relay transport
 *  is up (or the provider is fully ready), and NavigationController has an
 *  active route published. `navGuidance` is never true through `arrived`
 *  (arrival publishes null), so there is no "arrived" branch to gate here. */
internal fun isNavPresentationActive(state: AgentSession.State): Boolean =
    state.handsFree &&
        (state.connection == ConnectionState.RELAY || state.connection == ConnectionState.READY) &&
        state.navGuidance != null

/** A bare distance, "1.2公里" / "850米" — the meters half of [formatRemaining],
 *  also used standalone for the card's distance-to-maneuver line (which has
 *  no associated duration). */
internal fun formatDistanceMeters(meters: Double): String =
    if (meters >= 1000) String.format(Locale.ROOT, "%.1f公里", meters / 1000) else "${meters.roundToInt()}米"

/** "1.2公里 · 4分钟" — remaining distance and time to the destination, for the
 *  guidance card. Minutes round UP (a nearly-finished minute still counts as
 *  a minute of riding left), mirroring the relay's ETA semantics. */
internal fun formatRemaining(meters: Double, seconds: Double): String {
    val minutes = ceil(seconds / 60).toInt()
    return "${formatDistanceMeters(meters)} · ${minutes}分钟"
}
