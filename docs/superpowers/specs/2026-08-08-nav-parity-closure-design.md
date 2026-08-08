# Nav Parity Closure Design

## Summary

Plans A/B/C shipped relay-routed navigation on web, iOS, and Android with one
guidance engine contract — but the review cycles left a short, well-evidenced
list of controller-level divergences and two confirmed defects. This spec
closes that list in one coordinated pass: the relay takes over the spoken
route summary (one implementation, three platforms), "停止导航" wins over an
in-flight start on both phones, iOS adopts the three lifecycle hardenings
Android's Plan C reviews established as the reference shape (one of which
fixes a confirmed live iOS defect), the web client's reroute-failure behavior
is aligned to the spec rule both phones already implement, and the shared
guidance test table gets its two long-parked closures on all three platforms
at once.

Everything here is either a reviewed defect, a reviewed divergence with a
chosen canonical side, or a reviewed test gap. No new features, no protocol
changes, no datum changes.

## Scope

### Goals

- One data-true spoken route summary, composed by the relay, identical on all
  three platforms; iOS stops speaking its local summary.
- "停止导航" cancels an in-flight `navigation.start` on iOS and Android; the
  cancelled start answers `failed`/`navigation.cancelled` (web's existing
  code), never `route.unavailable`.
- iOS lifecycle hardening to Android's reference shapes: post-arrival reroute
  guard (`route != nil` alongside the generation — fixes a confirmed live
  defect), atomic preempt-and-register in `RelayNavigationSearch`, reroute
  cooldown/latch reset on start-commit and stop.
- Web reroute failure stops cleanly with a spoken explanation (spec rule from
  the 2026-08-06 design; both phones already comply — web's keep-guiding
  silent retry is the deviation).
- Shared table closures on TS, Swift, and Kotlin together: exact-string
  far/near template assertions, and an arrival case with destination ≠ last
  polyline vertex pinning rule 6's distinguishing clause.

### Non-goals

- No protocol/schema changes (`nav.*` and `device.result` shapes are
  untouched; `navigation.cancelled` is an existing reason string in the web
  client).
- No datum changes anywhere.
- No engine-semantics changes — the six-rule contract is untouched; only its
  test tables gain assertions/cases.
- The off-route announcement latch difference (web announces once per
  excursion; phones announce per reroute send, throttled by the 20 s
  cooldown) stays as-is — each shape is defensible and no review flagged a
  defect.
- The Android fast-follow items from Plan C's final review (one-block
  bump-and-start, `manager != null` tighten, doc line) ride along only if an
  Android file is already open for the stop-cancels work; they are not goals.

## The relay-spoken summary

Today the reconciliation mechanism (`DeviceReconciliation` in
`server/device-actions.ts`: `okSpeech` on the issued command, spoken when the
matching `device.result` arrives ok) exists but is never wired for
navigation, so iOS speaks a local summary, Android speaks nothing, and web
relies on the agent's scripted reply — which never knows real route data.

Change: when the relay forwards a `nav.route` for command X to the client, it
attaches okSpeech to issued command X:

```
已找到{destinationName}，全程{distanceKm}公里，预计{etaMinutes}分钟。仅供参考，请注意实际路况。
```

- `distanceKm` = distanceMeters/1000 rounded to one decimal below 10 km,
  whole numbers at/above; `etaMinutes` = ceil(etaSeconds/60). Values come
  from the exact `nav.route` payload the relay proxied — data-true by
  construction.
- The attachment is keyed by commandId on the already-tracked
  `IssuedDeviceCommand`; if the command has already expired (8 s backstop
  fired), the attachment is a no-op.
- `nav.error` attaches nothing — the existing failure reconciliation
  (`deviceFailureSpeech`) already speaks the distinguishing truth.
- iOS deletes `openingSummary` and its call site; the "已到达目的地。"
  arrival line and all other controller lines are unchanged. Android and web
  change nothing here.

## Stop cancels an in-flight start (both phones)

Canonical semantics (web's `cancelHeldStart` is the model): a stop command
arriving while a `navigation.start` is still unresolved (awaiting first fix
or awaiting the relay) cancels that start.

- The stop bumps the navigation generation and resolves any pending
  first-fix wait and any pending relay request, even when no route is
  committed.
- The stop answers `ok` — the rider's intent was honored (today's
  `failed`/`navigation.notActive` in this window is technically true and
  practically wrong: navigation begins seconds after the rider forbade it).
  A stop with nothing active AND nothing in flight still answers
  `failed`/`navigation.notActive`.
- The cancelled start answers `failed`/`navigation.cancelled` — never
  `unsupported`/`route.unavailable`, which would blame GPS/routing for a
  rider decision. (Alignment note: this also becomes the reason code for a
  start superseded by a NEWER start on both phones, replacing
  `route.unavailable` in that path, matching web.)
- The relay needs no change: `navigation.cancelled` flows through the
  existing failure-speech mapping the web client already exercises.

## iOS lifecycle hardening (Android reference shapes)

1. **Post-arrival reroute guard** (`NavigationController.swift`,
   `attemptReroute`'s answer handling): require `route != nil` alongside the
   generation check before BOTH branches. Without it, a reroute launched just
   before arrival revives finished guidance (confirmed live defect: stream
   restarted, card back, right after "已到达目的地。") or speaks a spurious
   "无法重新规划路线" after arrival. Kotlin reference:
   `NavigationController.kt`'s guarded `performReroute`.
2. **Atomic preempt-and-register** (`RelayNavigationSearch.swift`,
   `awaitAnswer`): replace the `failPending()`-then-register two-step with
   one critical section that swaps in the new continuation and returns the
   preempted one, resolving it nil outside the lock, then sends. Today this
   is shielded only by main-actor call-site confinement; the Kotlin
   `awaitAnswer` swap is the reference.
3. **Cooldown/latch reset**: reset `lastRerouteAt` and the rerouting latch on
   start-commit and on stop, so a fresh route never inherits the previous
   route's 20 s reroute cooldown (web and Android both do this; iOS is the
   holdout).

## Web reroute-failure alignment

`src/lib/navigation.ts`: on a failed reroute answer, stop guidance cleanly
and speak the failure (the phones' shared line: 无法重新规划路线，已停止导航。
— web speaks through its existing speech path), instead of keeping the stale
route and silently retrying after cooldown. This is the 2026-08-06 spec's own
rule ("Reroute failure mid-ride → guidance stops cleanly with a spoken
explanation, never a stale route"); web was the deviation. The
once-per-excursion 偏离路线 announcement latch stays (non-goal).

## Shared table closures (TS + Swift + Kotlin, one coordinated change)

1. **Exact-string templates**: the far/near cases assert
   `前方350米，右转` and `前方100米，右转` exactly (replacing the
   `^前方\d+米，右转$` regex), pinning the live rounded distance on every
   platform. This closes the long-parked plan-mandated ruling in favor of
   exact strings, applied to all three tables in one commit so the
   "same table" property is preserved.
2. **Arrival-vertex case**: a new case on a route whose destination
   coordinate is offset from the last polyline vertex (e.g. destination
   ~100 m past the final vertex), asserting arrival fires within 30 m of the
   LAST VERTEX and does not fire at 30 m of the destination coordinate —
   pinning rule 6's "last polyline vertex, not destination" clause, untested
   on all three platforms today.

## Error and edge handling

- Every changed result path stays exactly-one-`device.result` per command;
  the cancelled-start and superseding-start paths are covered by tests on
  both phones.
- The relay okSpeech attachment must not resurrect an expired command
  (no-op after the 8 s backstop) and must not speak twice if `nav.route`
  is somehow forwarded twice for one commandId (attachment is idempotent —
  last write wins on an unexpired command; the reconciliation speaks once).
- iOS's atomic-swap change preserves every existing resume path
  (answer/error/timeout/failPending) exactly once — the Swift port carries
  the same take-and-clear discipline the Kotlin reviews proved.

## Verification

- **Relay (vitest)**: okSpeech attachment on nav.route forward (spoken line
  matches the payload's numbers); expired-command no-op; nav.error leaves
  failure speech untouched.
- **iOS (XCTest)**: post-arrival revival regression tests (success: no
  revival; failure: no spurious speech); atomic-swap concurrency test
  (mirroring the Kotlin parallel test's shape within main-actor constraints);
  cooldown-reset test (fresh start reroutes immediately); stop-cancels tests
  (stop mid-first-fix and mid-relay-await → stop ok, start
  navigation.cancelled, nothing installs); openingSummary removal (the
  held-ordering test's speech expectations updated).
- **Android (JUnit)**: stop-cancels tests (same two windows); reason-code
  updates in existing concurrent-start tests (route.unavailable →
  navigation.cancelled where a start is superseded/cancelled).
- **Web (vitest)**: reroute-failure stops cleanly + speaks; no silent retry.
- **All three tables**: exact-string + arrival-vertex cases green.
- Full gates at every task boundary: `npm run check`; iOS suite via
  xcodebuild; Android `./gradlew test lintDebug assembleDebug`.

## Acceptance criteria

- Starting navigation on any platform yields the same relay-spoken summary
  sentence, with numbers matching the actual route; iOS no longer speaks a
  local summary.
- On both phones: "停止导航" during an in-flight start prevents any route
  from installing, answers ok, and the start answers navigation.cancelled.
- The iOS post-arrival revival defect is closed with regression tests; the
  iOS preempt-and-register window is closed; a fresh iOS route reroutes
  without inheriting the old cooldown.
- Web stops cleanly on reroute failure with the shared spoken line.
- All three guidance tables assert exact prompt strings and the
  last-vertex arrival clause; all platform gates green.
