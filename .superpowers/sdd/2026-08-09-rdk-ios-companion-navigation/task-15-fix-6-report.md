# Task 15 fix round 6 report: receive-failure Stop finalization

## Scope

- Review base: `97279d73fc86786a818f1a8e6590aac72509ae57`
- Review: `task-15-review-6.md`
- Test-only RED: `410c310` (`test(ios-companion): cover receive-failure stop finalization`)
- Round-six production change is limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to the existing Task 15 ViewModel test file. Task 16, server/RDK source, the Task 13 client, settings, plists, README, voice behavior, map/Amap, location persistence, and the public product interface are unchanged.

## Review verification and RED

The review root was reproduced against unchanged `97279d7` production before edits. The exact command ran from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The committed strict RED exited 65 after executing 134 focused tests. Only the new real-client/ViewModel regression method failed, with 32 intended assertions across its six independent activities; there was no compiler, fixture, simulator-selection, or unrelated failure.

- Both Stop ownership forms failed: a logout/account boundary that directly owns Stop, and a prior rider Stop that the later boundary joins through `rideTeardownPhase`.
- Each form was crossed with logout, B to C replacement, and B to whitespace-clear. A real socket receive failure canceled action ownership before late Stop error/success duplicates were delivered.
- Every activity retained `account-session-token`, retained `.failed(connection)`, performed zero Disconnects, and wrote no logout/newest-token result. This proves the boundary was stranded after the client correctly made the Stop completion stale.
- The matrix also reenters Start plus the newest boundary intent from synchronous failure publication. Late Stop callbacks are delivered in both success/error orders and must not overwrite the final account state.

## Implementation

- `MainViewModel.handleCompanionState` now treats any action-interrupting companion state as an explicit exit for an account boundary that owns or has joined a Stop.
- After preserving the existing pending-Unpair phase rules, it clears `companionAccountStopOwner`, settles `rideTeardownPhase`, and finalizes the companion account transaction exactly once before returning.
- The finalizer Disconnects the old account, advances generation, publishes `.signedOut`, and then drains the authoritative logout or newest B/C/clear token intent through the existing transaction machinery.
- The old auth/unpaired-only account Stop branch is removed because the generalized action-interruption branch owns both terminal and ordinary transport failures. Terminal state still settles a non-account ordinary ride teardown as before.
- The condition requires `companionAccountTeardownActive`; an ordinary receive failure without an account boundary therefore retains the existing desired-ride reconnect behavior.

## GREEN and broad verification

- New six-activity real-client matrix alone: exit 0; one test, 0 failures; `** TEST SUCCEEDED **`.
- Exact focused Task 15 plus affected Task 13 command: exit 0; 134 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 381 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData `/tmp/task15-fix6-build-debug.57tGP9`: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData `/tmp/task15-fix6-build-release.Pn9yJY`: exit 0; `** BUILD SUCCEEDED **`.
- Source and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source and final built usage strings remain identical: `Max 会在显式开始 Helmet Ride 后使用精确位置，为 RDK 头盔导航提供前台及锁屏期间的位置转发。`
- Cumulative `git diff --check bffe82e` and round-six `git diff --check 97279d7`: exit 0. The round contains only the ViewModel, its existing test file, and this report.
- Scoped source/privacy checks found no map/Amap dependency, coordinate/fix/pair-code logging or persistence, plist/README change, server/RDK/Task 16 source, Release ATS broadening, or public product-interface widening.

## Adversarial audit

- Direct account-owned Stop and joined prior rider Stop now both finish across receive failure plus logout/B to C/B to clear, with one location Stop, one companion Stop attempt, one socket cancel, one Disconnect, and no account-A reconnect.
- Repeated logout/token intents from failure publication do not duplicate teardown. The final logged-out/C/clear state is authoritative and old Stop success/failure duplicates are stale after Disconnect advances generation.
- Existing focused controls remain green for Stop send failure, ordinary receive reconnect without an account boundary, auth/unpaired terminal interruption, joined Unpair, fresh Start, duplicate callbacks, and nested account replacement/clearing.
- Pairing, account-session-token-only companion authentication, throttle ownership, permission teardown, no login/relaunch auto-start, and hands-free/voice independence remain unchanged and green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. Some successful test runs also print the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands exit 0.
