# Task 14 report: explicit iOS Helmet Ride location stream

## Scope

- Base: `79a861b`
- Commit subject: `feat(ios-companion): forward explicit background ride location`
- Production changes are limited to a dedicated companion Core Location owner and a timer-free one-slot fix throttle. No plist, UI, account, navigation, voice, or socket lifecycle was changed.

## TDD evidence

### Mandatory RED

After the complete stream/throttle tests were added and before either production file existed:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/CompanionLocationStreamTests \
      -only-testing:MaxHelmetTests/CompanionFixThrottleTests

    exit 65
    Testing failed:
      Cannot find 'CompanionFixThrottle' in scope
      Cannot find type 'CompanionLocationStream' in scope
      Cannot find type 'CompanionLocationManaging' in scope
    ** TEST FAILED **

This was the intended missing-feature boundary: Xcode discovered and compiled the synchronized test target, and the tests failed because the Task 14 production types did not exist. There was no import, target-membership, simulator, or fixture failure.

The adversarial audit then added three focused RED cases against the initial implementation:

- a synchronous When In Use request changing to denied or reduced initially allowed the stale outer start to start and forward;
- an active precise stream downgraded to denied or reduced initially kept forwarding delegate fixes;
- a finite but huge location timestamp initially converted to infinite milliseconds and consumed sequence 1.

The exact focused command exited 65 with those expected behavioral failures (24 tests, 12 assertion failures), then returned GREEN after adding the permission forwarding gate and finite-millisecond validation.

### Focused GREEN

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/CompanionLocationStreamTests \
      -only-testing:MaxHelmetTests/CompanionFixThrottleTests

    exit 0
    CompanionLocationStreamTests: 13 passed
    CompanionFixThrottleTests:    11 passed
    Executed 24 tests, with 0 failures
    ** TEST SUCCEEDED **

The stream tests cover precise/not-determined/denied/restricted/reduced starts, exact manager configuration, foreground truth, every permission mapping, background refusal, newest-only batches, empty/failure/stopped suppression, complete idempotent stop, stop/start ownership, synchronous request/start/stop reentrancy, authorization downgrade, stale callback suppression, and main-thread delivery. The throttle tests cover immediate sequence 1, exact one-second gating, current-at-boundary priority, one-slot replacement and flush, long monotonic rides, reset, value-copy independence, clock rollback/large jumps, all location validity boundaries, finite timestamp conversion, and exact optional motion rules.

## Full-suite verification

After the adversarial fixes:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 301 tests, with 0 failures
    ** TEST SUCCEEDED **

    git diff --check
    exit 0

The build retains pre-existing Swift 6 isolation warnings in unrelated source when Xcode recompiles it. Xcode also emits an environment-only post-test diagnostic that its diagnostic collector cannot find `simctl`; the test command itself exits 0.

## Adversarial and privacy audit

- The production convenience initializer owns one new `CLLocationManager`; the injected test manager is the only alternate owner. Source inspection found no `SystemLocationStream`, `AgentSession`, `MicStreamer`, `NavigationController`, crash owner, audio session, or shared location owner.
- `startFromForeground` has no manager or permission effect outside `.active`. A foreground attempt configures navigation accuracy/activity, background eligibility, indicator, and automatic pausing before any request/start effect.
- Lifecycle generation is locked for cross-thread callback capture. Stop advances ownership before flag writes or `stopUpdatingLocation`, so synchronous stop callbacks and queued old callbacks cannot deliver into a stopped or replacement lifecycle.
- Permission and fix delivery are main-thread marshalled. Duplicate permission states are suppressed per generation. Denied/reduced authorization immediately closes the fix gate while retaining the configured attempt for the coordinator's required explicit stop.
- A synchronous authorization response is re-read after `requestWhenInUseAuthorization`; denied/reduced cannot be overwritten by the outer not-determined start. A reentrant stop/start makes the newest lifecycle authoritative and prevents duplicate starts.
- Each Core Location callback forwards only its final/newest fix. Empty batches, failures, stopped callbacks, and post-downgrade fixes are ignored.
- Stop always clears the background and indicator flags, calls stop once for every owned configured/requested/started attempt, and is safe to repeat.
- The throttle owns no timer, socket, persistence, or collection backlog: it retains at most one immutable `CLLocation` reference and one emission timestamp. Accept-at-boundary chooses the current fix; flush chooses the one retained newest fix.
- Non-finite/backward caller time and invalid location fields do not replace pending work or consume sequence/timing. Timestamp milliseconds are validated after multiplication, and motion values are emitted only under the exact finite/range rules.
- Sequence increment cannot wrap: after the largest representable positive sequence, the value type stops emitting until `reset`. Copies retain independent throttle bookkeeping, and reset starts a new explicit ride at sequence 1.
- Fixed-string logging inspection found no `print`, `NSLog`, `os_log`, `Logger`, or other logging call in either production file. Coordinates, timestamps, course, speed, and retained fixes are never logged.

## Concerns

- The `location` background mode and explicit locked-screen usage text intentionally remain Task 15 plist work. Enabling `allowsBackgroundLocationUpdates` before that configuration can expose Apple's configuration exception, as intended by the task rather than hiding it.
- Simulator tests prove ownership and conversion semantics. Physical locked-screen duration, permission prompts, force-quit behavior, and relay forwarding remain Task 16 acceptance work.
