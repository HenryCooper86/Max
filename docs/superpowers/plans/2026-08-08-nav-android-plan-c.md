# Nav Plan C: Android Guidance Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "导航去X" starts live turn-by-turn guidance on Android for the first time — routed by the relay's Amap service, guided by a Kotlin port of the canonical six-rule engine, spoken through the existing TTS path with ADAS hazard priority, and displayed on a Compose guidance card.

**Architecture:** Android gains the whole navigation stack in one plan because nothing exists today: the `device.command` spine (parse + `device.result` sender — currently every `device.command` silently drops to `Unhandled`), a `RelayNavigationSearch` that suspends one outstanding `nav.request` on a `CompletableDeferred` until `nav.route`/`nav.error`/timeout/teardown resolves it, a `NavigationController` that owns route lifecycle with the generation-guard lessons Plan B's review cycle paid for, and a `GuidanceCard` in the existing `HudCard` idiom. Per the spec, Android is **GCJ-02 inside**: each WGS-84 GPS fix converts through the forward transform exactly once where fixes enter the controller; route payloads are GCJ-02 on the wire and stay GCJ-02 — there is **no inverse transform on Android**. The engine is a literal port of `shared/guidance.ts` with Plan B's Swift port (`ios/MaxHelmet/Navigation/`) as the tie-breaking second reference, proven by the same coordinate-literal table (the Swift superset: TS's 8 cases plus threshold-identity and sticky-arrival extensions).

**Tech Stack:** Kotlin 2.2 / Compose Material3 / org.json / plain JUnit4 (no new production dependencies — no Play Services, no map SDK, no mocking library, no kotlinx-coroutines-test; suspend paths are tested with `runBlocking`). One authorized test-only exception: `testImplementation("org.json:json:20231013")` in `android/app/build.gradle.kts` — the unit-test `android.jar` ships throwing stubs for `org.json.*`, so JVM tests of any wire-layer code need the real artifact; it never reaches the production classpath (controller ruling, Task 3).

**Spec:** `docs/superpowers/specs/2026-08-06-amap-navigation-design.md` (§Architecture, §Coordinates "Android: GCJ-02 inside", §Per-client behavior "Android", §Error and edge handling).

**Governing rulings (carried from Plan B):** the six-rule port contract at `shared/guidance.ts:128-170` is canonical over any older spec wording; the wire schema truth is `shared/agent.ts` + `shared/generated/agent-protocol.ts` (the spec's `protocol/agent-events.schema.json` naming and any `shared/protocol.ts` reference are historical). The spec's reroute-failure rule ("guidance stops cleanly with a spoken explanation") matches shipped iOS behavior — Android mirrors iOS; the web client's keep-guiding deviation is NOT the model and reconciling web is out of scope.

## Global Constraints

- The six-rule port contract (shared/guidance.ts:128-170) is binding verbatim: (1) single along-route metric for prompts AND advancement — no straight-line-to-coordinate metric anywhere in those paths; (2) prompt-before-advance within one fix; (3) off-route freezes `maneuverIndex`/`firedThresholds` and suppresses prompts; (4) sticky `arrived`, reset only by fresh progress; (5) snap tie-break = first segment in array order (strictly-smaller replacement); (6) arrival = straight-line haversine to the route's LAST POLYLINE VERTEX, evaluated regardless of off-route, sticky.
- Constants identical to TS/Swift: EARTH_RADIUS 6371008.8; OFF_ROUTE 50 m; ARRIVAL 30 m; MANEUVER_ADVANCE 30 m; thresholds far 400 / near 150 / now 40. Prompt templates identical: far/near → `"前方${(distance / 50.0).roundToInt() * 50}米，$instruction"`; now → the bare instruction (no prefix). Controller lines identical to iOS: stop "已停止导航。", arrival "已到达目的地。", reroute send "已偏离路线，正在重新规划。", reroute failure "无法重新规划路线，已停止导航。".
- Datum (spec §Coordinates): Android is GCJ-02 inside. `wgs84ToGcj02` forward transform only — A = 6378245.0, EE = 0.006693421622965943, outOfChina bounds identical to shared/geo.ts — applied to each incoming GPS fix at the controller's fix boundary (`onFix`), which is the ONLY datum call site in the app. Route payloads (destination, polyline, steps) are GCJ-02 as received and are never converted. NO inverse transform exists on Android.
- Wire shapes (shared/agent.ts, binding): `nav.request` = `{type, commandId, reason: "start"|"reroute", origin:{lat,lon}, query?, destination?:{lat,lon}, destinationName?}` (nil-omitted optionals); `device.result` = `{type, commandId, status: "ok"|"failed"|"denied"|"unsupported", reason?}`; `device.command` `navigation.start` args = `{query}`, `navigation.stop` args = `{}`. `nav.route` required fields per `GeneratedAgentProtocol.kt`: commandId, destinationName, destination, distanceMeters, etaSeconds, polyline, steps (steps carry instruction/lat/lon/alongRouteMeters — alongRouteMeters is CUMULATIVE from route start).
- device.command scope discipline: parse the `DeviceCommand` event case, but route ONLY `navigation.start`/`navigation.stop` to the controller. Every other action stays `Unhandled` exactly as today (silent; the relay's 8 s backstop answers) — crash/other actions belong to their own features, and answering them here would change flows this plan doesn't own.
- Truthful results: exactly one `device.result` per navigation command, held until `nav.route`/`nav.error` resolves (ok is never sent before a real route exists). Codes mirror iOS: resolution/plan failure or no fix in time → `unsupported` reason `route.unavailable`; stop with nothing active → `failed` reason `navigation.notActive`; location permission missing → `denied` reason `permission.location`.
- Pending-request hygiene (the awaitingReply/Plan-B lesson): the single outstanding `nav.request` deferred MUST resolve on every path — answer, error, client-side 7 s timeout (under the relay's 8 s backstop), and socket teardown (`failPending()` from BOTH `AgentSession.stop()` and `handleSocketClosed`). A second concurrent request fails the first with null before proceeding (single-outstanding). All deferred handoff is lock-guarded take-and-clear keyed by commandId — a mismatched commandId is ignored.
- Controller lifecycle rules (Plan B's final-review lessons, binding): a generation counter bumps on every start attempt, on `stopGuidance`, and on the reroute-failure branch (NOT on arrival); every route commit re-asserts the location stream in the same synchronous block (`locationSource.start` is idempotent); a committed route is never streamless; an explicitly stopped navigation is never revived by a late answer; arrival retires only its own route; superseded starts resolve their first-fix wait with null immediately (single-outstanding first-fix, watchdog non-authoritative for later generations).
- ADAS priority (spec verbatim): a hazard interrupt always wins over a maneuver prompt, and a suppressed maneuver prompt is DROPPED, not queued. Concretely: while `AgentSession.State.hazardAlert != null`, the controller drops the prompt (it still fires the threshold in progress — never re-speak later). The now-threshold prompt interrupts current playback via the existing `stopAgentSpeech()` path, keyed on threshold IDENTITY (`firedThreshold == NOW`), never on prompt text.
- Reroute discipline: one in-flight reroute; 20 s cooldown from send time; reroute echoes the stored GCJ destination + destinationName verbatim (no datum round-trip — Android stores GCJ).
- Location: existing `android.location.LocationManager` only (no Play Services). Continuous updates via `requestLocationUpdates(GPS_PROVIDER, 1000L, 0f, listener)` behind a `LocationSource` seam; fixes delivered raw WGS-84. Foreground-session-only (background nav is a spec non-goal); no new manifest permissions (`ACCESS_FINE_LOCATION` already declared).
- No map SDK in this plan. Display is the Compose `GuidanceCard` only; the Amap Android Map SDK is deferred (key unregistered — see Deferred).
- Follow existing idioms: sealed `AgentEvent` cases + two-stage parse in `AgentProtocol.kt`; `buildXxx` JSON-string builders via `org.json.JSONObject` with nil-omitted optionals; `HudCard` Compose pattern; pure presentation-gate functions (`HelmetPresentationModel.kt`); plain JUnit4 tests with backtick names, no mocks — hand-rolled fakes.
- No server/, shared/, src/, ios/, rdk/, protocol/ changes. `GeneratedAgentProtocol.kt` is generated — never edit it.
- Build/test from `android/`: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test lintDebug`. A fresh worktree MUST first create the gitignored `android/local.properties` containing exactly `sdk.dir=/Users/admin/Library/Android/sdk` — without it every gradle task fails with "SDK location not found". Full `./gradlew test` green at every task boundary; `npm run check` green at closeout (server untouched — it must stay green trivially).

---

### Task 1: Kotlin forward datum transform (`CoordinateDatum.kt`)

**Files:**

- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/CoordinateDatum.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/navigation/CoordinateDatumTest.kt`

**Interfaces:**

- Produces (Tasks 2, 5 rely on):

```kotlin
package io.github.henrycooper86.max.navigation

/** A latitude/longitude pair. Inside the Android app every LatLon is GCJ-02
 *  by convention (spec §Coordinates "Android: GCJ-02 inside"); raw WGS-84
 *  exists only in the instant between a GPS fix and wgs84ToGcj02 at the
 *  controller's fix boundary. */
data class LatLon(val lat: Double, val lon: Double)

object CoordinateDatum {
    /** WGS-84 → GCJ-02. Literal port of shared/geo.ts (A = 6378245.0,
     *  EE = 0.006693421622965943, same outOfChina bounds, same series).
     *  Android needs no inverse: routes arrive GCJ-02 and stay GCJ-02. */
    fun wgs84ToGcj02(coordinate: LatLon): LatLon
}
```

- [ ] **Step 1: Write the failing tests**

```kotlin
package io.github.henrycooper86.max.navigation

import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoordinateDatumTest {
    @Test
    fun `leaves points outside china untouched`() {
        val tokyo = LatLon(35.683861, 139.77492)
        assertEquals(tokyo, CoordinateDatum.wgs84ToGcj02(tokyo))
    }

    @Test
    fun `matches the published shanghai vector`() {
        // Same eviltransform vector tests/geo.test.ts and the Swift port pin.
        val gcj = CoordinateDatum.wgs84ToGcj02(LatLon(31.1774276, 121.5272106))
        assertEquals(31.17530398, gcj.lat, 1e-4)
        assertEquals(121.53146073, gcj.lon, 1e-4)
    }

    @Test
    fun `china offset is plausible`() {
        // Degree-hypot bound matches tests/geo.test.ts (0.0009..0.008).
        val wgs = LatLon(31.2304, 121.4737)
        val gcj = CoordinateDatum.wgs84ToGcj02(wgs)
        val offset = hypot(gcj.lat - wgs.lat, gcj.lon - wgs.lon)
        assertTrue("offset $offset too small", offset > 0.0009)
        assertTrue("offset $offset too large", offset < 0.008)
    }
}
```

- [ ] **Step 2: RED** — `./gradlew test` fails to compile (`LatLon`/`CoordinateDatum` missing).
- [ ] **Step 3: Implement** — port shared/geo.ts's `transformLat`/`transformLon`/forward literally (private helpers, private constants `A`/`EE`, same outOfChina bounds `lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271`, same operation order — preserve the series' asymmetries exactly; constant or series drift against shared/geo.ts is the failure mode). KDoc header: Android is GCJ-02 inside so only the forward transform exists here (spec §Coordinates), and the constants must never drift from shared/geo.ts.
- [ ] **Step 4: GREEN** — full `./gradlew test`.
- [ ] **Step 5: Commit** — `git add android/app/src/main/java/io/github/henrycooper86/max/navigation/CoordinateDatum.kt android/app/src/test/java/io/github/henrycooper86/max/navigation/CoordinateDatumTest.kt && git commit -m "feat(nav-android): wgs-84 to gcj-02 forward transform with golden vectors"`

---

### Task 2: Guidance engine port (`Geo.kt`, `NavigationRoute.kt`, `GuidanceEngine.kt`)

**Files:**

- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/Geo.kt`
- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/NavigationRoute.kt`
- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/GuidanceEngine.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/navigation/GuidanceEngineTest.kt`

**Interfaces:**

- Consumes: `LatLon` (Task 1).
- Produces (Tasks 4-6 rely on):

```kotlin
package io.github.henrycooper86.max.navigation

data class ManeuverStep(
    val instruction: String,
    val coordinate: LatLon,
    /** Cumulative along-route distance from the route start to this maneuver,
     *  matching NavManeuver.alongRouteMeters on the wire. NOT a per-leg length. */
    val alongRouteMeters: Double
)

data class NavigationRoute(
    val destinationName: String,
    val destination: LatLon,
    val polyline: List<LatLon>,
    val steps: List<ManeuverStep>,
    val distanceMeters: Double,
    val etaSeconds: Double
)

enum class PromptThreshold(val meters: Double) { FAR(400.0), NEAR(150.0), NOW(40.0) }

data class GuidanceProgress(
    val maneuverIndex: Int = 0,
    val firedThresholds: Set<PromptThreshold> = emptySet(),
    val arrived: Boolean = false
)

data class GuidanceUpdate(
    val progress: GuidanceProgress,
    val distanceToManeuverMeters: Double,
    val remainingMeters: Double,
    val remainingSeconds: Double,
    val offRoute: Boolean,
    val arrived: Boolean,
    val spokenPrompt: String?,
    val firedThreshold: PromptThreshold?,
    val currentInstruction: String?
)

object Geo {
    fun haversineMeters(a: LatLon, b: LatLon): Double
    data class Snap(val alongRouteMeters: Double, val crossTrackMeters: Double)
    fun snapToRoute(position: LatLon, polyline: List<LatLon>): Snap
}

object GuidanceEngine {
    // Pure. The six-rule port-contract comment from shared/guidance.ts:128-170
    // is reproduced (adapted wording) atop this function.
    fun step(position: LatLon, route: NavigationRoute, progress: GuidanceProgress): GuidanceUpdate
}
```

- [ ] **Step 1: Write the failing tests** — port the Swift table (`ios/MaxHelmetTests/GuidanceEngineTests.swift`, itself the TS table plus extensions) with the same coordinate literals: route north along lon 121.47 from lat 31.23 to 31.24 (polyline vertices every 0.001°); maneuver "右转" at 31.235 / alongRouteMeters 555.0; destination step "到达终点" at 31.24 / 1109.0; distanceMeters 1109.0; etaSeconds 240.0. Cases (JUnit4, one `@Test` each, backtick names):
  - haversine across the route ≈ 1109 m (delta 15).
  - first fix at 31.23: `distanceToManeuverMeters` in (540, 570), `spokenPrompt == null`, `offRoute == false`, `currentInstruction == "右转"`.
  - far→near→now fire once each at 31.2320 / 31.2340 / 31.2348: far/near prompts match `Regex("^前方\\d+米，右转$")`, now prompt equals `"右转"`; `firedThreshold` identity is FAR/NEAR/NOW respectively; a repeat fix at the same position fires nothing (null prompt, null threshold); between-threshold fix 31.2325 fires nothing.
  - the now-fix at 31.2348 BOTH speaks and advances (prompt-before-advance): `spokenPrompt == "右转"` AND `progress.maneuverIndex == 1` in the same update.
  - off-route at (31.2320, 121.4710): `offRoute == true`, no prompt; and with along-route position past the maneuver at (31.2360, 121.4710), `maneuverIndex` stays 0 and seeded `firedThresholds = setOf(FAR, NEAR)` carry through unchanged (freeze — seed them, don't start empty).
  - arrival within 30 m of the LAST polyline vertex (31.2399) sets `arrived`; a later far-away fix (31.20) keeps `arrived == true` (sticky).
  - remaining/ETA at 31.235: `remainingMeters` in (520, 590), `remainingSeconds` in (110, 130).
- [ ] **Step 2: RED** — types missing; compile failure.
- [ ] **Step 3: Implement** — `Geo.kt`: `haversineMeters` (EARTH_RADIUS 6371008.8), private `localXY(of, around)` (equirectangular: x = Δlon·R·cos(originLat), y = Δlat·R), private `nearestOnSegment` (clamped t, `segLenSq == 0.0 → t = 0.0`), `snapToRoute` (strictly-smaller replacement, cumulative along-route, empty/single-vertex early returns) — all literal duplicates of shared/guidance.ts:71-125 (Swift `Geo.swift` is the tie-breaker on any reading doubt; sub-meter platform divergence at threshold boundaries is the failure mode). `GuidanceEngine.step`: snap → cross-track/offRoute (50) → arrival (haversine to `polyline.last()`, OR'd with `progress.arrived`, unconditional) → if not off-route { prompts (pre-advance distance, thresholds in FAR/NEAR/NOW order, pick the smallest due threshold not yet fired, fire at most one per fix) then advancement (along-route remaining ≤ 30 OR position past `alongRouteMeters`, only when a next maneuver exists; advancing resets `firedThresholds`) } → remaining = max(0, total − alongRoutePosition), seconds = etaSeconds × remaining/total. Prompt template exactly `"前方${(d / 50.0).roundToInt() * 50}米，$instruction"` for FAR/NEAR, bare instruction for NOW.
- [ ] **Step 4: GREEN** — full `./gradlew test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav-android): port the six-rule guidance engine with the shared test table"`

---

### Task 3: Wire layer — device.command/nav.route/nav.error parsing + builders

**Files:**

- Modify: `android/app/src/main/java/io/github/henrycooper86/max/agent/AgentProtocol.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/agent/NavProtocolTest.kt` (create)

**Interfaces:**

- Consumes: `LatLon`, `ManeuverStep` (Tasks 1-2); existing `parseAgentEvent` two-stage idiom and generated constants (`ServerEventTypes.NAV_ROUTE`, `NAV_ERROR`, `DEVICE_COMMAND`, `ClientEventTypes.NAV_REQUEST`, `DEVICE_RESULT` — all already in `GeneratedAgentProtocol.kt`).
- Produces (Tasks 4-6 rely on):

```kotlin
// New sealed cases on AgentEvent (AgentProtocol.kt):
data class DeviceCommand(val commandId: String, val action: String, val query: String?) : AgentEvent
data class NavRoute(val data: NavRouteData) : AgentEvent
data class NavError(val commandId: String, val code: String) : AgentEvent

data class NavRouteData(
    val commandId: String,
    val destinationName: String,
    val destination: LatLon,      // GCJ-02 as received — never converted
    val polyline: List<LatLon>,   // GCJ-02
    val steps: List<ManeuverStep>, // GCJ-02, cumulative alongRouteMeters
    val distanceMeters: Double,
    val etaSeconds: Double
)

fun buildNavRequest(
    commandId: String, reason: String, originLat: Double, originLon: Double,
    query: String? = null, destinationLat: Double? = null,
    destinationLon: Double? = null, destinationName: String? = null
): String

fun buildDeviceResult(commandId: String, status: String, reason: String? = null): String
```

- [ ] **Step 1: Write the failing tests** — `NavProtocolTest.kt`:
  - contract assertion in the `GeneratedAgentProtocolTest` idiom: `ServerEventTypes.all` contains `NAV_ROUTE`/`NAV_ERROR`/`DEVICE_COMMAND`, and `SERVER_EVENT_REQUIRED_FIELDS["nav.route"] == setOf("type","commandId","destinationName","destination","distanceMeters","etaSeconds","polyline","steps")`.
  - parse a full `device.command` JSON (`action: "navigation.start"`, `args: {"query":"人民广场"}`, `tier: "confirm"`) → `DeviceCommand(commandId, "navigation.start", "人民广场")`; `navigation.stop` with empty args → `query == null`.
  - parse a full nav.route JSON (2 steps, 3 polyline points, integer JSON literals for etaSeconds/alongRouteMeters to exercise Int/Double bridging) into `NavRouteData` field-by-field; coordinates pass through unshifted (assert exact equality with the GCJ input values — a datum conversion here would be a defect).
  - parse nav.error → `NavError(commandId, code)`.
  - malformed nav.route (polyline present but an entry missing `lon`; a step with non-numeric `lat`) → `AgentEvent.Unhandled` (this exercises the type-level guards, not just the required-fields gate — the Plan B Task-3 review's coverage lesson).
  - `buildNavRequest` start-shape: JSON round-trip has `type == "nav.request"`, reason start, origin lat/lon, query, and NO destination/destinationName keys; reroute-shape: destination + destinationName present, NO query key.
  - `buildDeviceResult("c1", "unsupported", "route.unavailable")` round-trips `{type:"device.result", commandId:"c1", status:"unsupported", reason:"route.unavailable"}`; `reason = null` omits the key.
- [ ] **Step 2: RED** (cases missing). **Step 3: Implement** — new `when` branches in `parseAgentEvent` (required-fields gate already data-driven from the generated table; add type-level guards returning `Unhandled` on any malformed coordinate/step/number, following the file's pure-helper style); builders follow `buildTurnFeedback` (`JSONObject().apply { ... }.toString()`, optionals via `if (x != null) put(...)`). `AgentSession.handleEvent`'s exhaustive `when` gains a temporary no-op `is AgentEvent.DeviceCommand, is AgentEvent.NavRoute, is AgentEvent.NavError -> Unit` branch to keep the build green (Task 6 replaces it with real forwarding — same compiler-forced pattern Plan B's Task 3 used).
- [ ] **Step 4: GREEN** — full `./gradlew test`. **Step 5: Commit** — `git commit -m "feat(nav-android): parse device.command and nav events, build nav.request and device.result"`

---

### Task 4: `RelayNavigationSearch.kt` — the suspended relay round trip

**Files:**

- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/RelayNavigationSearch.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/navigation/RelayNavigationSearchTest.kt`

**Interfaces:**

- Consumes: `buildNavRequest`, `NavRouteData` (Task 3); `NavigationRoute`/`ManeuverStep` (Task 2).
- Produces (Tasks 5-6 rely on):

```kotlin
package io.github.henrycooper86.max.navigation

class RelayNavigationSearch(
    private val send: (String) -> Unit,
    private val timeoutMillis: Long = 7_000 // under the relay's 8 s device backstop
) {
    /** reason "start". Origin is GCJ-02 (the controller converted the fix). */
    suspend fun route(query: String, origin: LatLon): NavigationRoute?
    /** reason "reroute": echoes the stored GCJ destination verbatim. */
    suspend fun reroute(destination: LatLon, destinationName: String, origin: LatLon): NavigationRoute?
    fun handleNavRoute(data: NavRouteData)
    fun handleNavError(commandId: String, code: String)
    /** Socket teardown: resolve any suspended request as null. Never leave a caller hanging. */
    fun failPending()
}
```

Behavior (binding): synthesize `commandId = "nav-" + UUID.randomUUID()`; store ONE `CompletableDeferred<NavigationRoute?>` + its commandId under a private lock (a second concurrent call completes the first with null before proceeding); `send(buildNavRequest(...))` AFTER registration; await with `withTimeoutOrNull(timeoutMillis)` and on timeout take-and-clear the registration (lock-guarded, keyed by commandId) so a late answer to a dead request is ignored; `handleNavRoute`/`handleNavError` take-and-clear only on a MATCHING commandId (mismatch → ignore); assembly `NavRouteData → NavigationRoute` copies coordinates verbatim (GCJ-02 passthrough — no CoordinateDatum import in this file). All completion paths funnel through one lock-guarded take-and-clear (the double-resume guard; `CompletableDeferred.complete` is idempotent as a second net).

- [ ] **Step 1: Write the failing tests** — with a recording `send` lambda (`val sent = mutableListOf<String>()`) and `runBlocking`:
  - `route` sends a nav.request whose JSON has reason start, the given origin, a query, and no destination keys; a matching `handleNavRoute` (launched after a short delay) resumes with a `NavigationRoute` whose every field equals the wire data (coordinates identical — passthrough).
  - `handleNavError` resumes null.
  - a MISMATCHED commandId is ignored, then the request times out to null (construct with `timeoutMillis = 50`).
  - `failPending` resumes null.
  - a second `route()` while one is pending: first returns null, second proceeds (assert `sent.size == 2` before completing the second — poll `sent`, the Plan B minor lesson).
  - `reroute` sends reason reroute with destination + destinationName and no query key.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — full `./gradlew test`. **Step 5: Commit** — `git commit -m "feat(nav-android): relay navigation search with single-outstanding request discipline"`

---

### Task 5: `NavigationController.kt` — lifecycle, prompts, truthful results

**Files:**

- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/NavigationController.kt`
- Create: `android/app/src/main/java/io/github/henrycooper86/max/navigation/LocationSource.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/navigation/NavigationControllerTest.kt`

**Interfaces:**

- Consumes: `RelayNavigationSearch` (Task 4), `GuidanceEngine`/`NavigationRoute`/`GuidanceProgress`/`PromptThreshold` (Task 2), `CoordinateDatum.wgs84ToGcj02`/`LatLon` (Task 1), `buildDeviceResult` (Task 3).
- Produces (Task 6 relies on):

```kotlin
package io.github.henrycooper86.max.navigation

/** Delivers raw WGS-84 device fixes. start() is idempotent. */
interface LocationSource {
    fun start(onFix: (LatLon) -> Unit)
    fun stop()
}

/** Task 6 implements this on AgentSession. hazardActive gates prompt DROPPING
 *  (spec: a suppressed maneuver prompt is dropped, not queued); interrupt=true
 *  must cut current playback first (stopAgentSpeech), used ONLY for NOW-identity. */
interface NavSpeaker {
    val hazardActive: Boolean
    fun speak(text: String, interrupt: Boolean)
}

data class NavGuidanceState(
    val destinationName: String,
    val currentInstruction: String?,
    val distanceToManeuverMeters: Double,
    val remainingMeters: Double,
    val remainingSeconds: Double,
    val offRoute: Boolean,
    val arrived: Boolean
)

class NavigationController(
    private val search: RelayNavigationSearch,
    private val locationSource: LocationSource,
    private val speaker: NavSpeaker,
    private val sendResult: (String) -> Unit,          // buildDeviceResult output → socket
    private val onGuidance: (NavGuidanceState?) -> Unit, // Task 6 mirrors into State
    private val hasLocationPermission: () -> Boolean,
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    private val firstFixTimeoutMillis: Long = 3_000
) {
    /** Handles navigation.start / navigation.stop; exactly one device.result per call. */
    suspend fun handleCommand(commandId: String, action: String, query: String?)
    /** Feed one raw WGS-84 fix (the location callback and tests both enter here). */
    fun onFix(wgsFix: LatLon)
    /** Session teardown: stop guidance silently (no speech on a dead session). */
    fun teardown()
}
```

Behavior (binding):

- `navigation.start`: permission missing → `denied`/`permission.location`, done. Bump generation; `locationSource.start(::onFix)`; await first fix via a single-outstanding continuation (a newer start resolves the previous first-fix wait null immediately; the 3 s watchdog checks its generation before resolving); no fix in time → `unsupported`/`route.unavailable` (and `locationSource.stop()` only if `route == null` and the generation is still current); convert the fix `wgs84ToGcj02` (THE datum edge); `search.route(query, gcjOrigin)`; null → `unsupported`/`route.unavailable` (same conditioned stop); resolved but generation stale → `unsupported`/`route.unavailable`, do NOT commit; commit = `locationSource.start(::onFix)` re-assert + `route = resolved` + fresh `GuidanceProgress` + `onGuidance(initial state)` + `ok`.
- `navigation.stop`: no active route → `failed`/`navigation.notActive`; else bump generation, resolve any pending first-fix wait null, clear route, `locationSource.stop()`, `onGuidance(null)`, `speaker.speak("已停止导航。", interrupt = false)`, `ok`. Reset `lastRerouteAt` and the in-flight reroute latch on both start-commit and stop (Plan B parity-backlog fix: a fresh route must not inherit the old 20 s cooldown).
- `onFix`: convert to GCJ, run `GuidanceEngine.step`, publish `NavGuidanceState`; if `update.firedThreshold != null` and prompt non-null: `speaker.hazardActive` → DROP; else `speaker.speak(prompt, interrupt = update.firedThreshold == PromptThreshold.NOW)`. Arrival transition (`update.arrived` && route non-nil): `speaker.speak("已到达目的地。", false)`, clear route + `onGuidance(null)` + `locationSource.stop()` (arrival does NOT bump the generation — a pre-arrival concurrent start may still commit, on its re-asserted stream). Off-route && cooldown elapsed && no reroute in flight: capture generation, `speaker.speak("已偏离路线，正在重新规划。", false)`, stamp `lastRerouteAt = now()`, launch `search.reroute(storedGcjDestination, storedName, currentGcjFix)`; on answer guard `generation == current` FIRST (stale → return, latch still clears); success → commit (stream re-assert + fresh progress); failure → bump generation, clear route, `locationSource.stop()`, `onGuidance(null)`, `speaker.speak("无法重新规划路线，已停止导航。", false)`.
- `teardown()`: silent variant of stop (no speech, no result), for socket death.

`LocationSource.kt` also gets the real implementation (thin, untested glue — the seam exists so the controller is fully testable):

```kotlin
class LocationManagerSource(private val context: Context) : LocationSource {
    // requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener,
    // Looper.getMainLooper()) guarded by a permission check; stop() removes the
    // listener. start() while already started replaces nothing (idempotent).
}
```

- [ ] **Step 1: Write the failing tests** — fakes: `FakeLocationSource` (records start/stop, exposes `fun fix(lat, lon)` calling the captured callback), `FakeSpeaker` (records `(text, interrupt)` pairs, settable `hazardActive`), recording `sendResult`, a `RelayNavigationSearch` built on a captured `send` driven by direct `handleNavRoute` calls (real class — Task 4's harness idiom), fake `now`. Cases (all `runBlocking`):
  - start happy path: result held until `handleNavRoute` (assert no `device.result` before, exactly one `ok` after — launch `handleCommand`, poll `sent` for the nav.request, answer it); nav.request origin is SHIFTED vs the WGS fix fed in (the datum edge proof: feed `LatLon(31.2304, 121.4737)`, assert origin ≠ input and equals `CoordinateDatum.wgs84ToGcj02(input)`).
  - permission denied → one `denied`/`permission.location`, no nav.request sent.
  - no fix within the bound (`firstFixTimeoutMillis = 50`, never call `fix`) → one `unsupported`/`route.unavailable`.
  - stop with nothing active → `failed`/`navigation.notActive`; stop with a route → `ok`, "已停止导航。" spoken, `onGuidance(null)`, source stopped.
  - concurrent starts: first suspended at the relay await, second start arrives → BOTH produce exactly one result (first `unsupported`, second `ok` when answered), and the second's committed route has a started source.
  - failed re-start keeps active guidance: route A active, start B → `handleNavError` → B gets `unsupported` but A's source is still started and a subsequent `fix` still publishes guidance.
  - prompts: drive fixes down the Task-2 table route; far prompt spoken with `interrupt == false`; now prompt with `interrupt == true`; with `hazardActive = true` the prompt is DROPPED (speaker records nothing) while the engine still advanced past that threshold (a later fix at the same threshold does not re-speak).
  - arrival: fix near the last vertex → "已到达目的地。", `onGuidance(null)`, source stopped; a start that was in flight during arrival still commits on a re-asserted (started) source.
  - reroute: off-route fix → "已偏离路线，正在重新规划。" + reroute nav.request echoing the stored GCJ destination/destinationName verbatim; a second off-route fix within the 20 s window (fake `now`) sends nothing; reroute failure → "无法重新规划路线，已停止导航。", route cleared, source stopped; a reroute answer arriving after `navigation.stop` is ignored (no revival — generation guard).
  - a fresh start after a reroute does not inherit the cooldown: commit route, trigger reroute (cooldown stamped), stop, start again, immediate off-route → reroute IS sent.
- [ ] **Step 2: RED.** **Step 3: Implement** (controller + `LocationSource.kt`). Concurrency note: `handleCommand` runs on the caller's coroutine; guard all mutable state with a single private lock or confine to one dispatcher — pick the lock (the codebase has no test dispatcher infrastructure), keep every lock section synchronous and tiny, and never hold it across a suspension point. **Step 4: GREEN** — full `./gradlew test`. **Step 5: Commit** — `git commit -m "feat(nav-android): navigation controller with generation-guarded lifecycle"`

---

### Task 6: AgentSession wiring + Compose guidance card

**Files:**

- Modify: `android/app/src/main/java/io/github/henrycooper86/max/agent/AgentSession.kt`
- Modify: `android/app/src/main/java/io/github/henrycooper86/max/ui/AgentScreen.kt`
- Modify: `android/app/src/main/java/io/github/henrycooper86/max/ui/HelmetPresentationModel.kt`
- Test: `android/app/src/test/java/io/github/henrycooper86/max/ui/NavPresentationTest.kt` (create), `android/app/src/test/java/io/github/henrycooper86/max/agent/AgentProtocolTest.kt` (extend only if touched)

**Interfaces:**

- Consumes: everything above.
- Produces:

```kotlin
// AgentSession.State gains:
val navGuidance: NavGuidanceState? = null

// AgentSession gains (private):
//   navSearch: RelayNavigationSearch (send = { webSocket?.send(it) })
//   navController: NavigationController (speaker = the session, sendResult = { webSocket?.send(it) },
//                  onGuidance = { g -> _state.update { it.copy(navGuidance = g) } },
//                  locationSource = LocationManagerSource(context),
//                  hasLocationPermission = ::hasLocationPermission)
// AgentSession implements NavSpeaker:
//   hazardActive = _state.value.hazardAlert != null
//   speak(text, interrupt): if (interrupt) stopAgentSpeech(); ttsSpeak(text, flush = interrupt)
//   (ttsSpeak = the existing speak() generalized: QUEUE_FLUSH when flush, else QUEUE_ADD —
//    far/near prompts must not cut an in-flight agent reply)

// HelmetPresentationModel.kt gains:
internal fun isNavPresentationActive(state: AgentSession.State): Boolean
// = state.handsFree && (connection RELAY or READY) && state.navGuidance != null
```

- [ ] **Step 1: Write the failing tests** — `NavPresentationTest.kt` in the `HelmetPresentationTest` idiom: `isNavPresentationActive` true only when hands-free && connected && `navGuidance != null` (four cases); plus a formatting helper test if the card needs one (`formatRemaining(1234.0, 240.0) == "1.2公里 · 4分钟"` — pure function in `HelmetPresentationModel.kt`, exact strings: `"%.1f公里"` for ≥ 1000 m, `"${meters.roundToInt()}米"` below; minutes = `ceil(seconds / 60).toInt()`分钟).
- [ ] **Step 2: RED.** **Step 3: Implement** —
  - `AgentSession.handleEvent`: replace the Task-3 stub — `is AgentEvent.DeviceCommand ->` if action starts with `"navigation."` launch `scope.launch { navController.handleCommand(event.commandId, event.action, event.query) }` else `Unit` (unchanged silence for foreign actions); `is AgentEvent.NavRoute -> navSearch.handleNavRoute(event.data)`; `is AgentEvent.NavError -> navSearch.handleNavError(event.commandId, event.code)`.
  - Teardown: `stop()` calls `navSearch.failPending()` + `navController.teardown()` alongside the existing `hazardAlert = null` reset (and clears `navGuidance` in the same `_state.update`); `handleSocketClosed` does the same on the idle-close and gave-up-reconnect branches (a dead socket delivers no route — the awaitingReply lesson).
  - `AgentScreen.kt`: a `GuidanceCard` composable in the `HudCard` wrapper, rendered via `state.navGuidance?.let { ... }` beside `HazardBanner`, gated by `isNavPresentationActive`; shows destinationName, `currentInstruction` (large), distance-to-maneuver, remaining via `formatRemaining`, an off-route "已偏离路线" badge. Compose layout mirrors the iOS card's content order; no new dependencies, Material3 components only.
- [ ] **Step 4: GREEN** — full `./gradlew test` + `./gradlew lintDebug` + `./gradlew assembleDebug` (the card is compile-checked by build; composables have no unit harness here). **Step 5: Commit** — `git commit -m "feat(nav-android): wire navigation into the session and render the guidance card"`

---

### Task 7: Closeout — gates, READMEs, audit

- [ ] **Step 1: READMEs** — `android/README.md`: move nav out of "Not yet implemented"; add a navigation section (relay-routed Amap driving data, GCJ-02 on the wire AND inside the app — fixes converted at the controller edge, no inverse transform; six-rule guidance shared verbatim with iOS/web; keyless mock routes end-to-end; honest limits: car profile, 摩托车禁行 not respected, no map display yet — card-only until the Amap Android SDK key registers; foreground-session-only). Add the `local.properties` requirement (`sdk.dir=/Users/admin/Library/Android/sdk`) and `./gradlew test` to the Build section. Root `README.md`: update the Android bullet to match (guidance parity shipped, map display pending key).
- [ ] **Step 2: Gates** — from `android/`: full `./gradlew test lintDebug assembleDebug` green; from the repo root: `npm run check` exit 0 (server untouched — a failure means an accidental cross-boundary edit).
- [ ] **Step 3: Commit** — `docs(nav-android): document relay guidance and the card-only display state`.
- [ ] **Step 4: Audit** — `git log --oneline main..HEAD`: android/-only plus this plan doc and the two READMEs; `git diff --stat main..HEAD -- . ':!android' ':!docs' ':!README.md'` empty; `grep -rn "gcj02ToWgs84" android/` → empty (no inverse crept in); `grep -rn "CoordinateDatum" android/app/src/main` → exactly two call-site files (the definition and NavigationController's fix edge).

---

## Deferred (explicit)

- **Amap Android Map SDK display** (spec §Per-client behavior names it; key-gated): register the Android SDK key in the Amap console first (see the keys memory — platform-bound, a wrong-platform key fails `USERKEY_PLAT_NOMATCH`), then a follow-up plan adds the dependency, the manifest meta-data key, and a map view under the card. Until then Android guidance is card + voice, which covers every keyless acceptance criterion in the spec.
- On-road datum verification (rider position ON the polyline) — the spec's manual section; joins the hardware bench list with the iOS ride.
- Web controller-policy reconciliation (web keeps guiding after a failed reroute + silently retries, latches 偏离路线 once per excursion — both diverge from the spec's stop-cleanly rule that iOS and now Android implement; reconciling web is its own small change with its own tests).
- Background/screen-off navigation, lane guidance, motorcycle profile — spec non-goals.
- Crash detection / other device actions on Android: the `DeviceCommand` parse case ships here, but only `navigation.*` routes anywhere; porting crash detection stays its own future plan.
