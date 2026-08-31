# Task 15 fix round 10 report: terminal-priority publication ownership

## Scope

- Review base: `4f17269a8780fd5f90e16fd3b8b50a2666f4d67e`
- Review: `task-15-review-10.md`
- Test-only RED: `2e2dfe9` (`test(ios-companion): cover queued terminal priority`)
- Round-ten production changes are limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to the existing Task 15 ViewModel test file. Task 16, server/RDK source, the Task 13 client, settings, plists, README, voice behavior, map/Amap, location persistence, and the public product interface are unchanged.

## Review verification and RED

The review root was reproduced before production edits with the exact focused command from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The committed strict RED executed 150 focused tests with exactly 80 intended assertion failures. Only `testQueuedStartTerminalOutranksRollbackReadyStress` failed: two terminal-finality assertions in each of 40 activities, covering 20 auth and 20 unpaired repetitions. Exact-one client Start/Stop, rollback location cleanup, inactive ownership, absent fixes, stale callback rejection, one signed-out publication/disconnect, and nested logout/B-to-C/B-to-clear controls all passed.

Additional committed controls were already green in RED:

- Ordinary then duplicate terminal queueing publishes in source order but leaves the latest terminal authoritative, without starting client or location work.
- A terminal subscriber may explicitly replace the account/transport epoch and then perform a fresh Pair/Start; the old terminal does not leak into or block the new epoch.

## Implementation

- An accepted auth/unpaired record now claims terminal authority for its current companion-state publication epoch when enqueued, before an outer `@Published` assignment finishes notifying subscribers.
- Later non-terminal state from that same epoch is rejected before it can replace the authoritative state, take the newest semantic ticket, or publish stale rollback presentation. Duplicate terminal records remain eligible; the newest accepted terminal performs the single semantic completion.
- A genuine explicit Pair, Start, pair-only Unpair reconnect, or account/transport replacement advances the existing publication epoch and clears old terminal authority. Terminal priority therefore does not become a global sticky preference across reconnects.
- Account teardown advances the publication epoch immediately before Disconnect/signed-out publication. This lets logout or newest-token replacement retire the terminal transport and commit the required account boundary even when a terminal arrived reentrantly during its Stop transaction.
- Auth/unpaired ride teardown no longer republishes the same terminal after rollback. The accepted source record remains the sole public/semantic terminal event, avoiding duplicate state emissions.
- The public interface remains exactly `@Published private(set) var companionState: CompanionConnectionState = .signedOut`; product action and companion-client protocol signatures are unchanged.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: 150 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: 397 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData `/tmp/task15-fix10-debug.MNTjAO`: `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData `/tmp/task15-fix10-release.MnKnzO`: `** BUILD SUCCEEDED **`.
- Both source plists and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both built location usage strings remain identical: `Max 会在显式开始 Helmet Ride 后使用精确位置，为 RDK 头盔导航提供前台及锁屏期间的位置转发。`
- Cumulative `git diff --check bffe82e` and round-ten `git diff --check 4f17269` pass. The round contains only the ViewModel, its existing test file, and this report.
- Scoped source/privacy checks found no map/Amap dependency, coordinate/fix/pair-code logging or persistence, plist/README change, server/RDK/Task 16 source, Release ATS broadening, or public product-interface widening.

## Adversarial audit

- In the composed outer-paired → reentrant Start → synchronous auth/unpaired → rollback Stop → Ready sequence, terminal ownership is established before Ready can queue. The terminal publishes once, performs its semantic teardown once, and remains the final truthful state.
- An ordinary state already queued before terminal may still publish first; duplicate terminal notifications remain observable in source order while only the newest terminal record owns semantic completion and final state.
- Standalone terminal handling, same-state publication, active ride teardown, delayed Stop/Unpair transactions, account-boundary interruption, and nested B/C/clear matrices remain green.
- Explicit Pair/Start/account replacement advances the epoch, so a deliberate new Connect may supersede the old terminal and establish a coherent paired/ready/sharing state. Captured old-client callbacks still fail epoch/generation ownership.
- Pairing, account-session-token-only authentication, explicit ride ownership, throttle generation, permission teardown, no login/relaunch auto-start, and voice independence remain unchanged and green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. Successful full test runs may also print the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands complete successfully.
