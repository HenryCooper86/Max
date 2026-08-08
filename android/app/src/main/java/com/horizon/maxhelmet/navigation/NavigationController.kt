package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.buildDeviceResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Task 6 implements this on AgentSession. `hazardActive` gates prompt
 *  DROPPING (spec: a suppressed maneuver prompt is dropped, not queued);
 *  `interrupt = true` must cut current playback first (stopAgentSpeech),
 *  used ONLY for NOW-identity prompts. */
interface NavSpeaker {
    val hazardActive: Boolean
    fun speak(text: String, interrupt: Boolean)
}

/** The state Task 6 mirrors into its own published `State` for the HUD.
 *  Always describes an active, on-route (or freshly committed) route —
 *  arrival clears guidance to `null` instead of ever publishing
 *  `arrived = true` through here; see [NavigationController.onFix]. */
data class NavGuidanceState(
    val destinationName: String,
    val currentInstruction: String?,
    val distanceToManeuverMeters: Double,
    val remainingMeters: Double,
    val remainingSeconds: Double,
    val offRoute: Boolean,
    val arrived: Boolean
)

/** One in-flight reroute attempt's captured inputs — everything
 *  [NavigationController.performReroute] needs after its `search.reroute`
 *  suspend call returns, without re-touching controller state before the
 *  post-answer generation check. */
private data class RerouteAttempt(
    val generation: Int,
    val destination: LatLon,
    val destinationName: String,
    val origin: LatLon
)

/**
 * Owns the active [NavigationRoute], the location stream, and the
 * reroute/arrival lifecycle for one navigation session. All route math is
 * delegated to [GuidanceEngine]; this class is orchestration, speech, and
 * truthful `device.result` bookkeeping.
 *
 * `ios/MaxHelmet/Navigation/NavigationController.swift` is the behavioral
 * reference (review-hardened through two fix waves on Plan B) — this mirrors
 * its semantics with Android's adjustments: GCJ-02 lives inside the app
 * (see `CoordinateDatum`'s file doc) — [onFix] is the ONLY datum call site,
 * converting a raw WGS-84 fix once; nothing downstream ever converts back.
 * Mutable state here is guarded by an explicit JVM lock instead of actor
 * isolation, since this module has no `@MainActor`/single-dispatcher
 * equivalent. One deliberate behavior improvement over the current iOS
 * source (a plan-mandated "parity-backlog fix", not a port bug): the reroute
 * cooldown and in-flight latch are reset on both start-commit and stop, so a
 * fresh route never inherits a previous route's cooldown window.
 *
 * Concurrency: every mutation of the fields below — and every synchronous
 * side effect that must be atomic with it ([LocationSource.start]/`stop`,
 * [NavSpeaker.speak], `onGuidance`) — happens inside a `synchronized(lock)`
 * block. Those are all plain (non-suspend) calls, so holding the lock across
 * them is safe and keeps each transition atomic, matching the single actor
 * hop the Swift reference gets for free. The three genuine suspension points
 * — [awaitFirstFix]'s continuation, `search.route`, `search.reroute` — always
 * happen OUTSIDE any lock section; Kotlin's `synchronized` cannot call a
 * `suspend` function at all, so that half of the discipline is enforced by
 * the compiler, not just convention.
 */
class NavigationController(
    private val search: RelayNavigationSearch,
    private val locationSource: LocationSource,
    private val speaker: NavSpeaker,
    private val sendResult: (String) -> Unit,
    private val onGuidance: (NavGuidanceState?) -> Unit,
    private val hasLocationPermission: () -> Boolean,
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    private val firstFixTimeoutMillis: Long = 3_000
) {
    private companion object {
        const val REROUTE_COOLDOWN_MILLIS = 20_000L
        const val STOP_SPOKEN = "已停止导航。"
        const val ARRIVED_SPOKEN = "已到达目的地。"
        const val REROUTE_SENDING_SPOKEN = "已偏离路线，正在重新规划。"
        const val REROUTE_FAILED_SPOKEN = "无法重新规划路线，已停止导航。"
        // "Never rerouted" without risking overflow when the cooldown check
        // computes `now() - lastRerouteAt`.
        const val NO_PRIOR_REROUTE = Long.MIN_VALUE / 2
    }

    /** Background home for the first-fix watchdog and in-flight reroute
     *  continuations — both must keep running independent of whichever
     *  caller's coroutine invoked `handleCommand`/`onFix`. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Guards every field below. See the class doc for what may run inside a
     *  `synchronized(lock)` block (state + plain-function side effects) and
     *  what may never (anything `suspend`). */
    private val lock = Any()

    private var route: NavigationRoute? = null
    private var progress = GuidanceProgress()
    private var rerouting = false
    private var lastRerouteAt = NO_PRIOR_REROUTE
    /** Resolves with the GCJ-02 value [onFix] already converted — never a
     *  second `wgs84ToGcj02` application. */
    private var firstFixContinuation: CompletableDeferred<LatLon?>? = null
    private var firstFixWatchdog: Job? = null

    /** Bumped once per `navigation.start` attempt and once per explicit
     *  stop/teardown — never on arrival or a successful reroute. Every
     *  superseded operation's eventual answer (a stale first fix, a stale
     *  route search, a stale reroute) checks this before touching [route] or
     *  [locationSource]. */
    private var navigationGeneration = 0

    /** Handles navigation.start / navigation.stop; exactly one device.result
     *  per call. */
    suspend fun handleCommand(commandId: String, action: String, query: String?) {
        when (action) {
            "navigation.start" -> handleStart(commandId, query.orEmpty())
            "navigation.stop" -> handleStop(commandId)
            else -> sendResult(buildDeviceResult(commandId, "unsupported", "action.mismatch"))
        }
    }

    private suspend fun handleStart(commandId: String, query: String) {
        if (!hasLocationPermission()) {
            sendResult(buildDeviceResult(commandId, "denied", "permission.location"))
            return
        }

        // Each attempt gets its own generation so a superseded attempt — at
        // any stage — can tell it is no longer the one responsible for
        // `route`/the stream before touching either.
        val generation = synchronized(lock) { ++navigationGeneration }

        // The first fix must be in hand BEFORE searching: the relay routes
        // FROM the rider's position, so there is no query to send without it.
        // [awaitFirstFix] resolves with [onFix]'s already-GCJ-02 value —
        // `wgs84ToGcj02` is a nonlinear warp, NOT idempotent, so converting
        // it again here would silently corrupt the origin; onFix (THE datum
        // edge) is the only place this fix is ever converted.
        locationSource.start(::onFix)
        val origin = awaitFirstFix(generation)
        if (origin == null) {
            stopSourceIfOrphaned(generation)
            sendResult(buildDeviceResult(commandId, "unsupported", "route.unavailable"))
            return
        }

        val resolved = search.route(query, origin)
        if (resolved == null) {
            stopSourceIfOrphaned(generation)
            sendResult(buildDeviceResult(commandId, "unsupported", "route.unavailable"))
            return
        }

        val committed = synchronized(lock) {
            if (generation != navigationGeneration) {
                // Superseded while the search was in flight — the newer
                // generation now owns `route`/the stream; do not stomp on it.
                return@synchronized false
            }
            commitRouteLocked(resolved)
            // Parity-backlog fix (see class doc): a fresh route must not
            // inherit a stale cooldown from whatever this generation
            // superseded.
            rerouting = false
            lastRerouteAt = NO_PRIOR_REROUTE
            true
        }
        sendResult(
            if (committed) {
                buildDeviceResult(commandId, "ok")
            } else {
                buildDeviceResult(commandId, "unsupported", "route.unavailable")
            }
        )
    }

    private fun handleStop(commandId: String) {
        val hadActiveRoute = synchronized(lock) {
            if (route == null) return@synchronized false
            // An explicit stop is a deliberate "cancel everything": any
            // start or reroute already in flight must never revive
            // navigation once its answer arrives late.
            navigationGeneration += 1
            val pendingFix = takePendingFirstFixLocked()
            route = null
            rerouting = false
            lastRerouteAt = NO_PRIOR_REROUTE
            locationSource.stop()
            onGuidance(null)
            speaker.speak(STOP_SPOKEN, interrupt = false)
            pendingFix?.complete(null)
            true
        }
        sendResult(
            if (hadActiveRoute) {
                buildDeviceResult(commandId, "ok")
            } else {
                buildDeviceResult(commandId, "failed", "navigation.notActive")
            }
        )
    }

    /** Session teardown: stop guidance silently (no speech, no result) — for
     *  socket death, where there is no one left to answer and nothing left
     *  to hear it. Unconditional — never distinguishes "was navigation
     *  active" from "was it not": a start can be suspended with `route`
     *  still null (its first fix already resolved, its `search.route`
     *  answer already queued to resume on [scope]'s dispatcher but not yet
     *  run) at the exact instant the socket dies. Bumping the generation and
     *  resolving any pending first-fix wait here — unconditionally, before
     *  that queued resumption runs — is what stops it from later passing the
     *  generation check and committing a route onto a session nothing can
     *  ever stop again (no navigation.stop can arrive on a dead socket). The
     *  rest ([locationSource.stop], `onGuidance(null)`, the reroute-latch
     *  reset) are safe no-ops when nothing was running.
     *
     *  Does NOT cancel [scope] — the controller is reusable across session
     *  cycles: Task 6 wires it as a long-lived field of `AgentSession`,
     *  itself a process-wide singleton whose `stop()`/`start()` (and
     *  therefore this `teardown()`) cycles repeatedly on the same instance
     *  across every hands-free toggle, idle close, and reconnect. Cancelling
     *  `scope` here would kill it for the rest of the process: a later
     *  `navigation.start`'s first-fix watchdog would launch onto a dead
     *  scope and never run, hanging that start forever with no
     *  device.result, and a later reroute's `scope.launch { performReroute
     *  }` would never run its body — spoken and cooldown-stamped but never
     *  actually sent, with `rerouting` stuck true. The generation bump above
     *  is what closes the dead-session race; the scope itself must outlive
     *  any one `teardown()` call. */
    fun teardown() {
        synchronized(lock) {
            navigationGeneration += 1
            val pendingFix = takePendingFirstFixLocked()
            route = null
            rerouting = false
            lastRerouteAt = NO_PRIOR_REROUTE
            locationSource.stop()
            onGuidance(null)
            pendingFix?.complete(null)
        }
    }

    /** Feed one raw WGS-84 fix (the location callback and tests both enter
     *  here). Synchronous — never suspends, never blocks on I/O; the one
     *  suspending consequence (a reroute search) is dispatched onto [scope]. */
    fun onFix(wgsFix: LatLon) {
        val fix = CoordinateDatum.wgs84ToGcj02(wgsFix)
        resolveFirstFix(fix)

        val reroute = synchronized(lock) {
            val currentRoute = route ?: return
            val update = GuidanceEngine.step(fix, currentRoute, progress)
            progress = update.progress

            if (update.firedThreshold != null) {
                val prompt = update.spokenPrompt
                if (prompt != null && !speaker.hazardActive) {
                    speaker.speak(prompt, interrupt = update.firedThreshold == PromptThreshold.NOW)
                }
                // hazardActive: the prompt is DROPPED, not queued or ever
                // re-spoken — `progress` above already recorded the
                // threshold as fired regardless of whether it was spoken.
            }

            if (update.arrived) {
                // Arrival retires only THIS route. Deliberately does not
                // bump navigationGeneration: a start already in progress for
                // a different destination must be free to land — its own
                // commit site re-asserts the stream, so a route that commits
                // after this cleanup is never streamless. (A reroute already
                // in flight for THIS SAME route is a different story — see
                // performReroute's route-null guard below.)
                speaker.speak(ARRIVED_SPOKEN, interrupt = false)
                route = null
                onGuidance(null)
                locationSource.stop()
                return@synchronized null
            }

            onGuidance(publishedState(currentRoute, update))

            if (update.offRoute && !rerouting && now() - lastRerouteAt >= REROUTE_COOLDOWN_MILLIS) {
                rerouting = true
                lastRerouteAt = now()
                speaker.speak(REROUTE_SENDING_SPOKEN, interrupt = false)
                RerouteAttempt(
                    generation = navigationGeneration,
                    destination = currentRoute.destination,
                    destinationName = currentRoute.destinationName,
                    origin = fix
                )
            } else {
                null
            }
        }

        if (reroute != null) scope.launch { performReroute(reroute) }
    }

    private suspend fun performReroute(attempt: RerouteAttempt) {
        try {
            val fresh = search.reroute(attempt.destination, attempt.destinationName, attempt.origin)
            synchronized(lock) {
                // Guarded BEFORE either branch, on TWO conditions:
                // (1) a stale answer (this generation was superseded by a
                // stop or a newer start while the reroute was in flight)
                // must not touch `route`/the stream — the newer generation
                // already owns them, or owns nothing at all after an
                // explicit stop; (2) `route == null` catches the one case
                // where the generation check alone is not enough: arrival on
                // THIS SAME route, which deliberately does not bump the
                // generation (see onFix) so an unrelated concurrent start
                // can still land. Without this second check, a reroute
                // launched one tick before arrival would pass the
                // generation-only guard and — on success — restart the
                // stream and reinstall a route the rider was just told had
                // finished ("已到达目的地。"), or — on failure — speak
                // "无法重新规划路线，已停止导航。" right after it. Either
                // branch is moot once the route it was fixing is gone.
                if (attempt.generation != navigationGeneration || route == null) return@synchronized
                if (fresh != null) {
                    // Re-assert for the same reason start()'s commit does: an
                    // arrival teardown on this same route may have stopped
                    // the stream while this reroute was in flight. Does NOT
                    // reset lastRerouteAt/rerouting here — the cooldown
                    // keeps counting from this attempt's own send time, so a
                    // route that goes off-route again immediately after a
                    // successful reroute still respects it.
                    commitRouteLocked(fresh)
                } else {
                    // A genuine reroute failure is itself a "stop everything"
                    // event — bump the generation for the same reason
                    // handleStop does, so nothing still tied to this
                    // generation can later revive what was just torn down.
                    navigationGeneration += 1
                    route = null
                    onGuidance(null)
                    locationSource.stop()
                    speaker.speak(REROUTE_FAILED_SPOKEN, interrupt = false)
                }
            }
        } finally {
            // Clears on every exit path — including the stale-generation
            // guard above — so a reroute attempt that gets preempted (e.g.
            // by a concurrent start winning RelayNavigationSearch's single
            // outstanding slot) never leaves the latch stuck true.
            synchronized(lock) { rerouting = false }
        }
    }

    /** Must be called while already holding [lock]. Re-asserts the location
     *  stream (idempotent — a teardown elsewhere, e.g. this same route's own
     *  prior arrival, may have stopped it since the caller's own
     *  `locationSource.start` upstream ran), installs `resolved` as the
     *  active route with fresh progress, and publishes its initial state. A
     *  route is never committed onto a stream that isn't (re-)started in
     *  this same synchronous block. */
    private fun commitRouteLocked(resolved: NavigationRoute) {
        locationSource.start(::onFix)
        route = resolved
        progress = GuidanceProgress()
        onGuidance(initialState(resolved))
    }

    /** Awaits the location stream's first fix, resolving with [onFix]'s
     *  already-GCJ-02-converted value (never re-converted here — see the
     *  call site). Bounded so a stalled GPS never hangs navigation.start
     *  indefinitely. Single-outstanding,
     *  mirroring `RelayNavigationSearch.awaitAnswer`: preempting any wait
     *  already in flight and installing this one happen in ONE synchronized
     *  block, so a third, truly parallel caller can never slip a
     *  registration into the gap between "take the old" and "install the
     *  new" and orphan a deferred.
     *
     *  The watchdog checks `generation` and takes the pending continuation
     *  in that SAME synchronized block — not two separate acquisitions — so
     *  a newer generation's fresh registration (which happens after this
     *  one's own generation is superseded) can never be resolved by an
     *  older, still-sleeping watchdog. */
    private suspend fun awaitFirstFix(generation: Int): LatLon? {
        val deferred = CompletableDeferred<LatLon?>()
        val preempted = synchronized(lock) {
            val previous = takePendingFirstFixLocked()
            firstFixContinuation = deferred
            firstFixWatchdog = scope.launch {
                delay(firstFixTimeoutMillis)
                val timedOut = synchronized(lock) {
                    if (generation != navigationGeneration) return@launch
                    takePendingFirstFixLocked()
                }
                timedOut?.complete(null)
            }
            previous
        }
        preempted?.complete(null)
        return deferred.await()
    }

    /** Unconditionally resolves whatever first-fix wait is currently pending
     *  (a no-op if none) — used both by a real fix arriving ([onFix]) and by
     *  an explicit stop/teardown invalidating an in-flight start. */
    private fun resolveFirstFix(coordinate: LatLon?) {
        synchronized(lock) { takePendingFirstFixLocked() }?.complete(coordinate)
    }

    /** Must be called while already holding [lock]. Clears and returns any
     *  pending first-fix continuation and cancels its watchdog; the caller
     *  completes the returned deferred (if non-null) itself. */
    private fun takePendingFirstFixLocked(): CompletableDeferred<LatLon?>? {
        val pending = firstFixContinuation
        firstFixContinuation = null
        firstFixWatchdog?.cancel()
        firstFixWatchdog = null
        return pending
    }

    /** Only stop the stream if nothing else is relying on it: a still-active
     *  route from an earlier, already-succeeded start, or a newer generation
     *  that superseded this one and is still in flight, must keep it running. */
    private fun stopSourceIfOrphaned(generation: Int) {
        synchronized(lock) {
            if (generation == navigationGeneration && route == null) {
                locationSource.stop()
            }
        }
    }

    private fun publishedState(route: NavigationRoute, update: GuidanceUpdate): NavGuidanceState = NavGuidanceState(
        destinationName = route.destinationName,
        currentInstruction = update.currentInstruction,
        distanceToManeuverMeters = update.distanceToManeuverMeters,
        remainingMeters = update.remainingMeters,
        remainingSeconds = update.remainingSeconds,
        offRoute = update.offRoute,
        arrived = update.arrived
    )

    private fun initialState(route: NavigationRoute): NavGuidanceState = NavGuidanceState(
        destinationName = route.destinationName,
        currentInstruction = route.steps.firstOrNull()?.instruction,
        distanceToManeuverMeters = route.distanceMeters,
        remainingMeters = route.distanceMeters,
        remainingSeconds = route.etaSeconds,
        offRoute = false,
        arrived = false
    )
}
