# Task 15 fix round 3 report: owned asynchronous unpair and account boundary

## Scope

- Review base: `dddfe7467ab8cc0742d637f9baa518c621a02283`
- Review: `task-15-review-3.md`
- Committed test-only RED: `345cc0d` (`test(ios-companion): cover asynchronous unpair ownership`)
- Round-three production changes are limited to `ios/MaxHelmet/Companion/RDKCompanionClient.swift` and `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to their existing Task 13/15 test files. Task 16, server, settings, plist, README, voice, map/Amap, location persistence, and account-token storage behavior are unchanged in this round.

## Review verification and RED

The two Important roots were reproduced on the unchanged `dddfe74` implementation before production edits. The test-only commit added real-client delayed send control plus ViewModel dependency fakes and observable/reentrant account-boundary probes. The exact command was run from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The strict test-only RED exited 65 after executing all 115 focused tests. The new regressions produced 31 intended assertion failures with zero compiler, fixture, simulator-selection, or unrelated failures:

- Pair-only Unpair cleared its retry code before delayed send acceptance; delayed failure could not restore it, and repeated taps duplicated the destructive request.
- Active Unpair submitted Stop and Unpair together, allowing Unpair to invalidate the later Stop transport failure.
- Account replacement lowered teardown ownership before Disconnect and synchronous signed-out publication, so reentrant Start could connect/start on account A while account B or a nested newer token was being committed.

A subsequent adversarial stage test also pinned that an `.unpaired` publication received while Stop is pending cannot acknowledge the not-yet-sent Unpair action.

## Implementation

- `RDKCompanionClient` now exposes a narrow internal `CompanionActionResult` completion for Stop and Unpair while retaining its existing no-argument compatibility methods. Completion is consumed once and only while the socket, connection generation, and action family still own the send.
- Stop has a separate action epoch. Unpair therefore cannot discard a relevant pending Stop failure, while Disconnect, a new connection, or a fresh Start still invalidates obsolete Stop completion ownership.
- `MainViewModel` owns one two-stage asynchronous Unpair transaction. It marks ride/location inactive first, stops location, waits for accepted Stop when needed, reconnects pair-only sessions with the current trimmed account session token, then submits exactly one Unpair. The pair code clears only for the owned Unpair send/ack stage; delayed failure, Stop failure, invalid relay, account replacement, logout/disconnect, or auth terminal state retains it and cancels stale completions.
- Repeated Unpair taps join the current transaction. Duplicate socket completions are ignored, and a consumed completion cannot clear newer pair-code input.
- One account-boundary owner now remains active through location Stop, companion Stop, Disconnect, synchronous/public signed-out publication, newest nested token selection, persistence, and unwind. Pair/Unpair are rejected and Start is deferred during the boundary; deferred Start is revalidated only after the newest token and final companion state are authoritative. Changed, cleared, same-trimmed, nested logout, Stop, and public Combine reentry controls remain exact-once.
- The public `MainViewModel` product interface, account-only companion authentication, existing voice behavior, throttle, UI/settings, plists, and README remain unchanged.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: exit 0; 116 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 363 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Source and both final built plists: `plutil -lint` OK. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source usage descriptions remain identical and explicitly name precise location, RDK helmet navigation, explicit Helmet Ride, and locked-screen forwarding.
- Cumulative `git diff --check bffe82e`: exit 0. Round-three source scope contains only the client, ViewModel, their two test files, and this report.
- Scoped source/privacy checks found no new map/Amap dependency, logging, coordinate/fix/pair-code persistence, manual-token companion authentication, README/plist change, server source, or Task 16 source.

## Adversarial audit

- Pair-only delayed Unpair failure retains the code and truthful failed state. Repeated taps send one frame; delayed success clears once; a duplicate completion cannot clear newer input.
- Active Unpair waits for Stop acceptance before sending Unpair. Stop failure prevents Unpair and remains truthful. An early `.unpaired` status during the Stop stage cannot clear the code; only the later owned Unpair stage may do so.
- Account replacement and auth terminal callbacks cancel delayed action completion without clearing newer input. Disconnect/new account generations also cancel both Stop/Unpair send ownership in the client.
- Start reentered from Disconnect or public signed-out publication never connects on old account A. Nested C, clear, same-trimmed A, Stop, and logout intents perform one old-account Stop/Disconnect and finish with the newest token plus signed-out/inactive state unless a newly valid post-boundary Start can own the final account.
- Existing same-token idempotence, stream-before-socket teardown, callback generation, throttle deadline reconciliation, pair-only auto-close/reconnect, auth truthfulness, no location auto-start, and hands-free independence remain green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. The full suite also prints the known non-fatal post-success diagnostic collector `simctl` warning; every required command exits 0.
