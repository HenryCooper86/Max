# Task 15 implementation report

## Scope

- Base: `bffe82e`
- Commit: this report ships in `feat(ios-companion): expose pairing and Helmet Ride controls`.
- Implemented only the Task 15 iOS ViewModel, settings, plist, README, tests, and this report.
- Added no map/Amap SDK, coordinate UI, location persistence, automatic ride resume, Task 16, server, or RDK changes.

## TDD evidence

### RED

Before any production edit, added `CompanionViewModelTests.swift` and `CompanionSettingsTests.swift` with deterministic client/location fakes, injected account logout/secret persistence, monotonic and wall clocks, a one-shot scheduler, presentation cases, parsed plist assertions, README operations assertions, and privacy checks.

Ran from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/CompanionViewModelTests -only-testing:MaxHelmetTests/CompanionSettingsTests
```

Expected RED: exit 65. The compiler reached both test files and failed only on the absent Task 15 product contract (`CompanionSettingsPresentation`, companion dependency protocols, the MainViewModel companion state/actions, injected initializer, and voice seam). There were no missing fixture, bad import, simulator-selection, or unrelated product failures.

### GREEN

Repeated the exact scoped command after the minimal implementation: exit 0, 19 tests executed, 0 failures (9 settings/plist/docs/privacy and 10 coordinator/lifecycle/reentrancy tests).

During the first GREEN pass, injected tests exposed an unrelated construction hazard in `AuthClient`: destroying a never-used client materialized its lazy URLSession during `deinit` and crashed the test process. The MainViewModel test seam now defaults its optional auth client to nil; production `init()` still injects the real, shared login/logout client. A single-test rerun and the exact 19-test command both passed afterward.

## Implementation summary

- `MainViewModel` owns one standalone companion client, one location stream, one throttle, and generation/ticket state for the one current flush.
- Pairing validates six trimmed ASCII digits and authenticates only with trimmed `sessionToken`.
- Start invalidates old tickets, resets sequence, then orders connect -> companion start -> foreground location start.
- Stop, unpair, logout, voice auth-required, companion auth failure, permission denial/reduced accuracy, and unpaired status invalidate callbacks before stopping location and then the socket action.
- A current precise fix is throttled to one immediate/newest-per-second output. Stale fix, permission, state, and scheduled callbacks cannot mutate or consume the next ride.
- Existing AgentSession hands-free behavior remains separate; only account logout/auth-required retains its prior voice teardown semantics.
- The settings sheet has a normal `RDK 头盔` section driven by a pure presentation value, number-pad six-digit input, exact Start/Stop labels, destructive unpair confirmation, permission/forwarding copy, and no server detail/device ID/raw fix rendering.
- Both plists contain exactly `audio` plus `location`, identical RDK/locked-screen usage copy, Debug-only arbitrary loads, and normal Release ATS.
- README documents the explicit lifecycle, account-token boundary, precise When In Use permission, locked-screen indicator, force-quit/no-resume behavior, TLS boundary, and no-map/no-coordinate/no-persistence privacy contract.

## Broad verification

- Full MaxHelmet suite, exact iPhone 17 destination: exit 0; 330 tests, 0 failures.
- Required unsigned Debug simulator build: exit 0, `BUILD SUCCEEDED`.
- Additional unsigned Release simulator build: exit 0, `BUILD SUCCEEDED`; the built Release plist has audio/location and no `NSAllowsArbitraryLoads`.
- `plutil -lint ios/MaxHelmet/Info.plist ios/MaxHelmet/Info-Debug.plist`: both OK.
- `git diff --check`: exit 0.
- Scoped source/privacy/coupling checks found no companion use of `effectiveToken`/manual `authToken`, no token or coordinate rendering/logging, no pair/fix persistence, and no new Map/Amap dependency.

## Adversarial audit

- Restored login/app relaunch: no socket, location, fix, throttle, or ride side effect.
- Missing/whitespace account token and invalid/full-width/embedded/non-six-digit pair codes: refused without side effects.
- Pair while connecting/already paired/sharing: refused; pair never starts location or voice.
- Start when not paired/offline/connecting/active: refused; Start at paired/ready uses account token and required call order.
- Foreground refusal, denied, and reduced accuracy: location stop precedes companion stop; duplicate/stale denial is ignored.
- Same-ride connecting/sharing changes: throttle sequence is retained; explicit stop/new start resets to sequence 1.
- Rapid repeated Stop: idempotent. Unpair and logout: location/ride teardown precedes unpair/disconnect/account logout/token deletion.
- Synchronous auth at connect/start/send, synchronous permission from stream start, and reentrant Stop during fix delivery: generation guards leave the newest intent authoritative and do not claim a forwarded timestamp after teardown.
- Old fix, permission, and non-cancelable flush callbacks after stop/new ride: ignored without consuming the new ride's sequence.
- Monotonic time rollback: does not forward or corrupt pending/new sequence state; wall-clock age is clamped to zero.
- Helmet offline/transient reconnect: remains an owned, explicitly stoppable ride without resetting its throttle.
- Hostile server detail/device identity, token, pair code, coordinates, course, and speed sentinels: absent from all presentation strings.
- Settings remains inside the existing scrollable sheet, uses standard SwiftUI controls/dynamic layout and accessibility labels/hints, and introduces no hidden auto-start gesture.

## Remaining physical/environment concerns

- Simulator tests cannot prove ten-minute locked-screen forwarding, the real iOS background indicator, force-quit behavior, or physical RDK reception; those remain Task 16 physical acceptance.
- Xcode occasionally printed a non-fatal diagnostic-collection warning that an internal `xcrun simctl` lookup failed after the full suite; the test command still exited 0 with 330/330 tests passing.
- Existing Swift 6 concurrency/isolation warnings in unrelated camera, messaging, gallery, and navigation sources appeared during a clean compile and are outside Task 15 scope; Task 15 files introduced no build error.
