# Task 15 fix round 8 report: serialized published-state ownership

## Scope

- Review base: `f65add9b89ca19df8d1aa57d773862f5e982640e`
- Review: `task-15-review-8.md`
- Test-only RED commits: `5d1b1bc` (`test(ios-companion): cover published state ownership`), `d1dee25` (`test(ios-companion): cover every published semantic state`), and `f7f5570` (`test(ios-companion): cover queued duplicate publication`).
- Round-eight production changes are limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to the existing Task 15 ViewModel test file. Task 16, server/RDK source, the Task 13 client, settings, plists, README, voice behavior, map/Amap, location persistence, and the public product interface are unchanged.

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

The first committed RED executed 141 focused tests with 90 intended assertion failures, confined to the three new matrix methods.

- The injected 36-case matrix covered Connect, client Start, and location Start publication boundaries; connection, configuration, auth, and unpaired states; and reentrant logout, B to nested C, and B to nested whitespace-clear account intents. Every case exposed a stale outer `@Published` assignment after the newer account/state operation had completed. Token ownership, required Stop and Disconnect ordering, location/fix retirement, and prior controls otherwise passed.
- The real-client nine-case matrix covered actual connecting, ready, and invalid-configuration publications against the same three account intents. It reproduced the same stale final state while preserving the expected socket/account action evidence.
- The all-eight-state control confirmed ordinary and duplicate source events each still publish exactly once.

The first serialization draft fixed the requested matrices, then an adversarial semantic-state test in `d1dee25` exposed that internal product guards could still read stale public storage while Combine was executing a synchronous `willSet` subscriber. Its eight states by three account intents ran as one strict isolated RED with 71 intended failures. Finally, `f7f5570` covered a subscriber that queued an identical `.signedOut` event before reentrant logout; the isolated RED failed two assertions because raw-state coalescing suppressed the newer generation's required public commit.

## Implementation

- The public interface remains exactly `@Published private(set) var companionState: CompanionConnectionState = .signedOut`. No product action signature or companion-client protocol changed.
- Companion state now has a separate authoritative semantic value plus a serialized publication queue. Each publication carries a monotonic ticket, companion-generation owner, publish decision, and completion.
- Incoming state becomes authoritative before public assignment, so a synchronous subscriber's logout, token replacement/clear, Start, Stop, or Unpair observes the newest semantic state rather than the old `@Published` backing value.
- Reentrant publications are queued instead of recursively assigning. After each public assignment returns, only the newest ticket that still owns the current companion generation may execute its semantic completion. An outer event therefore cannot run stale terminal/account effects after a newer subscriber intent has committed.
- Account teardown advances generation before Disconnect, then queues the owned signed-out publication. Logout/token finalization occurs only after that owned publication commits or is intentionally coalesced, so nested B/C/clear intent remains authoritative.
- Identical-state coalescing compares the actual assignment in progress, or the publicly committed value when no assignment is active. It does not use the newest queued semantic value, preventing an obsolete queued duplicate from suppressing a required newer-generation signed-out commit.
- Ordinary duplicate source events remain observable one-for-one. Coalescing is narrowly used only for the internal account-boundary signed-out finalizer.
- Pair, Start, Unpair, provisional-Start rollback, and account-session ownership checks now use the authoritative semantic value. Existing action generations, ordered ride teardown, throttle ownership, and voice independence are unchanged.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: 143 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: 390 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData `/tmp/task15-fix8-verified-debug.CnlFa3`: `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData `/tmp/task15-fix8-verified-release.nTbhR3`: `** BUILD SUCCEEDED **`.
- Source and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both built usage strings remain identical: `Max 会在显式开始 Helmet Ride 后使用精确位置，为 RDK 头盔导航提供前台及锁屏期间的位置转发。`
- Cumulative `git diff --check bffe82e` and round-eight `git diff --check f65add9` pass. The round contains only the ViewModel, its existing test file, and this report.
- Scoped source/privacy checks found no map/Amap dependency, coordinate/fix/pair-code logging or persistence, plist/README change, server/RDK/Task 16 source, Release ATS broadening, or public product-interface widening.

## Adversarial audit

- All eight companion states are authoritative before subscriber code runs. Reentrant logout, B to nested C, and B to nested whitespace-clear finish with the newest token/state, one logical account teardown, one Disconnect when ownership requires it, and no stale outer overwrite.
- Real-client connecting/ready/configuration callbacks obey the same ownership rules; invalid relay remains inactive and truthful, and a subscriber-triggered Start is revalidated through the existing staged Start owner.
- Same-state and ordinary subscribers receive exactly one emission per source event without recursion or duplicate synthetic emission.
- A queued duplicate immediately before logout cannot consume the signed-out publication owned by the newer account generation.
- Previous Stop/Unpair/account-boundary matrices remain green, including late completion errors, nested token intent, terminal client callbacks, ordered location/companion teardown, and no stale fix forwarding.
- Pairing, account-session-token-only authentication, explicit ride ownership, throttle generation, permission teardown, no login/relaunch auto-start, and voice independence remain unchanged and green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. Some successful test runs also print the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands complete successfully.
