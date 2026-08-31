# Navigation first-fix retry (正在定位) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop navigation failing with 路线规划失败 when the GPS fix is merely slow — announce 正在定位, wait longer, and fail with copy that names the real cause.

**Architecture:** Each client's existing bounded first-fix wait gains a second, earlier timer that speaks one interim line, and its bound rises from 3 s to 8 s. The relay's navigation device-result deadline rises to cover the new device worst case. The failure line travels as `result.detail`, which reconciliation already prefers over the server's `FAILURE_SPEECH` map.

**Tech Stack:** Swift (iOS), Kotlin (Android), TypeScript (relay + web), vitest, XCTest, JUnit.

**Spec:** `docs/superpowers/specs/2026-08-16-navigation-first-fix-retry-design.md`

## Global Constraints

- Interim line, spoken by the device, exactly: `正在定位…` (ends with a single `…`, U+2026)
- Failure detail, exactly: `还没定位到，到室外或空旷处再说一次。`
- First-fix bound: **8 s** on every client. Announce at **1.5 s**.
- Route search bound stays **7 s**. Do not change it.
- Relay navigation device-result deadline: **18 s**.
- The interim line must never be heard after guidance starts, after a stop, or from a superseded attempt.
- `route.unavailable` is returned for **two** distinct failures — no fix, and no route from the relay. Only the no-fix path carries the new detail; the search-failure path keeps `detail = nil` so it still speaks 路线规划失败。
- Permission denial keeps its existing `permission.location` reason and speech. Do not fold it into the new copy.

---

### Task 1: Relay deadline covers the new device budget

The device's worst case becomes 8 s (fix) + 7 s (search) = 15 s. The relay currently gives navigation 12 s, so without this the relay would speak a timeout line while the phone is still legitimately working.

**Files:**

- Modify: `server/device-actions.ts:474`
- Create: `tests/navigation-timeout-budget.test.ts`

**Interfaces:**

- Produces: `export const NAVIGATION_RESULT_TIMEOUT_MS: number` (was a private `const`; the guard test imports it)

- [ ] **Step 1: Write the failing test**

Create `tests/navigation-timeout-budget.test.ts`:

```ts
// tests/navigation-timeout-budget.test.ts
import { describe, expect, it } from "vitest";
import { DEVICE_RESULT_TIMEOUT_MS, NAVIGATION_RESULT_TIMEOUT_MS } from "../server/device-actions";

// The relay's navigation deadline is a safety net: it is what lets Max speak
// when a device goes silent. It must therefore outlast the slowest honest
// device attempt, or the relay speaks a failure while the phone is still
// working — which is what made a slow GPS fix sound like a routing failure.
//
// These mirror the client bounds. Raising either without raising the relay
// deadline must fail here rather than in the field:
//   ios/MaxHelmet/Navigation/NavigationController.swift  firstFixTimeoutSeconds
//   android/.../navigation/NavigationController.kt        firstFixTimeoutMillis
//   ios/MaxHelmet/Navigation/RelayNavigationSearch.swift  timeoutSeconds
const CLIENT_FIRST_FIX_MS = 8_000;
const CLIENT_SEARCH_MS = 7_000;
const CLIENT_WORST_CASE_MS = CLIENT_FIRST_FIX_MS + CLIENT_SEARCH_MS;

describe("navigation device-result deadline", () => {
  it("outlasts the slowest honest client attempt", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS).toBeGreaterThan(CLIENT_WORST_CASE_MS);
  });

  it("keeps a margin rather than sitting exactly on the client bound", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS - CLIENT_WORST_CASE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("stays longer than the ordinary device deadline", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS).toBeGreaterThan(DEVICE_RESULT_TIMEOUT_MS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/navigation-timeout-budget.test.ts`
Expected: FAIL — the import of `NAVIGATION_RESULT_TIMEOUT_MS` does not resolve, because it is currently a module-private `const`.

- [ ] **Step 3: Export the constant and raise it**

In `server/device-actions.ts`, replace lines 471-474:

```ts
/** Ordinary device-result deadline. Navigation gets longer below because route
 *  planning includes the phone/RDK handoff before the result returns. */
export const DEVICE_RESULT_TIMEOUT_MS = 8_000;
/** Navigation's own deadline. It must outlast the slowest honest client
 *  attempt — 8 s waiting for a first GPS fix plus 7 s of route search — or the
 *  relay speaks a failure while the phone is still working. The 3 s margin is
 *  deliberate; `tests/navigation-timeout-budget.test.ts` fails if a client
 *  bound is raised without raising this. */
export const NAVIGATION_RESULT_TIMEOUT_MS = 18_000;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/navigation-timeout-budget.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0. If `knip` reports `NAVIGATION_RESULT_TIMEOUT_MS` as an unused export, that means the test import was mistyped — fix the import rather than un-exporting.

- [ ] **Step 6: Commit**

```bash
git add server/device-actions.ts tests/navigation-timeout-budget.test.ts
git commit -m "fix(relay): let navigation outlast a slow first GPS fix"
```

---

### Task 2: iOS announces 正在定位 and waits 8 s

**Files:**

- Modify: `ios/MaxHelmet/Navigation/NavigationController.swift` (init, `start`, `awaitFirstFix`, `resolveFirstFix`, `startFailureResult`)
- Modify: `ios/MaxHelmetTests/NavigationControllerTests.swift` (the `make` helper, plus new tests)

**Interfaces:**

- Consumes: `DeviceActionResult.unsupported(_ reason: String, _ detail: String? = nil)` from `ios/MaxHelmet/Agent/AgentProtocol.swift:337`
- Produces: `NavigationController.init(..., firstFixTimeoutSeconds: TimeInterval = 8, firstFixAnnounceSeconds: TimeInterval = 1.5)`

- [ ] **Step 1: Write the failing tests**

In `ios/MaxHelmetTests/NavigationControllerTests.swift`, extend the `make` helper to accept the new bound (replace the existing signature and call):

```swift
    private func make(
        _ stream: FakeStream, _ search: FakeSearch,
        clock: @escaping () -> TimeInterval = { 0 },
        firstFixTimeoutSeconds: TimeInterval = 3,
        firstFixAnnounceSeconds: TimeInterval = 1.5
    ) -> (NavigationController, Box) {
        let box = Box()
        let controller = NavigationController(
            search: search, stream: stream,
            onGuidance: { box.guidance = $0 },
            speak: { box.spoken.append($0) },
            interruptPlayback: { box.interrupts += 1 },
            now: clock,
            firstFixTimeoutSeconds: firstFixTimeoutSeconds,
            firstFixAnnounceSeconds: firstFixAnnounceSeconds
        )
        return (controller, box)
    }
```

Then add these tests to the same class:

```swift
    // A fix that is merely slow must not sound like a routing failure: the
    // rider hears 正在定位…, the search still runs, and navigation starts.
    func testSlowFixAnnouncesLocatingAndStillStarts() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        search.route = straightRoute()
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 8,
            firstFixAnnounceSeconds: 0.05
        )

        async let result = controller.perform(.navigationStart("外滩"))
        try? await Task.sleep(nanoseconds: 150_000_000)
        stream.feed(CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40))

        XCTAssertEqual(await result, .ok)
        XCTAssertEqual(box.spoken, ["正在定位…"])
        XCTAssertNotNil(box.guidance)
    }

    // The common case must stay silent: a fix already in hand means the rider
    // hears only the relay's own start summary.
    func testPromptFixNeverAnnouncesLocating() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = straightRoute()
        let (controller, box) = make(stream, search, firstFixAnnounceSeconds: 0.05)

        let result = await controller.perform(.navigationStart("外滩"))

        XCTAssertEqual(result, .ok)
        XCTAssertFalse(box.spoken.contains("正在定位…"))
    }

    // No fix at all: the failure must name the cause instead of blaming route
    // planning, which is what shipped.
    func testNoFixFailsWithLocationDetailRatherThanRouteFailure() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 0.1,
            firstFixAnnounceSeconds: 0.05
        )

        let result = await controller.perform(.navigationStart("外滩"))

        XCTAssertEqual(
            result,
            .unsupported("route.unavailable", "还没定位到，到室外或空旷处再说一次。")
        )
        XCTAssertEqual(box.spoken, ["正在定位…"])
    }

    // A relay that answers with no route is a different failure and must keep
    // its own speech: the fix arrived, so the location copy would be a lie.
    func testSearchFailureKeepsTheRoutePlanningSpeech() async {
        let stream = FakeStream(), search = FakeSearch()
        search.route = nil
        let (controller, _) = make(stream, search)

        let result = await controller.perform(.navigationStart("外滩"))

        XCTAssertEqual(result, .unsupported("route.unavailable", nil))
    }

    // An explicit stop while the fix is still pending must cancel the pending
    // announcement, not let it arrive afterwards as a non-sequitur.
    func testStopBeforeTheFixSuppressesTheAnnouncement() async {
        let stream = FakeStream(), search = FakeSearch()
        stream.fixOnStart = nil
        let (controller, box) = make(
            stream, search,
            firstFixTimeoutSeconds: 8,
            firstFixAnnounceSeconds: 0.1
        )

        async let result = controller.perform(.navigationStart("外滩"))
        try? await Task.sleep(nanoseconds: 20_000_000)
        _ = controller.perform(.navigationStop)
        try? await Task.sleep(nanoseconds: 200_000_000)

        _ = await result
        XCTAssertFalse(box.spoken.contains("正在定位…"))
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/admin/doubao && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/NavigationControllerTests
```

Expected: FAIL to compile — `extra argument 'firstFixAnnounceSeconds' in call`. That is the correct first failure: the parameter does not exist yet.

- [ ] **Step 3: Add the announce timer and raise the bound**

In `ios/MaxHelmet/Navigation/NavigationController.swift`:

Add a stored property beside `firstFixWatchdog` (near line 42):

```swift
    private var firstFixAnnounce: Task<Void, Never>?
```

Add the constant beside the other spoken strings:

```swift
    private static let locatingSpoken = "正在定位…"
    private static let noFixDetail = "还没定位到，到室外或空旷处再说一次。"
```

Change the init (line 70-91) — add the stored bound and the new parameter:

```swift
    private let firstFixTimeoutSeconds: TimeInterval
    private let firstFixAnnounceSeconds: TimeInterval
```

```swift
        now: @escaping () -> TimeInterval,
        firstFixTimeoutSeconds: TimeInterval = 8,
        firstFixAnnounceSeconds: TimeInterval = 1.5
    ) {
```

```swift
        self.firstFixTimeoutSeconds = firstFixTimeoutSeconds
        self.firstFixAnnounceSeconds = firstFixAnnounceSeconds
```

Replace `awaitFirstFix(generation:)`'s body with:

```swift
    private func awaitFirstFix(generation: Int) async -> CLLocationCoordinate2D? {
        resolveFirstFix(nil)
        return await withCheckedContinuation { (continuation: CheckedContinuation<CLLocationCoordinate2D?, Never>) in
            firstFixContinuation = continuation
            // Spoken once, and only while this same wait is still pending: a
            // fix that lands first cancels this in `resolveFirstFix`, so the
            // rider never hears "locating" after guidance has begun.
            firstFixAnnounce = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(self.firstFixAnnounceSeconds * 1_000_000_000))
                guard generation == self.navigationGeneration,
                      self.firstFixContinuation != nil else { return }
                self.speak(Self.locatingSpoken)
            }
            firstFixWatchdog = Task { @MainActor [weak self] in
                let timeout = self?.firstFixTimeoutSeconds ?? 8
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self, generation == self.navigationGeneration else { return }
                self.resolveFirstFix(nil)
            }
        }
    }
```

Cancel it wherever the watchdog is cancelled, in `resolveFirstFix`:

```swift
    private func resolveFirstFix(_ coordinate: CLLocationCoordinate2D?) {
        guard let continuation = firstFixContinuation else { return }
        firstFixContinuation = nil
        firstFixWatchdog?.cancel()
        firstFixWatchdog = nil
        // Cancelled here rather than merely guarded at fire time: a fix landing
        // a moment before the deadline would otherwise queue the announcement
        // behind this resolution on the main actor and speak it anyway.
        firstFixAnnounce?.cancel()
        firstFixAnnounce = nil
        continuation.resume(returning: coordinate)
    }
```

- [ ] **Step 4: Carry the detail only on the no-fix path**

`route.unavailable` is also returned when the relay answers with no route, and that failure must keep speaking 路线规划失败。Give `startFailureResult` an explicit detail parameter (replace the existing declaration at line ~174):

```swift
    private func startFailureResult(generation: Int, detail: String? = nil) -> DeviceActionResult {
        generation == navigationGeneration
            ? .unsupported("route.unavailable", detail)
            : .failed("navigation.cancelled")
    }
```

In `start(_:)`, pass the detail from the no-fix exit only:

```swift
        guard let origin = await awaitFirstFix(generation: generation) else {
            if generation == navigationGeneration, route == nil { stream.stop() }
            return startFailureResult(generation: generation, detail: Self.noFixDetail)
        }
```

Leave the search-failure exit exactly as it is:

```swift
        guard let resolved = await search.route(to: query, from: origin) else {
            if generation == navigationGeneration, route == nil { stream.stop() }
            return startFailureResult(generation: generation)
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd /Users/admin/doubao && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/NavigationControllerTests
```

Expected: PASS, including the five new tests.

- [ ] **Step 6: Run the whole iOS suite**

Run:

```bash
cd /Users/admin/doubao && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Expected: `** TEST SUCCEEDED **`. Existing tests that construct the controller without the new argument still compile because it is defaulted.

- [ ] **Step 7: Commit**

```bash
git add ios/MaxHelmet/Navigation/NavigationController.swift ios/MaxHelmetTests/NavigationControllerTests.swift
git commit -m "fix(ios): announce 正在定位 instead of failing a slow GPS fix"
```

---

### Task 3: Android parity

**Files:**

- Modify: `android/app/src/main/java/com/horizon/maxhelmet/navigation/NavigationController.kt` (constructor, companion constants, `awaitFirstFix`, `takePendingFirstFixLocked`, start failure path)
- Modify: `android/app/src/test/java/com/horizon/maxhelmet/navigation/NavigationControllerTest.kt`

**Interfaces:**

- Produces: `NavigationController(..., firstFixTimeoutMillis: Long = 8_000, firstFixAnnounceMillis: Long = 1_500)`

- [ ] **Step 1: Write the failing tests**

This file does **not** use `runTest`/virtual time. It runs real coroutines on
`Dispatchers.Default` inside `runBlocking`, drives the controller through
`handleCommand(commandId, action, query)`, collects `device.result` payloads as
JSON strings in `h.results`, and waits with the file's own `awaitCondition`
busy-wait. Speech lands in `h.speaker.spoken` as `Pair<String, Boolean>`
(text to interrupt-flag). Match that idiom exactly; do not introduce a second
style.

First extend the existing `Harness` (line ~95) with the new bound:

```kotlin
    private class Harness(
        firstFixTimeoutMillis: Long = 3_000,
        firstFixAnnounceMillis: Long = 1_500,
        hasPermission: () -> Boolean = { true },
        relayTimeoutMillis: Long = 7_000
    ) {
```

and pass it through to the controller it builds:

```kotlin
            firstFixTimeoutMillis = firstFixTimeoutMillis,
            firstFixAnnounceMillis = firstFixAnnounceMillis
```

Then add these tests to the class:

```kotlin
    private val locatingSpoken = "正在定位…"
    private val noFixDetail = "还没定位到，到室外或空旷处再说一次。"

    @Test
    fun `a slow fix announces locating and still starts`() = runBlocking {
        val h = Harness(firstFixTimeoutMillis = 8_000, firstFixAnnounceMillis = 100)

        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-locating", "navigation.start", "人民广场")
        }
        awaitCondition(description = "locating announcement") {
            h.speaker.spoken.any { it.first == locatingSpoken }
        }
        h.locationSource.fix(31.2304, 121.4737)

        awaitCondition(description = "nav.request sent") { h.sent.isNotEmpty() }
        job.cancel()
    }

    @Test
    fun `a prompt fix never announces locating`() = runBlocking {
        val h = Harness(firstFixAnnounceMillis = 100)

        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-prompt", "navigation.start", "人民广场")
        }
        h.locationSource.fix(31.2304, 121.4737)
        awaitCondition(description = "nav.request sent") { h.sent.isNotEmpty() }
        Thread.sleep(200)

        assertFalse(h.speaker.spoken.any { it.first == locatingSpoken })
        job.cancel()
    }

    @Test
    fun `no fix fails with the location detail rather than a routing failure`() = runBlocking {
        val h = Harness(firstFixTimeoutMillis = 150, firstFixAnnounceMillis = 50)

        h.controller.handleCommand("cmd-nofix", "navigation.start", "人民广场")

        awaitCondition(description = "one device.result") { h.results.size == 1 }
        val result = JSONObject(h.results[0])
        assertEquals("route.unavailable", result.getString("reason"))
        assertEquals(noFixDetail, result.getString("detail"))
        assertTrue(h.speaker.spoken.any { it.first == locatingSpoken })
    }

    @Test
    fun `a stop before the fix suppresses the announcement`() = runBlocking {
        val h = Harness(firstFixTimeoutMillis = 8_000, firstFixAnnounceMillis = 250)

        val job = launch(Dispatchers.Default) {
            h.controller.handleCommand("cmd-stopped", "navigation.start", "人民广场")
        }
        Thread.sleep(50)
        h.controller.handleCommand("cmd-stop", "navigation.stop", "")
        Thread.sleep(400)

        assertFalse(h.speaker.spoken.any { it.first == locatingSpoken })
        job.cancel()
    }
```

**Also update the existing test** `no fix within the timeout resolves unsupported without ever reaching the relay` (line ~248). It asserts the no-fix result shape, which now carries a `detail`. Extend its assertions to expect `detail == noFixDetail` rather than leaving it asserting only what it did before — an existing test that silently keeps passing while the payload changed is worse than no test.

A search-failure case (relay answers with no route, `detail` absent) is covered
on iOS in Task 2; add the Kotlin equivalent only if this file already has a
fake relay that can answer "no route" — if it does not, note it in the commit
message rather than building new fake infrastructure for it here.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*NavigationControllerTest*'`
Expected: FAIL to compile — no `firstFixAnnounceMillis` parameter.

- [ ] **Step 3: Implement, mirroring iOS**

In `NavigationController.kt`:

Constructor (line 75-84) — raise the bound and add the announce bound:

```kotlin
    private val firstFixTimeoutMillis: Long = 8_000,
    private val firstFixAnnounceMillis: Long = 1_500
```

Companion constants, beside `STOP_SPOKEN`:

```kotlin
        const val LOCATING_SPOKEN = "正在定位…"
        const val NO_FIX_DETAIL = "还没定位到，到室外或空旷处再说一次。"
```

Add a field beside `firstFixWatchdog`:

```kotlin
    private var firstFixAnnounce: Job? = null
```

In `awaitFirstFix()`, register the announce job inside the same `synchronized(lock)` block that installs the watchdog, using the **same deferred-identity guard** the watchdog uses — identity, not generation, because that is what this port already hardened:

```kotlin
            firstFixAnnounce = scope.launch {
                delay(firstFixAnnounceMillis)
                val stillPending = synchronized(lock) { firstFixContinuation === deferred }
                if (stillPending) speaker.speak(LOCATING_SPOKEN)
            }
```

Cancel it in `takePendingFirstFixLocked()`, which is the single teardown point:

```kotlin
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
```

Then give the start's no-fix exit the detail, leaving the search-failure exit untouched — mirroring Task 2 Step 4. Locate the two exits by their `stopSourceIfOrphaned(generation)` calls: the first (after `awaitFirstFix()`) gains `NO_FIX_DETAIL`; the second (after the search) does not.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*NavigationControllerTest*'`
Expected: PASS

- [ ] **Step 5: Run the whole Android unit suite**

Run: `cd android && ./gradlew :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/horizon/maxhelmet/navigation/NavigationController.kt \
        android/app/src/test/java/com/horizon/maxhelmet/navigation/NavigationControllerTest.kt
git commit -m "fix(android): announce 正在定位 instead of failing a slow GPS fix"
```

---

### Task 4: Web waits for a fix instead of blaming permission

Web is the worst of the three: `handleNavigationStart` denies instantly with `permission.location` whenever no fix has arrived, telling a rider to check a permission that is already granted.

The controller is deliberately timer-free — it reacts to events and reads `now()`. A bounded wait needs one scheduler, injected so tests stay deterministic.

**Files:**

- Modify: `src/lib/navigation.ts` (deps, `handleNavigationStart`, `updatePosition`, `reset`)
- Modify: `tests/web-navigation.test.ts`

`src/hooks/useHelmetAgent.ts:216` calls `createNavigationController({ sendJson, speak, onState })` as a plain object literal, so an added optional `schedule` key needs no change there. Production keeps the `setTimeout` default.

**Interfaces:**

- Produces: `createNavigationController(deps: { …; schedule?: (ms: number, fn: () => void) => () => void })` — returns a cancel function; defaults to `setTimeout`/`clearTimeout`
- Consumes: `sendResult(commandId, status, reason?, detail?)` at `src/lib/navigation.ts:66`

- [ ] **Step 1: Write the failing tests**

Add to `tests/web-navigation.test.ts`:

```ts
describe("navigation.start before a fix has arrived", () => {
  function fakeScheduler() {
    const pending: { at: number; fn: () => void }[] = [];
    let clock = 0;
    return {
      schedule: (ms: number, fn: () => void) => {
        const entry = { at: clock + ms, fn };
        pending.push(entry);
        return () => {
          const i = pending.indexOf(entry);
          if (i >= 0) pending.splice(i, 1);
        };
      },
      advance(ms: number) {
        clock += ms;
        for (const entry of [...pending]) {
          if (entry.at <= clock) {
            pending.splice(pending.indexOf(entry), 1);
            entry.fn();
          }
        }
      }
    };
  }

  it("announces 正在定位 and starts once a fix arrives", () => {
    const sent: unknown[] = [];
    const spoken: string[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p),
      speak: (t) => spoken.push(t),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(1_500);
    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });

    expect(spoken).toContain("正在定位…");
    expect(sent.some((p) => (p as { type?: string }).type === "nav.request")).toBe(true);
  });

  it("no longer blames a permission that was granted", () => {
    const sent: Record<string, unknown>[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: (p) => sent.push(p as Record<string, unknown>),
      speak: () => {},
      onState: () => {},
      schedule: timers.schedule
    });

    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(8_000);

    const result = sent.find((p) => p.type === "device.result");
    expect(result?.reason).toBe("route.unavailable");
    expect(result?.detail).toBe("还没定位到，到室外或空旷处再说一次。");
    expect(result?.reason).not.toBe("permission.location");
  });

  it("stays silent when a fix is already in hand", () => {
    const spoken: string[] = [];
    const timers = fakeScheduler();
    const nav = createNavigationController({
      sendJson: () => {},
      speak: (t) => spoken.push(t),
      onState: () => {},
      schedule: timers.schedule
    });

    nav.updatePosition({ lat: 31.2304, lon: 121.4737 });
    nav.handleDeviceCommand({ action: "navigation.start", args: { query: "外滩" } } as never);
    timers.advance(5_000);

    expect(spoken).not.toContain("正在定位…");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web-navigation.test.ts`
Expected: FAIL — the first test finds no `nav.request` and no 正在定位 because the start is denied immediately.

- [ ] **Step 3: Implement the bounded wait**

In `src/lib/navigation.ts`, add to the deps object (line 36-41):

```ts
  /** Injected so tests stay deterministic. Returns a cancel function. */
  schedule?: (ms: number, fn: () => void) => () => void;
```

and beside `const now = …`:

```ts
const schedule =
  deps.schedule ??
  ((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  });

const FIRST_FIX_ANNOUNCE_MS = 1_500;
const FIRST_FIX_TIMEOUT_MS = 8_000;
const LOCATING_SPOKEN = "正在定位…";
const NO_FIX_DETAIL = "还没定位到，到室外或空旷处再说一次。";

/** Set only while a start is waiting for its first fix. */
let awaitingFix: { commandId: string; query: string; cancels: (() => void)[] } | null = null;

function clearFixWait(): void {
  awaitingFix?.cancels.forEach((cancel) => cancel());
  awaitingFix = null;
}
```

Replace the instant deny in `handleNavigationStart` (line 119-123) with:

```ts
function handleNavigationStart(commandId: string, args: Record<string, unknown>): void {
  const query = typeof args.query === "string" ? args.query : "";
  if (!lastFix) {
    // Not a permission fault: permission may be granted and the fix merely
    // slow, which is the common case indoors. Wait, say so, and only then
    // fail with copy that names the cause.
    clearFixWait();
    awaitingFix = {
      commandId,
      query,
      cancels: [
        schedule(FIRST_FIX_ANNOUNCE_MS, () => {
          if (awaitingFix?.commandId === commandId) deps.speak(LOCATING_SPOKEN);
        }),
        schedule(FIRST_FIX_TIMEOUT_MS, () => {
          if (awaitingFix?.commandId !== commandId) return;
          clearFixWait();
          sendResult(commandId, "failed", "route.unavailable", NO_FIX_DETAIL);
        })
      ]
    };
    return;
  }
  startWithFix(commandId, query);
}
```

Move the remainder of the existing `handleNavigationStart` body — everything after the query is read — into `startWithFix(commandId: string, query: string): void`, unchanged.

In `updatePosition`, resume a waiting start as soon as a fix lands, before the guidance step:

```ts
  function updatePosition(wgs: GeoPoint): void {
    lastFix = wgs;
    if (awaitingFix) {
      const { commandId, query } = awaitingFix;
      clearFixWait();
      startWithFix(commandId, query);
    }
    if (!activeRoute) return;
```

In `reset()`, add `clearFixWait();` beside `lastFix = null;` so a session teardown cannot leave a timer that speaks or answers later.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-navigation.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/lib/navigation.ts tests/web-navigation.test.ts
git commit -m "fix(web): wait for a first fix instead of blaming location permission"
```

---

### Task 5: Update the spec's status and record the parity decision

**Files:**

- Modify: `docs/superpowers/specs/2026-08-16-navigation-first-fix-retry-design.md`

- [ ] **Step 1: Mark the spec implemented**

Change the header line `Status: design, awaiting review` to:

```markdown
Status: implemented 2026-08-16 (relay, iOS, Android, web)
```

- [ ] **Step 2: Record the detail-scoping decision**

Append to the "Decisions" section:

```markdown
5. **`route.unavailable` keeps two voices.** The reason code covers both "no
   fix" and "no route from the relay". Only the no-fix path carries the new
   detail; a search failure still speaks 路线规划失败。 Attaching the location
   copy to both would tell a rider to go outside when the relay simply could
   not find a route.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-navigation-first-fix-retry-design.md
git commit -m "docs(nav): mark the first-fix retry spec implemented"
```

---

## Verification before finishing the branch

- [ ] `npm run check` → exit 0
- [ ] iOS: full `xcodebuild test` → `** TEST SUCCEEDED **`
- [ ] Android: `./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL
- [ ] On-device sanity, which no test can cover: with the phone indoors and GPS cold, ask for a route. Expect 正在定位… within ~2 s, then either a real route or 还没定位到，到室外或空旷处再说一次 — never 路线规划失败.
