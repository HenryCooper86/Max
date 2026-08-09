# Task 15 fix round 1 report: account, unpair, throttle, and terminal-state ownership

## Scope

- Base: `bb1b7e45f544f0322f47817c269faa6058f12874`
- Review: `task-15-review.md`
- Commit subject: `fix(ios-companion): harden account and throttle ownership`
- Changed only `MainViewModel`, its companion regression tests, the contradictory iOS README platform note, and this report. Task 16, server, RDK, plist, map/Amap, voice, and location persistence sources are unchanged.

## Review verification and RED

The four Important findings were verified against the committed Task 15 implementation before production edits. New behavior-level tests use the real `RDKCompanionClient` where transport composition matters and deterministic injected collaborators for account, scheduler, and synchronous state ownership.

The exact focused command was run from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests
```

On the test-only tree it exited 65 after executing all 28 tests. Eight new regression methods failed with 21 assertions and zero unexpected/compiler/fixture failures; the prior 19 focused tests and the same-trimmed-token idempotence probe remained green:

- A real pair-only client sent `companion.pair`, consumed `.paired`, closed its socket, and then created no second socket or `companion.unpair` frame.
- Replacing or clearing `sessionToken`, including replacement reentered from fix delivery, persisted the value but left the ride, stream, socket, stale callbacks, and forwarded timestamp owned by the old account.
- A delayed obsolete deadline prevented a new pending fix from owning a callback, and an early current deadline did not reschedule its pending newest fix.
- Synchronous `.ready` publication from `stopRide()` overwrote both `.failed(auth)` and `.unpaired` terminal states.

After the first minimal GREEN, an adjacent strict reentrancy test was added before its production correction. It changed the account token from a synchronous state callback during auth teardown and REDed independently: location stop and companion stop each occurred twice instead of once. This exposed in-flight teardown ownership rather than a fixture issue.

## Implementation

- Pair-only Unpair recognizes the real client's documented post-`.paired` close. It invalidates local ride/stream ownership first, reconnects with the current trimmed account `sessionToken`, generation-checks synchronous callbacks, and only then sends `companion.unpair`. An auth failure leaves the code and failed state truthful. Active-ride unpair keeps its existing stream-stop -> companion-stop -> unpair ordering and never touches voice.
- A trimmed account token change is now an account boundary whenever companion state/ride ownership exists. The old generation, pending throttle output, and stream callbacks are invalidated; location stops before companion stop; the old standalone client disconnects before the new token is persisted/published; no ride auto-resumes. A whitespace-only equivalent token update persists without interrupting the ride.
- In-flight ride teardown has explicit depth ownership. A newer account intent arriving synchronously during stop publication invalidates the old generation and disconnects without repeating location or ride stop, while a genuinely newer owned ride would still receive its own teardown.
- Every newer immediate throttle emission invalidates the obsolete deadline ticket. A subsequent pending newest fix receives a fresh ticket. An early current callback preserves ownership by scheduling exactly one remaining-delay callback; obsolete, repeated, stopped, and prior-generation callbacks remain no-ops.
- Auth and unpaired terminal states are restored after ordered teardown only when the teardown generation is still current. Synchronous stop-state noise cannot overwrite them, while a newer logout/account/start generation remains authoritative.
- The README platform note now states `UIBackgroundModes = audio, location` and distinguishes explicit Helmet Ride location from background voice behavior.

## GREEN and broad verification

- Final exact focused command: exit 0; 29 tests, 0 failures (20 ViewModel plus 9 settings/plist/docs/privacy).
- Full MaxHelmet command on the exact iPhone 17 destination: exit 0; 340 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build: exit 0; built plist lint OK, `audio` + `location`, intended Debug `NSAllowsArbitraryLoads = true`.
- Fresh unsigned Release generic simulator build: exit 0; built plist lint OK, `audio` + `location`, `NSAllowsLocalNetworking = true`, and no `NSAllowsArbitraryLoads`.
- Source `plutil -lint` for both plists: OK.
- `git diff --check`: exit 0.
- Scoped source/privacy checks: no companion `effectiveToken`/manual `authToken`, logging, map/Amap, pair-code persistence, or fix persistence; no stale README audio-only note.

## Adversarial audit

- Normal pair-only close then Unpair sends the real JSON frame over a newly account-authenticated socket; stream stop is observable before socket construction and voice receives no call.
- Token replacement and clearing invalidate current fix/permission/state/timer owners, reset throttle state, disconnect the old account, and leave signed-out companion UI. Invoking every captured old callback afterward cannot send or overwrite state.
- Same trimmed token is idempotent. Replacement from inside fix delivery leaves no forwarded timestamp; replacement from synchronous auth teardown wins without duplicate effects.
- Delayed old, early current, consumed repeated, stop/new-generation, and newest pending deadline orders are executable and preserve exactly one current pending output with continuous sequence.
- Synchronous ready noise during auth/unpaired stop cannot overwrite terminal state; a newer account generation prevents the older terminal restore.
- Existing logout/auth-required order, voice separation, explicit start/stop, precise-only forwarding, same-ride reconnect sequence, and stale callback tests remain green.

## Remaining concerns

- Physical locked-screen duration, location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency/deprecation warnings. The full suite also prints the known non-fatal post-test diagnostic collector `simctl` lookup warning; required commands exit 0.
