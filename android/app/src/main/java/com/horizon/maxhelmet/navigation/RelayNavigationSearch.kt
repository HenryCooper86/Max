package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.agent.NavRouteData
import com.horizon.maxhelmet.agent.buildNavRequest
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Relay-backed navigation search: turns `route`/`reroute` into a `nav.request`
 * over the agent socket, then suspends until `AgentSession` forwards the
 * matching `nav.route`/`nav.error` answer back through `handleNavRoute`/
 * `handleNavError` — or until the client-side timeout or `failPending()`
 * (socket teardown) resolves it instead. No fallback of any kind: a relay
 * that never answers is an honest `null`, not a silent retry elsewhere.
 *
 * Every coordinate here is GCJ-02 already: `origin`/`destination` arrive
 * GCJ-02 from the controller's fix boundary, and `NavRouteData`'s wire
 * coordinates are copied verbatim into the assembled `NavigationRoute`. No
 * `CoordinateDatum` import in this file — a conversion here would be a
 * defect; Android speaks GCJ-02 end to end, unlike the iOS counterpart,
 * which crosses the WGS-84/GCJ-02 boundary because it stores WGS-84.
 *
 * ios/MaxHelmet/Navigation/RelayNavigationSearch.swift is the behavioral
 * reference; this is its coroutine-shaped equivalent — `CompletableDeferred`
 * + `withTimeoutOrNull` standing in for `CheckedContinuation` + a detached
 * watchdog `Task`.
 */
class RelayNavigationSearch(
    private val send: (String) -> Unit,
    private val timeoutMillis: Long = 7_000 // under the relay's 8 s device backstop
) {
    /** Guards the two fields below. Every completion path — a matching
     *  `handleNavRoute`/`handleNavError`, the await timeout, `failPending`,
     *  and a second concurrent request preempting the first — funnels
     *  through [takePending], the single lock-guarded take-and-clear: only
     *  the first caller to match a held commandId ever completes its
     *  deferred, and `CompletableDeferred.complete` being idempotent is the
     *  second net on top of that. Never held across a suspension point. */
    private val lock = Any()
    private var pendingCommandId: String? = null
    private var pendingDeferred: CompletableDeferred<NavigationRoute?>? = null

    /** reason "start". Origin is GCJ-02 (the controller converted the fix). */
    suspend fun route(query: String, origin: LatLon): NavigationRoute? {
        val commandId = "nav-" + UUID.randomUUID()
        val request = buildNavRequest(
            commandId = commandId,
            reason = "start",
            originLat = origin.lat,
            originLon = origin.lon,
            query = query
        )
        return awaitAnswer(commandId, request)
    }

    /** reason "reroute": echoes the stored GCJ destination verbatim. */
    suspend fun reroute(destination: LatLon, destinationName: String, origin: LatLon): NavigationRoute? {
        val commandId = "nav-" + UUID.randomUUID()
        val request = buildNavRequest(
            commandId = commandId,
            reason = "reroute",
            originLat = origin.lat,
            originLon = origin.lon,
            destinationLat = destination.lat,
            destinationLon = destination.lon,
            destinationName = destinationName
        )
        return awaitAnswer(commandId, request)
    }

    /** The relay answered the held request: assemble the route, copying
     *  every wire coordinate verbatim (GCJ-02 passthrough), and complete it.
     *  A commandId that doesn't match whatever is currently held is a
     *  stale/unrelated answer and is ignored — the real pending request, if
     *  any, keeps waiting for its own answer or its own timeout. */
    fun handleNavRoute(data: NavRouteData) {
        val deferred = takePending(data.commandId) ?: return
        deferred.complete(
            NavigationRoute(
                destinationName = data.destinationName,
                destination = data.destination,
                polyline = data.polyline,
                steps = data.steps,
                distanceMeters = data.distanceMeters,
                etaSeconds = data.etaSeconds
            )
        )
    }

    /** The relay could not resolve or route the held request: resume with an
     *  honest null — no fallback of any kind. */
    fun handleNavError(commandId: String, code: String) {
        takePending(commandId)?.complete(null)
    }

    /** Socket teardown: a dead socket delivers no route, so resolve whatever
     *  is held as an honest failure rather than leaving the caller — and the
     *  device slot it holds — suspended forever. */
    fun failPending() {
        takePending()?.complete(null)
    }

    /** Fails any request already in flight, sends `request`, stores it as the
     *  single outstanding deferred, and awaits it under [timeoutMillis].
     *  Single-outstanding, like the web client's
     *  pendingCommandId/rerouteInFlight discipline. */
    private suspend fun awaitAnswer(commandId: String, request: String): NavigationRoute? {
        failPending()
        val deferred = CompletableDeferred<NavigationRoute?>()
        synchronized(lock) {
            pendingCommandId = commandId
            pendingDeferred = deferred
        }
        send(request)
        val result = withTimeoutOrNull(timeoutMillis) { deferred.await() }
        if (result == null) {
            // Either a genuine timeout (deferred never completed — take it
            // and resolve null) or a legitimate null answer that already
            // cleared the registration itself (takePending is then a
            // matching no-op). Either way this is the timeout's
            // lock-guarded take-and-clear, keyed by commandId, so a later
            // answer to this now-dead request is ignored.
            takePending(commandId)?.complete(null)
        }
        return result
    }

    /** The single lock-guarded take-and-clear every completion path shares.
     *  `commandId == null` takes unconditionally (`failPending`, and
     *  preempting a still-pending prior request before a new one
     *  registers); a non-null `commandId` takes only on an exact match,
     *  leaving a non-matching pending request untouched. */
    private fun takePending(commandId: String? = null): CompletableDeferred<NavigationRoute?>? {
        synchronized(lock) {
            if (commandId != null && pendingCommandId != commandId) return null
            val deferred = pendingDeferred
            pendingCommandId = null
            pendingDeferred = null
            return deferred
        }
    }
}
