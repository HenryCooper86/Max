package io.github.henrycooper86.max.navigation

/** One turn on the route: what to do, where, and how long this step runs. */
data class ManeuverStep(
    val instruction: String,
    val coordinate: LatLon,
    /** Cumulative along-route distance from the route start to this maneuver,
     *  matching NavManeuver.alongRouteMeters on the wire. NOT a per-leg length. */
    val alongRouteMeters: Double,
    /** English wording of [instruction] when the relay supplies it (an English session). [instruction]
     *  stays the original (Chinese) text because clients parse it for maneuver icons. */
    val localizedInstruction: String? = null
) {
    /** What is displayed and spoken: the localized wording when there is one. */
    val spoken: String get() = localizedInstruction ?: instruction
}

/** The full route the engine needs — the geometry and turn list the relay
 *  hands us. */
data class NavigationRoute(
    val destinationName: String,
    val destination: LatLon,
    val polyline: List<LatLon>,
    val steps: List<ManeuverStep>,
    val distanceMeters: Double,
    val etaSeconds: Double,
    val relayCommandId: String? = null
)
