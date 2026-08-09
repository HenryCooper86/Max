# Task 15 fix round 2 report: serialized account and ride teardown ownership

## Scope

- Review base: `6033f8bcb8e5769efd6efcfb891ba3996c327dcc`
- Review: `task-15-review-2.md`
- Committed test-only RED: `68e2286` (`test(ios-companion): cover nested teardown ownership`)
- Production changes remain limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression support remains in `ios/MaxHelmetTests/CompanionViewModelTests.swift`. Task 16, server, RDK, companion transport/protocol, plist, settings, README, voice, map/Amap, and persistence sources are unchanged in this round.

## Review verification and RED

The three Important findings were reproduced on the unchanged `6033f8b` implementation before production edits. Twelve behavior-level tests were added, using deterministic client/location/persistence collaborators and the real `RDKCompanionClient` for pair-only transport failures. The exact command was run from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests
```

The bounded test-only RED exited 65 after executing all 41 focused tests. Ten new regression methods failed with 24 assertions and zero unexpected/compiler/fixture failures; the prior suite plus ordinary-ready and persistence-reentrancy controls remained green:

- An outer account-B setter overwrote nested changed/cleared/same-account intents, persisted the stale B value, and disconnected the old account twice.
- Stop reentered from `location.stop`, `.unpaired`, or `.failed(auth)` publication duplicated stream and companion Stop effects. A Start requested during cleanup was lost.
- A real pair-only invalid configuration or synchronous receive failure cleared the six-digit retry code without an unpair frame. Active Stop failure still invoked unpair and cleared the code.

## Implementation

- `sessionToken` now fronts one published committed value and a main-thread serialized latest-intent queue. An in-flight account transition tears down the old account once; synchronous newer changed, cleared, or equivalent-trimmed intent replaces the stale outer value before it can commit. Persistence reentrancy is drained in order and the newest intent remains authoritative.
- Ride teardown claims ownership and publishes inactive state before calling either collaborator. Reentrant Stop and terminal callbacks therefore join the in-flight teardown rather than recursively stopping. Explicit Stop can queue one newer Start from synchronous cleanup and drains it only after stream-before-socket teardown has unwound; a later reentrant Stop cancels that pending Start.
- Unpair now verifies the current companion state both before and after the unpair call. Invalid configuration, synchronous connection/auth/transport failure, or active Stop failure leaves the pair code and truthful failure state intact. A valid pair-only auto-close still reconnects with the current trimmed account session token and sends the exact unpair frame.
- Existing generation, throttle, callback invalidation, account-only companion authentication, teardown ordering, and voice independence remain unchanged.

## GREEN and broad verification

- Exact focused command: exit 0; 41 tests, 0 failures (32 ViewModel plus 9 settings/plist/docs/privacy); `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 352 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Source and both built plists: `plutil -lint` OK. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source usage descriptions remain identical and explicitly name precise location, RDK helmet navigation, explicit Helmet Ride, and locked-screen forwarding.
- Cumulative `git diff --check bffe82e`: exit 0. Round-2 scope check lists only `MainViewModel`, its ViewModel tests, and this report after report creation.
- Scoped source/privacy scan found no round-2 map/Amap, logging, coordinate/fix persistence, pair-code persistence, manual-token companion authentication, or stale audio-only README change.

## Adversarial audit

- Changed, cleared, and equivalent-trimmed token intents injected from Stop/Disconnect/state publication persist only the newest pre-commit intent, perform one old-account stop/disconnect, and reject stale state owners. A token injected from persistence becomes authoritative without another completed-account teardown.
- Stop injected from stream cleanup is exact-once. Stop-time unpaired/auth/ordinary state publication is bounded, exact-once, and truthful; the inactive flag is visible before external callbacks. A Start injected from cleanup runs only after the old ordered teardown finishes.
- Real pair-only reconnect succeeds on a second account-authenticated socket and sends unpair. Invalid relay configuration and synchronous receive failure create/send no unpair, retain the code, and preserve the failure. Active Stop failure also blocks unpair.
- Existing logout/auth-required order, voice separation, same-token idempotence, valid pair-only unpair, throttle deadline ownership, stale callback rejection, and auth/unpaired terminal restoration all remain green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. The full suite also prints the known non-fatal post-test diagnostic collector `simctl` warning; all required commands exit 0.
