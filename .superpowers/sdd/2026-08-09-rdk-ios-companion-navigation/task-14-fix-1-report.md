# Task 14 fix round 1 report: permission and manager-effect ownership

## Scope

- Base: `b15b684`
- Review: `task-14-review.md`
- Commit subject: `fix(ios-companion): gate fixes by permission and lifecycle`
- Changed production behavior is limited to `CompanionLocationStream`; the throttle, plists, UI/account wiring, socket, navigation, voice, and other location owners are unchanged.

## Review findings verified

The review's two Important findings were reproducible in the committed implementation:

1. An originally `.notDetermined` start set `acceptsFixes` while the permission decision was still pending, allowing a cached/synchronous location to pass before precise authorization.
2. Delegate callbacks captured the generation at callback entry. An old request/start/stop manager effect could stop and replace the lifecycle, then emit another synchronous callback while unwinding; that callback incorrectly claimed the replacement generation.

The required correction separates location-manager update ownership from permission-to-forward, and associates main-thread synchronous delegate callbacks with the manager effect that produced them.

## TDD evidence

### Review regression RED

Before the production fix, the exact focused command was run:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/CompanionLocationStreamTests \
      -only-testing:MaxHelmetTests/CompanionFixThrottleTests

    exit 65
    Executed 28 tests, with 4 failures

The four new failures were the intended behavior gaps, while the previous 24 tests stayed green:

- undecided authorization delivered `[10, 12, 14]` instead of only precise-authorized `[12, 14]`;
- a superseded request effect delivered stale/fresh `[31, 32]` instead of `[32]`;
- the review's superseded start probe delivered `[21, 22]` instead of `[22]`;
- a superseded stop effect delivered `[41, 42]` instead of `[42]`.

After the first implementation pass, an adjacent strict test proved that a synchronous status re-read was not equivalent to the required authorization delegate decision. It REDed independently:

    testNotDeterminedPreciseStatusReReadCannotReplacePreciseAuthorizationCallback
    received [15, 16], expected [16]
    exit 65

A per-lifecycle precise-delegate confirmation fixed that boundary before broad verification.

### Focused GREEN

On the final tree, the exact focused command above returned:

    exit 0
    CompanionLocationStreamTests: 18 passed
    CompanionFixThrottleTests:    11 passed
    Executed 29 tests, with 0 failures
    ** TEST SUCCEEDED **

The new tests prove that a not-determined ride begins Core Location updates and can return true without forwarding; denied/reduced remain closed; a current precise delegate decision opens forwarding; downgrade closes it; and a mere precise status re-read without the delegate decision stays closed. They also exercise synchronous callbacks emitted while superseded request, start, and stop effects unwind through nested stop/start replacement, followed by a genuinely fresh callback that must deliver.

## Implementation audit

- `updatesStarted`, precise delegate confirmation, and `acceptsFixes` are separate state. An originally not-determined start calls both request and start but keeps `acceptsFixes == false` until the current lifecycle receives `.precise` through `locationManagerDidChangeAuthorization`.
- Direct precise foreground starts remain immediately eligible. A synchronous precise authorization callback during request is remembered even though updates have not started yet; forwarding opens only after that request returns and the owned start effect begins.
- Denied, restricted, reduced, and not-determined authorization callbacks clear precise confirmation and forwarding. A later current precise callback can re-enable the still-owned update session.
- Every callback-producing manager effect is wrapped in a main-thread owner stack: all five configuration writes plus request, start, the two cleanup writes, and stop. Nested effects push their generation and restore the previous owner with `defer`.
- A synchronous main-thread delegate callback captures the top effect owner. Once that owner is superseded, the normal generation gate rejects the callback even if a replacement lifecycle is currently active. A genuinely asynchronous callback runs after the stack unwinds (or arrives off-main), captures the current generation under the existing lock, and is delivered only if that lifecycle still owns an active precise stream.
- The effect-owner stack is main-thread-only and never shares the generation lock. The generation lock is held only for short integer reads/writes and never across manager effects or user callbacks, avoiding reentrant lock cycles.
- Manager effects re-check their generation after returning. If a property/request/stop effect reenters lifecycle replacement, the stale outer operation stops applying further manager effects. The current replacement start result remains authoritative.
- Existing `onPermission` and `onFix` reentrancy tests stay green; stop invalidates state before manager effects and a current synchronous start fix still delivers.
- The throttle source and all 11 throttle tests are unchanged.
- Source searches remain empty for shared `SystemLocationStream`, `AgentSession`, mic/voice/navigation/crash owners, timers, persistence, and logging calls.

## Full-suite and static verification

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 306 tests, with 0 failures
    ** TEST SUCCEEDED **

    git diff --check
    exit 0

Xcode retains the known unrelated Swift 6 isolation warnings when affected existing files compile, plus the environment-only post-test diagnostic that its diagnostic collector cannot find `simctl`; the required commands exit successfully.

## Residual scope

- Task 15 still owns the plist background mode, usage text, and UI/account coordinator behavior.
- Task 16 still owns real-device permission prompts, locked-screen duration, force-quit behavior, and relay forwarding acceptance.
