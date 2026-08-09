# Task 15 fix round 9 report: transport-scoped state publication

## Scope

- Review base: `ce8d6843356e40a600ff1e5fc0172a8870142046`
- Review: `task-15-review-9.md`
- Test-only RED: `af8458c` (`test(ios-companion): cover ride-owned state publication`)
- Round-nine production changes are limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to the existing Task 15 ViewModel test file. Task 16, server/RDK source, the Task 13 client, settings, plists, README, voice behavior, map/Amap, location persistence, and the public product interface are unchanged.

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

The committed strict RED executed 147 focused tests with exactly 160 intended assertion failures: two state/publication failures in each of 80 new activities. The four new methods were the only failing tests; their exact ride, client, socket, location, account, and stale-callback controls passed.

- Forty injected activities repeated `.paired` subscriber Start against synchronous connection, configuration, auth, and unpaired Connect results ten times each. Every accepted result became the ViewModel's action state and correctly aborted before client Start or location, but was discarded by queue drain after rollback advanced the shared generation. The published sequence and final public state remained paired.
- Ten real-client activities delivered paired and reentered Start with an invalid relay. The real client canceled the pair transport, published configuration failure, created no replacement socket, and started neither ride nor location; the ViewModel still discarded that accepted failure and publicly remained paired.
- Twenty injected activities repeated `.paired` subscriber Start then ordinary Stop with synchronous connecting and ready results. Exact-one initial client Start/Stop and location Start/Stop behavior passed, including ready-state restart eligibility, but both accepted states were discarded and the public state remained paired.
- Ten real-client activities repeated paired subscriber Start then Stop. The replacement socket remained the current connecting transport and accepted exactly one Stop while the public state incorrectly remained paired.
- Every activity then exercised B to nested C or B to nested whitespace-clear, invoked the captured old callback twice, and proved the existing account boundary still committed only one signed-out publication, one Disconnect, the newest token, and no stale duplicate.

## Implementation

- Client callback acceptance still captures the existing companion/ride generation, so callbacks from an obsolete binding remain rejected before publication.
- Accepted state records now separately capture a companion-state publication epoch representing the current client transport/account session. Queue drain and state-dependent semantic completion validate this epoch plus the existing monotonic publication ticket instead of revalidating ride generation.
- Pair, Start, and pair-only Unpair reconnect advance the publication epoch before replacing the client transport, then bind the callback to both the new ride generation and transport epoch.
- Account teardown advances the publication epoch as soon as the boundary is claimed and immediately rebinds the still-current client callback. This suppresses already queued old-account state while still allowing a delayed current Stop transport failure to finish the owned teardown transaction.
- Ordinary Stop, permission teardown, and provisional-Start rollback continue to advance ride generation but do not replace the transport/account publication epoch. A state already accepted from that current transport therefore remains eligible to publish and run only its newest event completion.
- The prior provisional-Start failure re-publication was removed because the accepted source record now survives ride rollback itself. This preserves one source event to one public emission and avoids duplicating failure/auth/unpaired events.
- The public interface remains exactly `@Published private(set) var companionState: CompanionConnectionState = .signedOut`; product action and companion-client protocol signatures are unchanged.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: 147 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: 394 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData `/tmp/task15-fix9-debug.xeo0S5`: `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData `/tmp/task15-fix9-release.BP9gDt`: `** BUILD SUCCEEDED **`.
- Both source plists and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both built usage strings remain identical: `Max 会在显式开始 Helmet Ride 后使用精确位置，为 RDK 头盔导航提供前台及锁屏期间的位置转发。`
- Cumulative `git diff --check bffe82e` and round-nine `git diff --check ce8d684` pass. The round contains only the ViewModel, its existing test file, and this report.
- Scoped source/privacy checks found no map/Amap dependency, coordinate/fix/pair-code logging or persistence, plist/README change, server/RDK/Task 16 source, Release ATS broadening, or public product-interface widening.

## Adversarial audit

- Synchronous connection/configuration/auth/unpaired results remain publicly truthful after a provisional ride generation is retired, and a second Start stays ineligible exactly when that final presentation says it is.
- Connecting survives ordinary Stop and remains ineligible; ready survives ordinary Stop and authorizes exactly one explicit new Start, with normal exact-one cleanup.
- The real invalid-relay path creates no ride socket, starts no client ride/location, forwards no fix, and finishes failed rather than paired.
- The real connecting socket remains owned across Stop, receives exactly one Stop frame, and is canceled only when the later account boundary disconnects it.
- B to nested C/clear advances the account publication epoch, commits one signed-out event, and rejects duplicate calls through the captured old binding. Existing logout, duplicate-state, all-eight-state, terminal, delayed Stop/Unpair, and nested account matrices remain green.
- Pairing, account-session-token-only authentication, explicit ride ownership, throttle generation, permission teardown, no login/relaunch auto-start, and voice independence remain unchanged and green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. Successful full test runs may also print the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands complete successfully.
