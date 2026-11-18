package io.github.henrycooper86.max.navigation

import kotlin.math.max
import kotlin.math.roundToInt

/** Distance bands at which a maneuver is announced. Each fires once per
 *  maneuver; thresholds are cleared when the engine advances to the next one. */
enum class PromptThreshold(val meters: Double) {
    FAR(400.0),
    NEAR(150.0),
    NOW(40.0)
}

/** The mutable state the engine advances across fixes. */
data class GuidanceProgress(
    val maneuverIndex: Int = 0,
    /** Thresholds already spoken for the *current* maneuver only; cleared on advance. */
    val firedThresholds: Set<PromptThreshold> = emptySet(),
    val arrived: Boolean = false
)

/** The engine's output for one fix. */
data class GuidanceUpdate(
    val progress: GuidanceProgress,
    val distanceToManeuverMeters: Double,
    val remainingMeters: Double,
    val remainingSeconds: Double,
    val offRoute: Boolean,
    val arrived: Boolean,
    val spokenPrompt: String?,
    /** Identity of the threshold that fired this tick, if any. The interrupt
     *  decision MUST key on this, never on `spokenPrompt` text: the "now"
     *  template is the bare instruction, with no marker left to grep for. */
    val firedThreshold: PromptThreshold?,
    val currentInstruction: String?,
    /** English wording of [currentInstruction] when the route carries one; [currentInstruction] stays the original for icon parsing. */
    val currentInstructionLocalized: String? = null
)

/**
 * Pure route math and prompt timing — no I/O, no Android location manager.
 * Every decision the rider's safety depends on lives here, so it can be
 * table-tested. Literal port of shared/guidance.ts's `step`: the constants,
 * the snap math (see Geo.kt), and the six rules below must stay identical to
 * the TypeScript/Swift siblings so guidance never diverges by device.
 *
 * Port contract shared with the TypeScript/Swift siblings
 * (shared/guidance.ts:128-170, adapted here) — keep these six rules
 * identical across platforms so guidance never diverges by device:
 *
 * 1. Single distance metric: every prompt threshold AND the "reached this
 *    maneuver" check both read the SAME along-route distance (maneuver
 *    `alongRouteMeters` minus the snapped along-route position). There is no
 *    second, straight-line-to-coordinate metric — a curved approach means
 *    haversine distance is a chord shorter than the along-route path, and
 *    mixing metrics lets "reached" (30 m) fire before "now" (40 m), skipping
 *    the safety-critical prompt entirely.
 * 2. Prompt-before-advance ordering: within one fix, the current maneuver's
 *    threshold prompt is decided FIRST, using its pre-advance distance; only
 *    then is the advance condition evaluated. A fix that both crosses the
 *    "now" threshold and reaches the maneuver in the same tick still speaks
 *    the prompt — the returned `progress` reflects the post-advance
 *    maneuver, but `spokenPrompt` is the one that just fired for the
 *    maneuver being left behind.
 * 3. Off-route freezes progression, not just prompts: while `offRoute` is
 *    true, `maneuverIndex` and `firedThresholds` carry through unchanged —
 *    no prompt fires and no advance happens, however far along the route the
 *    (untrusted) snapped position appears to be. Reroute policy is the
 *    caller's job; this function only reports the fact and waits.
 * 4. `arrived` is sticky: once true it stays true regardless of subsequent
 *    fixes (a noisy GPS reading after arrival must not un-arrive the
 *    rider). The caller resets it only by starting a fresh
 *    `GuidanceProgress` for a new route, never by an in-band "un-arrive"
 *    call.
 * 5. Snap tie-break: when two polyline segments are equidistant, the FIRST
 *    one in array order (lowest index) wins — the snap loop only replaces
 *    the best match on a strictly-smaller cross-track distance.
 * 6. Arrival is a DIFFERENT metric from rule 1 by design: it is the
 *    straight-line (haversine) distance from the fix to the route's final
 *    polyline vertex, not an along-route distance. It is evaluated on every
 *    fix regardless of `offRoute` — arrival wins over off-route, because a
 *    rider who is close enough to the destination but has drifted off the
 *    plotted polyline (parking lot, driveway, wrong side of a divided road)
 *    must still be told they've arrived. Like rule 4, arrival is sticky.
 */
object GuidanceEngine {
    private const val OFF_ROUTE_METERS = 50.0
    private const val ARRIVAL_METERS = 30.0
    private const val MANEUVER_ADVANCE_METERS = 30.0

    /** Advances guidance by one fix. Pure function of (position, route,
     *  progress): the caller supplies the previous `GuidanceProgress` and
     *  gets the next one back in `update.progress`, never mutated in place,
     *  so a fix can be re-run safely (e.g. after a GPS correction). */
    fun step(position: LatLon, route: NavigationRoute, progress: GuidanceProgress): GuidanceUpdate {
        val snap = Geo.snapToRoute(position, route.polyline)
        val offRoute = snap.crossTrackMeters > OFF_ROUTE_METERS

        val lastPoint = route.polyline.lastOrNull()
        val distanceToDestination = lastPoint?.let { Geo.haversineMeters(position, it) } ?: Double.POSITIVE_INFINITY
        val arrived = progress.arrived || distanceToDestination <= ARRIVAL_METERS

        var maneuverIndex = progress.maneuverIndex
        var firedThresholds = progress.firedThresholds
        var spokenPrompt: String? = null
        var firedThreshold: PromptThreshold? = null

        // Prompt-then-advance, gated entirely behind on-route — see rules 1-3 above.
        if (!offRoute) {
            val currentManeuver = if (maneuverIndex < route.steps.size) route.steps[maneuverIndex] else null
            if (currentManeuver != null) {
                val distanceToManeuver = max(0.0, currentManeuver.alongRouteMeters - snap.alongRouteMeters)

                val due = PromptThreshold.entries.filter { distanceToManeuver <= it.meters && it !in firedThresholds }
                if (due.isNotEmpty()) {
                    val urgent = due.reduce { most, candidate -> if (candidate.meters < most.meters) candidate else most }
                    firedThresholds = firedThresholds + due
                    firedThreshold = urgent
                    spokenPrompt = maneuverPrompt(currentManeuver, urgent == PromptThreshold.NOW, (distanceToManeuver / 50.0).roundToInt() * 50)
                }

                val reachedManeuver = distanceToManeuver <= MANEUVER_ADVANCE_METERS ||
                    snap.alongRouteMeters > currentManeuver.alongRouteMeters
                val hasNextManeuver = maneuverIndex + 1 < route.steps.size
                if (reachedManeuver && hasNextManeuver) {
                    maneuverIndex += 1
                    firedThresholds = emptySet()
                }
            }
        }

        val finalManeuver = if (maneuverIndex < route.steps.size) route.steps[maneuverIndex] else null
        val distanceToManeuverMeters = finalManeuver?.let { max(0.0, it.alongRouteMeters - snap.alongRouteMeters) }
            ?: max(0.0, route.distanceMeters - snap.alongRouteMeters)
        val currentInstruction = finalManeuver?.instruction
        val currentInstructionLocalized = finalManeuver?.localizedInstruction

        val remainingMeters = max(0.0, route.distanceMeters - snap.alongRouteMeters)
        val remainingSeconds = if (route.distanceMeters > 0) {
            route.etaSeconds * remainingMeters / route.distanceMeters
        } else {
            0.0
        }

        return GuidanceUpdate(
            progress = GuidanceProgress(maneuverIndex = maneuverIndex, firedThresholds = firedThresholds, arrived = arrived),
            distanceToManeuverMeters = distanceToManeuverMeters,
            remainingMeters = remainingMeters,
            remainingSeconds = remainingSeconds,
            offRoute = offRoute,
            arrived = arrived,
            spokenPrompt = if (offRoute) null else spokenPrompt,
            firedThreshold = if (offRoute) null else firedThreshold,
            currentInstruction = currentInstruction,
            currentInstructionLocalized = currentInstructionLocalized
        )
    }
}

/**
 * The spoken prompt for a maneuver. A step with a [ManeuverStep.localizedInstruction] is spoken in
 * English ("In 200 metres, turn right onto ..."); otherwise today's Chinese wording is used exactly.
 */
internal fun maneuverPrompt(step: ManeuverStep, now: Boolean, roundedMeters: Int): String {
    val english = step.localizedInstruction
    if (english != null) {
        if (now) return english
        return "In $roundedMeters metres, ${english.replaceFirstChar { it.lowercaseChar() }}"
    }
    return if (now) step.instruction else "前方${roundedMeters}米，${step.instruction}"
}
