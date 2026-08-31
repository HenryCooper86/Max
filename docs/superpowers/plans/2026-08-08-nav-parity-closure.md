# Nav Parity Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One relay-spoken route summary on all three platforms, "停止导航" wins over an in-flight start on both phones, iOS adopts Android's review-hardened lifecycle shapes (closing one confirmed live defect), web's reroute failure aligns to the spec's stop-cleanly rule, and the shared guidance table gains its two long-parked closures on TS/Swift/Kotlin together.

**Architecture:** The relay's existing-but-unwired `okSpeech` reconciliation speaks the summary: when `createNavHandler` sends a `nav.route` for a start, it composes the line from the exact payload and hands it to a new narrow registry hook. Key fact (verified): the `nav.request` commandId is client-synthesized and is NOT the `device.command` commandId, so attachment keys on "the most recently issued outstanding `navigation.start`" — which makes reroute forwards and post-expiry attachments no-ops for free. On the phones, the cancelled-vs-failed discriminator is the generation counter both controllers already carry: a start that resumes with nil checks whether its generation is still current — stale means a rider decision (`failed`/`navigation.cancelled`), current means a genuine routing failure (`unsupported`/`route.unavailable`).

**Tech Stack:** No new dependencies anywhere. Vitest (relay + web), XCTest (iOS), JUnit4 (Android). All existing harness idioms.

**Spec:** `docs/superpowers/specs/2026-08-08-nav-parity-closure-design.md` (binding; its Non-goals are binding too — no protocol/schema/datum/engine-semantics changes, the off-route announcement latch difference stays).

## Global Constraints

- The relay-spoken summary line is exactly: `已找到{destinationName}，全程{km}公里，预计{minutes}分钟。仅供参考，请注意实际路况。` where km = distanceMeters/1000 formatted to one decimal below 10 km and whole numbers at/above (10.0 km boundary → "10"), minutes = ceil(etaSeconds/60). Composed by a pure exported function, unit-tested at the boundaries.
- Attachment discipline: `okSpeech` attaches only via the registry (`PendingDeviceCommands`); the target is the most recently issued unexpired `navigation.start`; no outstanding entry → silent no-op (covers both the 8 s-expired case — `expire()` deletes entries before returning them, verified — and reroute forwards, which have no outstanding start). Attachment is last-write-wins on an unexpired entry.
- `FAILURE_SPEECH` gains `"navigation.cancelled": "已取消导航。"` — without it a cancelled start would speak the generic `导航操作没成功。`, which is wrong for a deliberate rider cancel. (Web's `detail` "已取消导航请求。" still wins precedence where sent — `result.detail?.trim() ||` table, verified at device-actions.ts:534.)
- Stop-cancels semantics (both phones, identical): a stop arriving with an in-flight start (awaiting first fix or awaiting the relay) bumps the generation, resolves the pending first-fix wait, fails the pending relay request, answers `ok` for the stop, and the cancelled start answers `failed`/`navigation.cancelled`. A stop with no route AND nothing in flight still answers `failed`/`navigation.notActive`. Exactly one `device.result` per command on every path — no exceptions.
- Cancelled-vs-failed discriminator (both phones): when a start's search resumes nil (or its resolved route hits a stale-generation commit guard), the start compares its captured generation against the current one — stale → `failed`/`navigation.cancelled` (stop or a newer start superseded it); current → `unsupported`/`route.unavailable` (genuine no-fix/no-route). This replaces `route.unavailable` in every superseded/cancelled path on both phones.
- iOS hardenings mirror Android's review-verified shapes exactly: (1) the reroute answer requires `route != nil` alongside the generation check BEFORE both branches (Kotlin reference: `performReroute`'s guard); (2) `RelayNavigationSearch.awaitAnswer` performs preempt-and-register as ONE synchronous swap returning the previous continuation, resumed nil after the swap, before send (Kotlin reference: the `awaitAnswer` critical section); (3) `lastRerouteAt` and the `rerouting` latch reset on start-commit and stop.
- iOS deletes `openingSummary` (NavigationController.swift:139 call site, :283-288 function) — the relay speaks now. `已到达目的地。` and every other controller line unchanged. Android and web speak nothing new locally.
- Web reroute-failure alignment: in `handleNavError`'s `activeRoute && rerouteInFlight` branch (src/lib/navigation.ts:~205-213), replace keep-guiding-silently with: reset navigation state, `deps.speak("无法重新规划路线，已停止导航")`, emit idle — matching the phones and the 2026-08-06 spec's stop-cleanly rule. (Web controller lines carry no trailing 。, matching the file's existing literals.)
- Table closures land on all three platforms in ONE task: far/near assertions become exact strings `前方350米，右转` / `前方100米，右转` (replacing the regex); a new arrival-vertex case uses a route whose destination sits ~100 m PAST the last polyline vertex and asserts arrival fires within 30 m of the LAST VERTEX and does NOT fire at a point within 30 m of the destination but > 30 m from the last vertex. Same literals on TS/Swift/Kotlin, engines untouched.
- Wire truth stays `shared/agent.ts` + generated tables; nothing in protocol/, shared/generated/, or any datum file changes. `GeneratedAgentProtocol.kt`/`GeneratedAgentProtocol.swift` are generated — never edited.
- Gates: relay/web — `npm run check` from the root; iOS — `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'` from `ios/` (scoped via `-only-testing:`); Android — `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test lintDebug` from `android/` (fresh worktrees need `android/local.properties` = `sdk.dir=/Users/admin/Library/Android/sdk`, gitignored). A task touching a platform runs that platform's full gate before its commit; ALL gates green at closeout.

---

### Task 1: Relay-spoken summary + navigation.cancelled speech

**Files:**

- Modify: `server/device-actions.ts` (pure `navRouteOkSpeech`, `FAILURE_SPEECH` entry, `PendingDeviceCommands.attachOkSpeech`, update the stale `deviceSuccessSpeech` comment at :475-476 that says navigation keeps the client-summary path)
- Modify: `server/routing.ts` (`createNavHandler` gains an optional `onRouteAnnounced` callback, invoked with the composed line when a `reason: "start"` request is answered with `nav.route`)
- Modify: `server/providers/mock.ts`, `server/providers/doubao.ts` (each `AgentProvider` exposes `attachNavOkSpeech(speech: string): void` delegating to its `pendingDeviceCommands.attachOkSpeech("navigation.start", speech)`)
- Modify: `server/session-controller.ts` (:459-462 — wire `onRouteAnnounced: (speech) => this.provider.attachNavOkSpeech?.(speech)`)
- Test: `tests/device-actions.test.ts`, `tests/nav-handler.test.ts` (extend both)

**Interfaces:**

- Produces:

```ts
// server/device-actions.ts
/** The relay-spoken start summary, composed from the exact nav.route payload.
 *  km: one decimal below 10, whole at/above; minutes: ceil(etaSeconds/60). */
export function navRouteOkSpeech(destinationName: string, distanceMeters: number, etaSeconds: number): string;

// PendingDeviceCommands gains:
/** Attach okSpeech to the most recently issued unexpired command with this
 *  action. Silent no-op when none is outstanding (expired, or a reroute
 *  forward with no start in flight). Last write wins. */
attachOkSpeech(action: DeviceActionName, okSpeech: string): void;

// server/routing.ts — createNavHandler options gain:
onRouteAnnounced?: (speech: string) => void; // called only for reason "start" answers
```

- [ ] **Step 1: Write the failing tests** —
  - `tests/device-actions.test.ts`: `navRouteOkSpeech("人民广场", 12_300, 1_500)` → `"已找到人民广场，全程12公里，预计25分钟。仅供参考，请注意实际路况。"`; `(… , 2_450, 301)` → `全程2.5公里，预计6分钟`; boundary `10_000` → `全程10公里`; `deviceFailureSpeech("navigation.start", "failed", "navigation.cancelled")` → `"已取消导航。"`. `PendingDeviceCommands.attachOkSpeech`: attaches to the most recent of two issued `navigation.start` entries (issue two with distinct `now` values, attach, `resolve()` each, assert only the newer carries the speech); no-op when nothing outstanding; no-op after `expire()` removed the entry; second attach overwrites the first.
  - `tests/nav-handler.test.ts`: a start answered with nav.route invokes `onRouteAnnounced` exactly once with the line composed from the provider's planned route numbers; a reroute answer does NOT invoke it; a `nav.error` answer does NOT invoke it; omitting the callback changes nothing (existing tests stay green untouched — that IS the assertion).
- [ ] **Step 2: RED.** **Step 3: Implement** (composition via `navRouteOkSpeech` inside `createNavHandler`'s start-answer branch, callback threaded; providers' one-line delegation; session-controller wiring; comment update). **Step 4: GREEN** — `npm run check` full. **Step 5: Commit** — `git commit -m "feat(nav-relay): speak the route summary from the relay on all platforms"`

---

### Task 2: iOS — atomic preempt-and-register in RelayNavigationSearch

**Files:**

- Modify: `ios/MaxHelmet/Navigation/RelayNavigationSearch.swift` (`awaitAnswer` — replace the `failPending()`-then-register two-step with one synchronous swap; keep `failPending()` itself for the teardown callers)
- Test: `ios/MaxHelmetTests/RelayNavigationSearchTests.swift` (extend)

**Interfaces:** no public change. Internal shape (Kotlin `awaitAnswer` is the reference):

```swift
// One synchronous section (main-actor code cannot interleave mid-section —
// this makes the invariant structural rather than call-site-dependent):
let preempted = pendingContinuation
pendingCommandId = commandId
pendingContinuation = continuation
// then, outside the swap:
preempted?.resume(returning: nil)
send(request)
```

- [ ] **Step 1: Write the failing test** — a second `route()` initiated while the first is suspended resolves the first with nil BEFORE the second's request is sent (assert ordering via the captured send array: when `sent.count == 2` the first task has already resolved — poll-bounded, mirroring the Kotlin test's by-count assertions; both callers resolve, one nil, one routed, well under the injected timeout).
- [ ] **Step 2: RED** (the current two-step passes the old tests but the new ordering assertion pins the swap; if the test cannot go RED against main-actor-confined code, document that in the report and keep the test as the structural pin — the restructure is still mandated).
- [ ] **Step 3: Implement.** **Step 4: GREEN** — scoped RelayNavigationSearchTests, then the full iOS suite. **Step 5: Commit** — `git commit -m "fix(nav-ios): make request preemption and registration one synchronous swap"`

---

### Task 3: iOS — controller parity (revival guard, cooldown reset, stop-cancels, summary removal)

**Files:**

- Modify: `ios/MaxHelmet/Navigation/NavigationController.swift`
- Test: `ios/MaxHelmetTests/NavigationControllerTests.swift`

**Interfaces:** no public change. Binding behaviors:

- Reroute answer (attemptReroute, :236-265 region): `guard generation == navigationGeneration, route != nil else { return }` before BOTH branches (`defer { rerouting = false }` semantics preserved). Closes the confirmed post-arrival revival + the spurious failure line after arrival.
- Cooldown reset: `lastRerouteAt` reset and `rerouting = false` at start-commit and in `stopGuidance` (web/Android parity — a fresh route never inherits the prior route's 20 s cooldown).
- Stop-cancels: `stopGuidance` (:178 today returns `.failed("navigation.notActive")` when `route == nil`) becomes: if a start is in flight (pending first-fix continuation OR pending relay continuation — the search's `failPending()` plus the first-fix resolve cover both) → bump `navigationGeneration`, resolve the first-fix wait nil, `relayNavigationSearch.failPending()` (wired via the existing AgentSession teardown closure — expose what's needed with the narrowest possible seam), return `.ok`; if nothing is in flight → `.failed("navigation.notActive")` unchanged.
- Cancelled discriminator: the start path's nil-search and stale-generation exits (:119/:123/:129 region) return `.failed("navigation.cancelled")` when the captured generation is stale, `.unsupported("route.unavailable")` when current. Exactly one result per command on every path.
- Delete `openingSummary` (:139 call site, :283-288) — on successful commit the controller speaks nothing (the relay's okSpeech line arrives as an agent transcript).

- [ ] **Step 1: Write the failing tests** — (a) post-arrival revival both ways (reroute in flight, arrival lands and speaks 已到达目的地。, then the answer arrives: success → no revival, no stream restart, no card state; failure → no 无法重新规划 speech); (b) fresh start after a reroute does not inherit the cooldown (fake clock); (c) stop mid-first-fix and stop mid-relay-await: stop answers ok, the start answers failed/navigation.cancelled, nothing installs, the stream is stopped; (d) a start superseded by a newer start answers navigation.cancelled (updating the existing concurrent-start expectations from route.unavailable); (e) the held-ordering/start tests' speech expectations updated — no local summary on success.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — scoped NavigationControllerTests, then the FULL iOS suite. **Step 5: Commit** — `git commit -m "feat(nav-ios): stop cancels in-flight starts and adopts the hardened lifecycle shapes"`

---

### Task 4: Android — stop-cancels + cancelled discriminator

**Files:**

- Modify: `android/app/src/main/java/com/horizon/maxhelmet/navigation/NavigationController.kt`
- Test: `android/app/src/test/java/com/horizon/maxhelmet/navigation/NavigationControllerTest.kt`

**Interfaces:** no public change. Binding behaviors (mirror Task 3 exactly):

- `handleStop`'s `route == null` branch: in-flight start (pending first-fix deferred OR the search pending) → bump generation, `takePendingFirstFixLocked()`+complete null, `search.failPending()`, answer `ok`; truly idle → `failed`/`navigation.notActive` unchanged.
- Cancelled discriminator in `handleStart`: the nil-route and stale-generation exits answer `failed`/`navigation.cancelled` when the captured generation is stale, `unsupported`/`route.unavailable` when current. Update the existing concurrent-start/teardown-race test expectations accordingly (the teardown-race start now answers navigation.cancelled — still exactly one result).

- [ ] **Step 1: Write the failing tests** — stop mid-first-fix and stop mid-relay-await (stop ok, start navigation.cancelled, nothing installs, source stopped); existing superseded-start and teardown-race expectations updated from route.unavailable to navigation.cancelled; truly-idle stop still notActive.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — scoped NavigationControllerTest, then full `./gradlew test lintDebug`. **Step 5: Commit** — `git commit -m "feat(nav-android): stop cancels in-flight starts with the truthful reason code"`

---

### Task 5: Web — reroute failure stops cleanly

**Files:**

- Modify: `src/lib/navigation.ts` (handleNavError's `activeRoute && rerouteInFlight` branch, :~205-213)
- Test: `tests/web-navigation.test.ts` (extend)

**Interfaces:** no public change. The branch becomes: reset navigation state (the file's existing `resetNavigationState()`), `deps.speak("无法重新规划路线，已停止导航")`, emit idle — replacing the keep-guiding silent retry and its comment.

- [ ] **Step 1: Write the failing tests** — reroute failure while guiding: guidance state cleared, the line spoken once, idle emitted, and a subsequent position fix produces no prompts and no further reroute requests. Remove/replace any existing test that pins the old keep-guiding behavior (that replacement is the point — note it in the commit body).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `npm run check` full. **Step 5: Commit** — `git commit -m "fix(nav-web): stop cleanly with a spoken line when a reroute fails"`

---

### Task 6: Shared table closures on all three platforms

**Files:**

- Modify: `tests/guidance.test.ts`, `ios/MaxHelmetTests/GuidanceEngineTests.swift`, `android/app/src/test/java/com/horizon/maxhelmet/navigation/GuidanceEngineTest.kt` (tests ONLY — any engine file change is a defect)

**Binding content, identical literals on all three:**

- Far/near assertions become exact: `前方350米，右转` (31.2320 fix) and `前方100米，右转` (31.2340 fix), replacing the `^前方\d+米，右转$` regex/pattern on each platform.
- New case "arrival keys on the last polyline vertex, not the destination": the existing north-along-121.47 route (polyline ending at its last vertex, lat 31.24) but with `destination` placed at lat 31.2409, lon 121.47 — ~100 m PAST the last vertex. Two discriminating fixes, asserted in sequence with carried progress: (a) a fix at 31.2385 is ~167 m from the last vertex and ~267 m from the destination → `arrived == false`; (b) a fix at 31.2398 is ~22 m from the last vertex (inside the 30 m radius) while ~122 m from the destination → `arrived == true`. An engine that measured arrival to the destination coordinate would fail (b) — that asymmetry is the whole point of the case. Also align the Kotlin sticky-arrival literal `31.2399` → `31.2398` so all three table files diff clean (ledgered drift from Plan C's brief).

- [ ] **Step 1: Write the failing tests on all three** (exact strings will fail nowhere if the engines are correct — the far/near tightening should pass immediately; that is acceptable and expected for the string change, note it; the arrival-vertex case must be verified GREEN against all three engines and is the real proof).
- [ ] **Step 2: Run all three scoped suites** (vitest guidance, XCTest GuidanceEngineTests, gradle GuidanceEngineTest). **Step 3: Fix any divergence found** (a platform failing the arrival-vertex case would be a REAL engine divergence — STOP and report BLOCKED; do not "fix" an engine to pass). **Step 4: GREEN** — all three platform gates full. **Step 5: Commit** — `git commit -m "test(nav): pin exact prompt strings and the last-vertex arrival clause on all platforms"`

---

### Task 7: Closeout — gates, README, audit

- [ ] **Step 1: README** — root `README.md`: the web nav bullet's reroute sentence updated to the stop-cleanly behavior; confirm the iOS/Android bullets need no change (they describe relay routing, not the summary voice — if either mentions the local summary, update it to "the relay speaks the summary").
- [ ] **Step 2: Gates** — `npm run check` exit 0; full iOS suite green; full `./gradlew test lintDebug assembleDebug` green.
- [ ] **Step 3: Commit** — `docs(nav): document the relay-spoken summary and web reroute alignment` (only if Step 1 changed anything; otherwise skip).
- [ ] **Step 4: Audit** — `git log --oneline <branch-base>..HEAD`: only server/, src/, ios/, android/, tests/, docs/, README.md; `grep -rn "openingSummary" ios/` → empty; `grep -n "前方\\\\d" tests/guidance.test.ts ios/MaxHelmetTests/GuidanceEngineTests.swift android/app/src/test/java/com/horizon/maxhelmet/navigation/GuidanceEngineTest.kt` → empty (no regex assertions remain); no changes under protocol/, shared/, rdk/.

---

## Deferred (explicit)

- The off-route announcement latch difference (web once-per-excursion; phones per-send) — spec non-goal.
- Android fast-follow items (one-block bump-and-start, `manager != null` tighten, doc line) — ride along in Task 4 ONLY if the implementer is already editing the exact lines; otherwise they stay in the ledgered fast-follow.
- Relay-spoken reroute-success line (web speaks a local 已重新规划路线; phones speak nothing) — a smaller sibling of the summary decision; decide in a future pass.
- Map SDK display (Android key), live-QA gate items — tracked in project memory.
