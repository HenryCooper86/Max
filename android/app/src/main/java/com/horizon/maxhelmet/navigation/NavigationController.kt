package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.buildDeviceResult
import org.json.JSONObject
import java.util.UUID
import java.util.Locale
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
    val attemptId: Long,
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
    private val firstFixTimeoutMillis: Long = 8_000,
    private val firstFixAnnounceMillis: Long = 1_500,
    private val sendRelayPrompt: ((String) -> Unit)? = null
) {
    private companion object {
        const val REROUTE_COOLDOWN_MILLIS = 20_000L
        const val STOP_SPOKEN = "已停止导航。"
        const val ARRIVED_SPOKEN = "已到达目的地。"
        const val REROUTE_SENDING_SPOKEN = "已偏离路线，正在重新规划。"
        const val REROUTE_FAILED_SPOKEN = "无法重新规划路线，已停止导航。"
        // Nav-first-fix-retry Task 3 (Android parity with iOS commit
        // af85730): a fix that is merely slow must not sound like a routing
        // failure. LOCATING_SPOKEN covers the wait; NO_FIX_DETAIL names the
        // cause on the rare timeout that still happens — see awaitFirstFix
        // and handleStart's first no-route exit.
        const val LOCATING_SPOKEN = "正在定位…"
        const val NO_FIX_DETAIL = "还没定位到，到室外或空旷处再说一次。"
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
    private var rerouteAttemptId = 0L
    private var lastRerouteAt = NO_PRIOR_REROUTE
    /** Resolves with the GCJ-02 value [onFix] already converted — never a
     *  second `wgs84ToGcj02` application. */
    private var firstFixContinuation: CompletableDeferred<LatLon?>? = null
    private var firstFixWatchdog: Job? = null
    /** Speaks [LOCATING_SPOKEN] once the fix has been pending for
     *  [firstFixAnnounceMillis] — see [awaitFirstFix] for its registration
     *  and [takePendingFirstFixLocked] for its single teardown point. */
    private var firstFixAnnounce: Job? = null

    /** True from the generation bump inside [handleStart] until that SAME
     *  generation's own terminal exit (first-fix timeout, an unresolved
     *  search, the stale-generation guard, or a successful commit — see
     *  `handleStart`'s `finally`). A superseded attempt's own exit leaves
     *  this alone: its captured `generation` no longer matches
     *  [navigationGeneration], so it knows a later attempt already owns it
     *  and already cleared this itself. That "later attempt" is never the
     *  superseded one's own `finally` in that case — it is whichever of the
     *  FOUR sites bumps [navigationGeneration] ([handleStart]'s own next
     *  call, [handleStop], [teardown], or [performReroute]'s failure
     *  branch), and every one of them clears `starting` explicitly alongside
     *  its own bump for exactly that reason: none of them can rely on a
     *  stale attempt's exit to do it on their behalf. [handleStop] reads
     *  this to tell "a start is genuinely in flight, with no route
     *  committed yet" apart from "nothing is happening at all" — both
     *  otherwise look identical as `route == null`. Ported from
     *  `ios/MaxHelmet/Navigation/NavigationController.swift`'s `starting`
     *  (nav-parity-closure Task 4, mirroring Task 3's fix round — see that
     *  file's doc comment and commit e06995c for the "every bump site must
     *  clear it" lesson this already applies proactively). */
    private var starting = false

    /** Bumped once per `navigation.start` attempt and once per explicit
     *  stop/teardown/reroute-failure — never on arrival or a successful
     *  reroute. Every superseded operation's eventual answer (a stale first
     *  fix, a stale route search, a stale reroute) checks this before
     *  touching [route] or [locationSource]. */
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
        // `route`/the stream before touching either. `starting` stays true
        // until THIS generation's own terminal exit (the `finally` below) —
        // [handleStop] reads it to recognize a genuinely in-flight start
        // even before any [route] is ever committed.
        //
        // `locationSource.start` is folded into this SAME synchronized block
        // as the bump — fix-round-1 Important: when it lived in a SEPARATE
        // `synchronized(lock) { ... }` right after this one, a concurrent
        // stop/teardown landing in the gap between the two blocks would call
        // `locationSource.stop()` and then, with no generation re-check, this
        // statement would unconditionally start it right back up — on a
        // generation the bump above already made stale, so
        // [stopSourceIfOrphaned]'s `generation == navigationGeneration` guard
        // would forever refuse to stop it again. That's a permanently leaked
        // GPS listener feeding phantom fixes into the shared `onFix`/
        // `resolveFirstFix` path (which could spuriously resolve a LATER
        // start's first-fix wait) until the next teardown. Merging the two
        // means a stop/teardown can now only land before this block or
        // after it — never inside it. Landing before: it's whatever THAT
        // stop/teardown invalidated (an earlier attempt) that goes stale,
        // not this one — this block's own bump, captured below before
        // `locationSource.start` runs, is a strictly newer generation than
        // anything the stop just bumped past, so this start is never
        // mistaken for stale by its own hand. Landing after: the stop's own
        // `locationSource.stop()` wins, since nothing between here and the
        // eventual `stopSourceIfOrphaned`/`awaitFirstFix` touches the source
        // again — the window is structurally gone, same discipline
        // `commitRouteLocked` already uses to keep its own
        // `locationSource.start` atomic with its generation check.
        // `locationSource.start` is a plain non-suspending call, so holding
        // the lock across it is safe (see the class doc).
        val generation = synchronized(lock) {
            navigationGeneration += 1
            starting = true
            // Captured BEFORE `locationSource.start` below, not after —
            // fix-round-2: `locationSource.start` runs a caller-supplied
            // implementation, and while the lock makes that call atomic
            // with respect to another THREAD's stop/teardown, it does not
            // block a REENTRANT one on this same thread (Kotlin's
            // `synchronized` is a JVM monitor, reentrant per-thread) — a
            // `LocationSource.start` that itself, synchronously, triggers a
            // stop/teardown would bump `navigationGeneration` before this
            // block returns. Capturing `generation` after that call would
            // silently absorb that bump into THIS start's own generation,
            // making it indistinguishable from "never superseded" — which
            // could in principle carry a stale attempt past the commit
            // guard below (`generation != navigationGeneration`) onto a
            // session `teardown` just tore down, the exact invariant
            // `teardown`'s own KDoc promises callers. Capturing here, before
            // the call, keeps `generation` a true snapshot of "this
            // attempt's identity at the moment it was born" — untouched by
            // anything `locationSource.start` itself goes on to do.
            val generation = navigationGeneration
            // The first fix must be in hand BEFORE searching: the relay
            // routes FROM the rider's position, so there is no query to send
            // without it. Two concurrent navigation.start commands (each its
            // own coroutine; nothing upstream serializes them) could
            // otherwise both observe an unstarted source and both register a
            // GPS listener if this weren't locked, and only the
            // last-assigned one is ever removed by a later `stop()` — the
            // other leaks for the process lifetime: GPS held on permanently,
            // phantom fixes flowing, unfixable by any later stop/teardown
            // since neither knows the orphaned listener exists.
            locationSource.start(::onFix)
            generation
        }
        try {
            // [awaitFirstFix] resolves with [onFix]'s already-GCJ-02 value —
            // `wgs84ToGcj02` is a nonlinear warp, NOT idempotent, so
            // converting it again here would silently corrupt the origin;
            // onFix (THE datum edge) is the only place this fix is ever
            // converted.
            val origin = awaitFirstFix()
            if (origin == null) {
                stopSourceIfOrphaned(generation)
                // Locates the cause: a genuinely no-fix timeout is not a
                // routing failure, so it gets its own detail — the search
                // exit just below deliberately does not (see startFailureResult).
                sendResult(startFailureResult(commandId, generation, NO_FIX_DETAIL))
                return
            }

            val resolved = search.route(query, origin)
            if (resolved == null) {
                stopSourceIfOrphaned(generation)
                sendResult(startFailureResult(commandId, generation))
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
                    startFailureResult(commandId, generation)
                }
            )
        } finally {
            // Only THIS generation's own exit clears the latch — a stale
            // attempt (superseded by a newer start, an explicit stop, or a
            // reroute failure) must leave it alone: whichever of the other
            // three sites bumped `navigationGeneration` past this attempt's
            // own already cleared it itself (see `starting`'s doc comment).
            synchronized(lock) { if (generation == navigationGeneration) starting = false }
        }
    }

    /** A start exit with no route in hand: "route.unavailable" when this
     *  generation is still the current one (a genuine failure — no fix, or
     *  no route, while nothing else touched navigation state in the
     *  meantime), or "navigation.cancelled" when a newer start, an explicit
     *  stop, or a reroute failure already superseded it while it waited.
     *
     *  [detail] is only ever [NO_FIX_DETAIL], passed by the no-fix exit; the
     *  search-failure exit leaves it null since the fix DID land there — a
     *  location-specific detail would be a lie once the relay is the one
     *  that failed. Meaningless (and never passed) on the
     *  "navigation.cancelled" branch, which isn't a route failure at all. */
    private fun startFailureResult(commandId: String, generation: Int, detail: String? = null): String {
        val current = synchronized(lock) { navigationGeneration }
        return if (generation == current) {
            buildDeviceResult(commandId, "unsupported", "route.unavailable", detail)
        } else {
            buildDeviceResult(commandId, "failed", "navigation.cancelled")
        }
    }

    private fun handleStop(commandId: String) {
        val result = synchronized(lock) {
            val hadRoute = route != null
            // No route committed yet AND no start in flight (`starting`) is
            // the only genuine "nothing to stop" case — a start awaiting its
            // first fix or the relay's search is very much something to
            // cancel, even though `route` itself is still null at that
            // point too.
            if (!hadRoute && !starting) {
                return@synchronized buildDeviceResult(commandId, "failed", "navigation.notActive")
            }
            // An explicit stop is a deliberate "cancel everything": any
            // start or reroute already in flight must never revive
            // navigation once its answer arrives late.
            navigationGeneration += 1
            starting = false
            val pendingFix = takePendingFirstFixLocked()
            pendingFix?.complete(null)
            // Nav-fast-follow Task 4 hoist (mirrors iOS's stopGuidance,
            // commit 8c33ab3): fail whatever the search itself is currently
            // holding — UNCONDITIONALLY, not only in the "no route yet"
            // branch below. Android can hold a committed route AND an
            // in-flight second start (or reroute) at the same time; a stop
            // in that state must not leave that second request's
            // nav.request suspended until the relay's own ~7 s timeout —
            // that would tear down the active route's guidance now and only
            // deliver the superseded request's own "已取消导航。" up to 7 s
            // later, as a stray non-sequitur. A no-op when nothing is held.
            // Safe even when a route IS active: the bump above (plus
            // `route = null` below in the hadRoute branch) makes any
            // in-flight reroute answer this could also resolve fail
            // performReroute's own guard (generation match AND
            // route != null), so this can never trigger the
            // reroute-failure teardown speech.
            search.failPending()
            if (hadRoute) {
                route = null
                rerouting = false
                lastRerouteAt = NO_PRIOR_REROUTE
                locationSource.stop()
                onGuidance(null)
                if (sendRelayPrompt == null) speaker.speak(STOP_SPOKEN, interrupt = false)
            } else {
                // No route yet, but a start was genuinely in flight, and
                // nothing else needs the source anymore. Silent here: the
                // cancelled start's own device.result (navigation.cancelled)
                // is what the relay's failure-speech map speaks —
                // "已取消导航。" — once it arrives, not this stop's own `ok`.
                locationSource.stop()
            }
            buildDeviceResult(commandId, "ok")
        }
        sendResult(result)
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
            // A fourth generation-bump site (alongside handleStart,
            // handleStop, and performReroute's failure branch) — must clear
            // `starting` too, for the same reason the other three do: a
            // start superseded by THIS bump can never clear the latch via
            // its own exit once stale, so leaving it to that alone would
            // strand `starting` true forever, and a later genuinely-idle
            // stop would wrongly answer `ok`.
            starting = false
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
            val maneuverIndex = progress.maneuverIndex
            val update = GuidanceEngine.step(fix, currentRoute, progress)
            progress = update.progress

            if (!update.arrived && update.firedThreshold != null) {
                val prompt = update.spokenPrompt
                if (prompt != null && !speaker.hazardActive) {
                    val alongRoute = currentRoute.distanceMeters - update.remainingMeters
                    val distance = (currentRoute.steps[maneuverIndex].alongRouteMeters - alongRoute).coerceAtLeast(0.0)
                    if (!relayPrompt(currentRoute, "maneuver", maneuverIndex, update.firedThreshold.name.lowercase(Locale.ROOT), distance)) {
                        speaker.speak(prompt, interrupt = update.firedThreshold == PromptThreshold.NOW)
                    }
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
                if (!relayPrompt(currentRoute, "arrived")) speaker.speak(ARRIVED_SPOKEN, interrupt = false)
                route = null
                onGuidance(null)
                locationSource.stop()
                return@synchronized null
            }

            onGuidance(publishedState(currentRoute, update))

            if (update.offRoute && !rerouting && now() - lastRerouteAt >= REROUTE_COOLDOWN_MILLIS) {
                rerouting = true
                rerouteAttemptId += 1
                lastRerouteAt = now()
                if (!relayPrompt(currentRoute, "offRoute")) speaker.speak(REROUTE_SENDING_SPOKEN, interrupt = false)
                RerouteAttempt(
                    attemptId = rerouteAttemptId,
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
                    // This is the third of the four generation-bump sites
                    // (alongside handleStart, handleStop, and teardown): it
                    // must clear `starting` too, exactly like the others —
                    // a start superseded by THIS bump (its generation
                    // captured by the reroute this failure resolves) can
                    // never clear the latch via its own exit once stale, so
                    // leaving it to that alone would strand `starting` true
                    // forever, and a later genuinely-idle stop would
                    // wrongly answer `ok`.
                    navigationGeneration += 1
                    starting = false
                    route?.let { if (!relayPrompt(it, "rerouteFailed")) speaker.speak(REROUTE_FAILED_SPOKEN, interrupt = false) }
                    route = null
                    rerouting = false
                    onGuidance(null)
                    locationSource.stop()
                }
            }
        } finally {
            // An older completion must not clear a newer route's reroute latch.
            synchronized(lock) { if (attempt.attemptId == rerouteAttemptId) rerouting = false }
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
     *  The watchdog resolves on DEFERRED IDENTITY (`firstFixContinuation
     *  === deferred`), not generation — checked and taken in the SAME
     *  synchronized block, not two separate acquisitions. A generation-only
     *  guard would protect a newer registration from an older, stale
     *  watchdog, but it ALSO refuses a start's own watchdog from resolving
     *  its own still-current registration whenever an unrelated stop/
     *  teardown bumps the generation in the gap between this start's
     *  generation snapshot and its own registration below — hanging that
     *  start forever with no `device.result` (breaking the exact "no GPS in
     *  the garage" case this watchdog exists to self-heal). Identity is
     *  correct in both directions without that gap: an older watchdog's
     *  captured `deferred` can never equal whatever object a NEWER
     *  registration installed, and THIS watchdog's own `deferred` stays the
     *  one pending exactly until something legitimately consumes it — a
     *  real fix, an explicit stop/teardown, or this watchdog itself. */
    private suspend fun awaitFirstFix(): LatLon? {
        val deferred = CompletableDeferred<LatLon?>()
        val preempted = synchronized(lock) {
            val previous = takePendingFirstFixLocked()
            firstFixContinuation = deferred
            // Spoken once, and only while THIS wait is still pending: a fix
            // that lands first (or an explicit stop/teardown) tears this down
            // via takePendingFirstFixLocked before it ever fires, so the
            // rider never hears "locating" after guidance has already begun
            // — same deferred-identity guard the watchdog just below uses,
            // for the same reason (see its own doc comment). Unlike the
            // watchdog, the identity check and the resulting action
            // (`speaker.speak`) must both run INSIDE the same synchronized
            // block, not just the check: the watchdog's post-lock
            // `.complete()` is safe on its own because `takePendingFirstFixLocked`
            // already exclusively claimed the continuation before the lock
            // was released, but a `speaker.speak` gated on a bare read-then-
            // act outside the lock would leave a window between "still
            // pending" and "spoken" where a concurrent stop/fix/supersession
            // could invalidate the wait and this would fire anyway — the
            // narrow race review caught in fix round 1. `NavSpeaker.speak` is
            // a plain, non-suspend call, so holding the lock across it is
            // safe and matches this file's existing convention (see the
            // class doc; e.g. STOP_SPOKEN in handleStop).
            firstFixAnnounce = scope.launch {
                delay(firstFixAnnounceMillis)
                synchronized(lock) {
                    if (firstFixContinuation === deferred) speaker.speak(LOCATING_SPOKEN, interrupt = false)
                }
            }
            firstFixWatchdog = scope.launch {
                delay(firstFixTimeoutMillis)
                val timedOut = synchronized(lock) {
                    if (firstFixContinuation !== deferred) return@launch
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
        // Cancelled with the watchdog: a fix landing just before the deadline
        // must not still announce "locating" afterwards.
        firstFixAnnounce?.cancel()
        firstFixAnnounce = null
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

    private fun relayPrompt(route: NavigationRoute, kind: String, maneuverIndex: Int? = null,
                            threshold: String? = null, distanceMeters: Double? = null): Boolean {
        val send = sendRelayPrompt ?: return false
        val commandId = route.relayCommandId ?: return true
        val payload = JSONObject().apply {
            put("type", "nav.prompt")
            put("promptId", UUID.randomUUID().toString())
            put("routeCommandId", commandId)
            put("kind", kind)
            if (maneuverIndex != null) put("maneuverIndex", maneuverIndex)
            if (threshold != null) put("threshold", threshold)
            if (distanceMeters != null) put("distanceMeters", distanceMeters)
        }
        send(payload.toString())
        return true
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
