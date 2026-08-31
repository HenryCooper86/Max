# Task 15 fix round 7 report: reversed Stop interruption and truthful Start ownership

## Scope

- Review base: `19eafcf7769c7f65f79069d45e81ab13a3c0eeef`
- Review: `task-15-review-7.md`
- Test-only RED: `268d8cc` (`test(ios-companion): cover reversed stop and failed start`)
- Round-seven production change is limited to `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to the existing Task 15 ViewModel test file. Task 16, server/RDK source, the Task 13 client, settings, plists, README, voice behavior, map/Amap, location persistence, and the public product interface are unchanged.

## Review verification and RED

Both review roots were reproduced against unchanged `19eafcf` production before edits. The exact command ran from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The committed strict RED exited 65 after executing 138 focused tests. Only the three new defect regression methods failed, with 61 intended assertions; there was no compiler, fixture, simulator-selection, or unrelated failure.

- A real rider Stop was left pending before a receive or explicit configuration interruption invalidated its client completion. Later logout, B to nested C, and B to nested whitespace-clear all retained account A, retained the failed state, performed zero Disconnects, and ignored late Stop success/error duplicates.
- The same 3 by 3 matrix proved Stop-send failure already releases its completion normally; those three control activities passed before the production edit.
- A real pair-only client followed by invalid relay Start called the client Start wrapper, consumed foreground location, accepted a fix, set `lastForwardedAt`, and claimed an active Helmet Ride despite retaining `.failed(configuration)` and creating no ride socket.
- Synchronous connection/configuration failure at both the Connect and client-Start callbacks likewise reached location and accepted a fix. Auth and unpaired terminal controls already aborted and passed.
- A real active ride receive failure retained its single location session, scheduled one reconnect, opened one replacement socket, resent Start after Ready, and stayed active. This control passed before the edit.

## Implementation

- `handleCompanionState` now reconciles an action-interrupting state with `rideTeardownPhase` even when no account boundary is active yet. It settles the obsolete user-Stop owner immediately; a later logout or token change therefore cannot wait on a completion the client already retired.
- The existing account-boundary and pending-Unpair branches remain first and retain their exact ordering/finalization rules. Active rides have no teardown phase, so ordinary receive failure still uses the client reconnect path.
- `performStartHelmetRide` now treats Start as an owned staged operation. It requires both generation ownership and a viable companion state after Connect, after client Start, and again before marking foreground location active.
- Viable in-progress Start states are limited to paired, connecting, ready, and sharing. Signed-out, offline, unpaired, auth, configuration, and connection failures cannot advance the next stage.
- Failure before client Start invalidates only the provisional ViewModel ride and its location callbacks, so invalid configuration never calls client Start or Core Location. Failure after client Start performs the existing ordered ride rollback, stops client ride/reconnect ownership, and restores the interrupted state only if the rollback generation remains authoritative.
- A transport failure after `helmetRideActive` is true is outside provisional Start rollback and preserves the required same-ride reconnect/throttle ownership.

## GREEN and broad verification

- Four new regression/control methods alone: exit 0; four tests, 0 failures; `** TEST SUCCEEDED **`.
- Exact focused Task 15 plus affected Task 13 command: exit 0; 138 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 385 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData `/tmp/task15-fix7-build-debug.mvmiV1`: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData `/tmp/task15-fix7-build-release.dmHJed`: exit 0; `** BUILD SUCCEEDED **`.
- Source and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source and final built usage strings remain identical: `Max 会在显式开始 Helmet Ride 后使用精确位置，为 RDK 头盔导航提供前台及锁屏期间的位置转发。`
- Cumulative `git diff --check bffe82e` and round-seven `git diff --check 19eafcf`: exit 0. The round contains only the ViewModel, its existing test file, and this report.
- Scoped source/privacy checks found no map/Amap dependency, coordinate/fix/pair-code logging or persistence, plist/README change, server/RDK/Task 16 source, Release ATS broadening, or public product-interface widening.

## Adversarial audit

- User Stop followed by receive failure, Stop-send failure, or configuration interruption settles before logout/B begins. Nested C/clear publication wins, Disconnect occurs once, account A never reconnects, and late Stop success/error duplicates remain stale.
- Boundary-first interruption behavior from round six remains green for direct account Stop and joined user Stop. Pending-Unpair interruption remains ordered and pair-code preserving.
- Invalid relay after pair-only state now produces no ride socket, no client Start, no foreground-location start, no forwarded fix, no active ride, and truthful `.failed(configuration)`.
- Connection/configuration/auth/unpaired states injected synchronously at Connect and Start boundaries cannot begin location. A post-client-Start rollback stops companion intent and cannot overwrite a newer generation/state.
- An already active ride still keeps one location session and one bounded reconnect after ordinary receive loss. Pairing, account-session-token-only authentication, throttle generation, permission teardown, no login/relaunch auto-start, and voice independence remain unchanged and green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. Some successful test runs also print the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands exit 0.
