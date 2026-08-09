# Nav Fast-Follow Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small, review-nominated residue of the parity closure: the relay's reroute path gets the same epoch discipline and (per the new ruling) speaks the reroute-success line on all platforms; both phones hoist `failPending` so a cancelled start is never audible 7 s late; Android regains the deferred-identity watchdog coverage; plus three one-line polish items.

**Architecture:** Every item is a review-prescribed fix with a recorded ruling — the "spec" is the parity closure's final-review triage and re-review adjudications (recorded in this plan's task text; the git history of `worktree-nav-parity-closure` carries the full findings). One new decision was made for this bundle: the reroute-success confirmation is relay-spoken (symmetric with the start summary). Reroutes have no `device.command` to reconcile, so the relay speaks via a direct provider transcript line (`speakNavLine`), fired only on a FRESH successful plan — the rejected-by-interval cache path returns the current route unchanged and must stay silent, and a superseded reroute (new epoch guard) must neither send nor speak.

**Tech Stack:** No new dependencies. Vitest / XCTest / JUnit4, existing idioms throughout.

## Global Constraints

- Relay reroute epoch discipline mirrors the start path exactly: capture the epoch at reroute entry, re-check after the `planRoute` await; when superseded skip ALL of: the `nav.route` send, the `lastRoute`/`lastRerouteAt` cache writes, and the new spoken line. The cached-resend fast path is pre-await (atomic) and needs no guard — and it never speaks.
- The relay's reroute-success line is exactly `已重新规划路线。` (relay-side lines carry 。), sent via a new optional provider method `speakNavLine(text: string): void` that both providers implement with their existing transcript machinery (`transcriptEvent(..., useBrowserSpeech: true)` — the same delivery shape `applyDeviceReconciliation` uses). `createNavHandler` gains `onRerouteAnnounced?: (speech: string) => void`, invoked ONLY on a fresh, non-superseded, successful reroute plan; `session-controller` wires it to `this.provider.speakNavLine?.(speech)`.
- Web deletes its local `deps.speak("已重新规划路线")` (src/lib/navigation.ts:187) — the relay's transcript line reaches the web HUD like any agent speech. No other web behavior changes.
- `formatRouteKm`: round-then-branch so [9950, 9999] m renders `10公里` not `10.0公里` (`Math.round(km * 10) / 10 >= 10` decides the branch, or equivalent); pin with a 9_975 boundary test plus the existing cases unchanged.
- failPending hoist (BOTH phones, identical semantics): in the stop path, fail the pending relay request regardless of which branch runs (route-active stops included), so a cancelled in-flight start resolves promptly instead of at its 7 s timeout. iOS: `stopGuidance` in NavigationController.swift (today `search.failPending()` sits only in the `starting` branch). Android: `handleStop` in NavigationController.kt (same shape). A failed-by-hoist reroute answer is already safe on both phones (the reroute answer guard requires generation match AND route non-nil; a stop bumps the generation first — assert that in the tests, don't assume it).
- Android deferred-identity watchdog pin (the parity ledger's module-wide coverage gap): a test where route A is active, start B is parked at its FIRST-FIX await, and a reroute for A FAILS (bumping the generation without completing B's pending first-fix deferred) — B's identity-guarded watchdog must resolve B at its injected timeout with `failed`/`navigation.cancelled` (stale generation). A generation-only watchdog would hang this test; bound it so a regression fails fast, no bare sleeps.
- `LocationManagerSource.start`: registration success requires `manager != null && requested.isSuccess` before assigning `listener` (a null LocationManager currently counts as success and wedges the idempotence guard).
- Android reentrant-fake hygiene: delete the dead `started` bookkeeping writes in the reentrant-teardown test's fake (written twice, never asserted) or assert it affirmatively with rationale — pick one, no half-state.
- No protocol/schema/datum/engine changes; no table changes. The three platform gates green per touched platform at each task boundary; ALL gates at closeout.
- Gates: `npm run check` (root); iOS `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'` from `ios/`; Android `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test lintDebug` from `android/` (worktree needs the gitignored `android/local.properties` = `sdk.dir=/Users/admin/Library/Android/sdk`).

---

### Task 1: Relay — reroute epoch symmetry + relay-spoken reroute success + formatRouteKm

**Files:**

- Modify: `server/routing.ts` (reroute-branch epoch capture/re-check; `onRerouteAnnounced` option invoked on the fresh-success path only)
- Modify: `server/device-actions.ts` (`formatRouteKm` round-then-branch; export the reroute line constant beside the okSpeech composer if a constant helps the tests — otherwise inline the literal in routing.ts with a comment)
- Modify: `server/providers/types.ts`, `server/providers/mock.ts`, `server/providers/doubao.ts` (`speakNavLine?(text: string): void` — one transcript send each, mirroring `applyDeviceReconciliation`'s delivery shape)
- Modify: `server/session-controller.ts` (wire `onRerouteAnnounced: (speech) => this.provider.speakNavLine?.(speech)`)
- Test: `tests/nav-handler.test.ts`, `tests/device-actions.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** — nav-handler: fresh successful reroute invokes `onRerouteAnnounced` exactly once with `已重新规划路线。` and sends the route; the rejected-by-interval CACHE path sends the cached route and does NOT invoke it; a SUPERSEDED reroute (start arrives while the reroute's planRoute is deferred) neither sends, nor caches, nor invokes it (use the existing `defer()` harness); reroute `nav.error` path unchanged and silent; absent callback inert. device-actions: `formatRouteKm`-boundary — 9_975 m → `已找到…全程10公里…` (via `navRouteOkSpeech`), 9_949 m → `9.9公里`, existing 2_450/12_300/10_000 cases unchanged.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — full `npm run check`. **Step 5: Commit** — `git commit -m "feat(nav-relay): epoch-guard reroutes and speak the reroute-success line"`

---

### Task 2: Web — drop the local reroute-success line

**Files:**

- Modify: `src/lib/navigation.ts` (delete the `deps.speak("已重新规划路线")` at the reroute-apply site, :187; comment notes the relay speaks it now)
- Test: `tests/web-navigation.test.ts` (the reroute-success expectation updated: no local speech; everything else about the reroute apply unchanged)

- [ ] **Step 1: Update the failing test.** **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — full `npm run check`. **Step 5: Commit** — `git commit -m "fix(nav-web): let the relay speak the reroute-success line"`

---

### Task 3: iOS — failPending hoist

**Files:**

- Modify: `ios/MaxHelmet/Navigation/NavigationController.swift` (`stopGuidance`: `search.failPending()` runs for every stop that bumps the generation — route-active branch included; keep the truly-idle early return untouched)
- Test: `ios/MaxHelmetTests/NavigationControllerTests.swift`

- [ ] **Step 1: Write the failing test** — route A active + start B suspended at the relay await; `navigation.stop` → stop answers ok AND B resolves `failed`/`navigation.cancelled` promptly (bounded well under the search timeout — the pre-hoist code leaves B waiting the full injected timeout; use a generous injected timeout so RED manifests as the bounded-wait assertion failing, not a hang). Assert the reroute-safety premise too: no reroute teardown speech fires (the stop's bump makes any in-flight reroute answer stale).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — scoped, then FULL iOS suite. **Step 5: Commit** — `git commit -m "fix(nav-ios): fail the pending search on every generation-bumping stop"`

---

### Task 4: Android — failPending hoist + watchdog pin + polish

**Files:**

- Modify: `android/app/src/main/java/com/horizon/maxhelmet/navigation/NavigationController.kt` (failPending hoist, same semantics as Task 3)
- Modify: `android/app/src/main/java/com/horizon/maxhelmet/navigation/LocationSource.kt` (`manager != null && requested.isSuccess`)
- Test: `android/app/src/test/java/com/horizon/maxhelmet/navigation/NavigationControllerTest.kt` (hoist test mirroring Task 3; the deferred-identity watchdog pin per the Global Constraints; the dead `started` bookkeeping resolved)

- [ ] **Step 1: Write the failing tests** (hoist RED; watchdog pin RED-by-inspection is NOT acceptable here — the pin must fail against a hypothetical generation-guard, so verify it at least fails when the identity guard is temporarily reverted to a generation check, per this plan family's RED standard). **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — scoped, then full `./gradlew test lintDebug`. **Step 5: Commit** — `git commit -m "fix(nav-android): hoist failPending, pin the identity watchdog, tighten the location source"`

---

### Task 5: Closeout — gates + audit

- [ ] **Step 1: Gates** — all three: `npm run check` exit 0; FULL iOS suite; full `./gradlew test lintDebug assembleDebug`.
- [ ] **Step 2: Audit** — `git log --oneline <base>..HEAD` touches only server/, src/, ios/, android/, tests/, docs/; `git diff --stat <base>..HEAD -- protocol shared rdk` empty; `grep -n "已重新规划路线" src/lib/navigation.ts` → empty (web's local line gone); README needs no change (verify: the reroute sentence describes failure behavior, unchanged; the success line is new speech, not a documented claim — if any README sentence contradicts, fix it in a docs commit).
- [ ] **Step 3: Commit** — docs commit only if the audit found a README contradiction.

---

## Deferred (explicit)

- The off-route announcement latch difference — still a non-goal.
- Android reroute-failure latch-clear direct test — still legitimately unpinnable (parity ruling stands).
- Map SDK display, keys, live-QA bench — tracked in memory.
