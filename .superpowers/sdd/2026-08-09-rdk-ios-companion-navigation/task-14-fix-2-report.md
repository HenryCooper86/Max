# Task 14 fix round 2 report: complete location lifecycle ownership

## Scope

- Base: `3b82462`
- Review: `task-14-review-2.md`
- Commit subject: `fix(ios-companion): harden location lifecycle ownership`
- Production changes remain limited to `CompanionLocationStream`. The throttle, plists, UI/account wiring, socket, navigation, voice, crash detection, and all other location owners are unchanged.

## Review findings verified

All three Important review findings reproduced against the round-1 implementation:

1. An active stream downgraded from precise to denied or reduced stopped forwarding, but a repeated `startFromForeground()` still returned `true` because the result consulted only whether manager updates had begun.
2. If either cleanup flag setter synchronously reentered `stop()`, the nested lifecycle superseded the original stop before it called `stopUpdatingLocation()`. The old manager update obligation was then permanently lost. A cleanup setter that started a replacement lifecycle exposed the same skipped stop debt.
3. An off-main location callback emitted while a superseded manager effect was still unwinding captured the replacement generation instead of the effect's original owner and leaked an old fix into the new lifecycle.

The required correction makes active results permission-aware, treats the manager stop as an independently owned one-shot debt, and protects effect-owner attribution with the generation lock on every callback thread.

## TDD evidence

### Review regression RED

Before production edits, the exact focused command was run from `ios/`:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/CompanionLocationStreamTests \
      -only-testing:MaxHelmetTests/CompanionFixThrottleTests

    exit 65
    Executed 34 tests, with 7 failures

The failures were exactly the missing behaviors:

- denied and reduced active lifecycles each returned `true` from a repeated start instead of `false`;
- reentry from `allowsBackgroundLocationUpdates = false` and from `showsBackgroundLocationIndicator = false` each left `stopCount == 0`, both for nested stop and for nested replacement-start cases;
- an off-main callback emitted after lifecycle replacement but before the old manager effect returned delivered `[92, 93]` instead of only the fresh `[93]`.

Adjacent controls already passed RED: an off-main callback captured before replacement was invalidated normally; stop-updating reentry through nested stop/start rejected the old effect's fix; all prior permission, request/start/stop ownership, and throttle tests remained green.

### Focused GREEN

After the minimal implementation, the exact focused command above returned:

    exit 0
    CompanionLocationStreamTests: 23 passed
    CompanionFixThrottleTests:    11 passed
    Executed 34 tests, with 0 failures
    ** TEST SUCCEEDED **

The retained regressions prove denied/reduced active restarts return false without duplicate request/start effects; a current precise upgrade returns true again; pending not-determined updates remain active but forwarding-closed until a current precise authorization delegate callback; both cleanup setters can reenter stop or start without losing the old manager stop or clobbering the replacement; and off-main callbacks retain the in-flight effect's causal owner.

## Implementation and adversarial audit

- `activeStartResult` now requires an owned, started update session plus either a current-lifecycle precise delegate confirmation or the intentionally pending `.notDetermined` state. Delivered denied/reduced states return false; a later current precise callback restores a truthful true result without restarting the manager.
- A `managerStopPending` debt is created before the first configuration effect for every foreground start attempt, including attempts that later resolve denied/reduced or are synchronously superseded. `stop()` clears the debt before invoking `stopUpdatingLocation()`, so nested stops cannot duplicate it.
- `stopUpdatingLocation()` runs before either cleanup flag setter. If it synchronously stops or starts again, the old effect detects supersession and returns without touching the new owner's flags. If a cleanup setter reenters, the already-discharged stop debt cannot be abandoned or duplicated.
- Generation and `managerEffectOwners` share one short-lived lock. Every manager effect pushes and pops under the lock, but the lock is released before invoking the manager and reacquired only after the effect returns. Delegate entry on any thread atomically captures `managerEffectOwners.last ?? generation` under that lock.
- The lock is never held across a manager effect, `onPermission`, `onFix`, main-queue dispatch, or any fake callback. Synchronous nested effects remain LIFO; off-main callbacks can read the causal top owner without deadlocking; genuinely later callbacks see the current generation after the stack unwinds.
- Main-thread state mutation and generation gates still ensure newest-owner-wins behavior for reentrant permission/fix callbacks, request/start/stop effects, all five property effects, post-stop batches, and a true later fresh callback.
- A 10-iteration selected adversarial run covered both cleanup setters, nested stop/start during stop-updating, off-main callbacks captured before and after replacement, and superseded request/start/stop effects:

      Executed 80 tests, with 0 failures
      ** TEST SUCCEEDED **

- The existing throttle retains its one-slot/no-timer behavior, finite timestamp-millisecond guard, invalid-sample retention rules, one-second boundary, sequence exhaustion protection, reset semantics, and value-copy independence. Its source and 11 tests were unchanged.
- Exact source searches found no shared `SystemLocationStream`, `AgentSession`, mic/voice/navigation/crash owner, logging call, timer, socket, persistence, or backlog in the Task 14 production files. No coordinates, motion, timestamps, fixes, or tokens are logged.

## Full-suite and static verification

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 311 tests, with 0 failures
    ** TEST SUCCEEDED **

    git diff --check
    exit 0

The fix-range file audit before the report contained only `CompanionLocationStream.swift` and `CompanionLocationStreamTests.swift`. Xcode retains the known unrelated simulator/CoreMotion and Swift 6 isolation warnings, plus the post-test diagnostic collector's missing-`simctl` message; the required full command exits successfully.

## Residual scope

- Task 15 still owns plist background mode/usage text and UI/account coordinator behavior.
- Task 16 still owns physical-device permission prompts, long locked-screen operation, force-quit behavior, and end-to-end relay forwarding acceptance.
