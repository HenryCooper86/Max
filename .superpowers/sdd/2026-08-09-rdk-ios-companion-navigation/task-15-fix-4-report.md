# Task 15 fix round 4 report: terminal action and joined account teardown ownership

## Scope

- Review base: `08376d7a675cbd3bf04ba79edf07ca6c223999ec`
- Review: `task-15-review-4.md`
- Required test-only RED: `6362761` (`test(ios-companion): cover terminal action ownership`)
- Adversarial test-only RED: `1b92691` (`test(ios-companion): cover auth invalidation during unpair stop`)
- Round-four production changes are limited to `ios/MaxHelmet/Companion/RDKCompanionClient.swift` and `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to their existing Task 13/15 test files. Task 16, server/RDK source, settings, plists, README, voice behavior, map/Amap, location persistence, and the public MainViewModel product interface are unchanged in this round.

## Review verification and RED

The review roots were reproduced against the unchanged `08376d7` implementation before production edits. The exact focused command was run from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The strict test-only RED exited 65 after executing all 125 focused tests. The new regressions produced 41 intended assertion failures with no compiler, fixture, simulator-selection, or unrelated failure:

- A normal pair-only reconnect `.paired` observation closed the socket while its Unpair send was still owned, so the completion was lost and the transaction wedged.
- Delayed Stop/Unpair transport completion could overwrite authoritative auth/unpaired server state.
- Fresh Start at `.sharing` did not retire the obsolete Stop before the next Start frame was eligible to send.
- Logout/account replacement reentered through Unpair location Stop could skip or duplicate cleanup; delayed Stop boundaries could disconnect early or lose the newest account/Start intent.

The final adversarial audit found the adjacent voice-auth-required form of the same joined-boundary issue. Its separately committed test-only RED executed one test with five intended failures: identity clearing during Unpair's location Stop stranded the required companion Stop, Disconnect, token transition, and signed-out publication. A one-condition production fix made that regression green without widening scope.

## Implementation

- `RDKCompanionClient` now uses one internal action-reservation mechanism for Pair/Unpair, Start, and Stop. A reservation owns its family, generation, epoch, and unique identifier; duplicate or obsolete transport completions cannot publish state or call result closures.
- Pair-only `.paired` auto-close now waits while any owned action send is in flight. Owned Unpair success completes once and then closes the pair-only socket; owned send failure publishes one truthful connection failure, completes once, and closes through the transport-failure path.
- Authoritative `.failed(auth)` and `.unpaired` server semantics retire every action reservation before observable callbacks run. Later Stop/Unpair transport completions are stale and cannot replace those terminal states with a generic connection failure.
- A fresh Start intent advances Stop ownership immediately, including while the current server state is `.sharing`. The old Stop result is ignored, and a later `.ready` sends exactly one new Start.
- `MainViewModel` now models Unpair and ordinary/account ride teardown with explicit internal phases. Location ownership is claimed inactive before effects; account teardown joins an in-progress Unpair or ordinary Stop, waits for the one required companion Stop result, then performs one Disconnect. It never sends Unpair after logout/account replacement has claimed the boundary.
- Session-token replacement remains owned until Disconnect and synchronous signed-out publication finish. Reentrant B/C/clear/same-token transitions and Start requests are deferred and revalidated; the newest account intent is authoritative and no old-account socket is reopened.
- Logout is exact-once while asynchronous teardown is pending. Its original relay/token/TLS request is retained for best-effort auth logout, then account identity/token and existing voice state are cleared in their established order.
- Auth-required reentered from Unpair's location Stop now participates in the already-claimed account teardown even after identity is cleared: location stops once, companion Stop resolves before Disconnect, Unpair is canceled, pair code is retained, and the empty-token intent drains to signed out.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: exit 0; 126 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 373 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Source and both final built plists: `plutil -lint` OK. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source location usage descriptions remain identical and explicitly name precise location, RDK helmet navigation, explicit Helmet Ride, and locked-screen forwarding.
- Cumulative `git diff --check bffe82e`: exit 0. Round-four scope contains only the client, ViewModel, their two test files, and this report.
- Scoped source/privacy checks found no new map/Amap dependency, token/coordinate/fix/pair-code logging or persistence, manual-token companion authentication, plist/README change, server/RDK/Task 16 source, or public product-interface widening.

## Adversarial audit

- Pair-only reconnect `.paired` success/failure and duplicate transport completion retain exactly one action owner and close exactly once at the correct boundary.
- Stop and Unpair crossed with auth/unpaired terminal states remain terminal and schedule no retry. A fresh Start crossed with a delayed old Stop remains authoritative before a new Start frame is sent.
- Active Unpair crossed with logout, token B/C replacement, repeated logout, voice auth-required, synchronous location Stop reentry, delayed companion Stop, and terminal server status performs one location Stop and at most one required companion Stop/Disconnect sequence. Account teardown never sends the canceled Unpair and never clears its pair code.
- Start reentered during joined cleanup cannot open old account A. Newest valid account/start intent is reconsidered only after teardown ownership lowers; logout/clear remains signed out and inactive.
- Existing same-token idempotence, stream-before-socket teardown, throttle deadline reconciliation, permission behavior, voice independence, account-session-token-only companion auth, no login/relaunch auto-start, pair-only reconnect, and auth truthfulness remain green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. The full suite also prints the known non-fatal post-success diagnostic-collector `simctl` warning; every required verification command exits 0.
