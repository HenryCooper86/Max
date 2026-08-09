# Task 13 fix round 4: serialize socket opening and receive pumps

## Scope

- Base: `34399ac`
- Planned commit subject: `fix(ios-companion): serialize opening and receive pumps`
- Addresses synchronous receive-completion recursion and the injected factory's unowned opening window without changing public or wire interfaces.

## Review validation and RED

The review was validated against `34399ac` before production edits. `receive(on:generation:)` directly rearmed after every success, so a conforming socket that completed synchronously added a client and socket stack frame per buffered message. `openSocket` also had no reservation before calling the injected factory, so synchronous factory→Start reentered the factory while `socket` was still nil.

The exact mandatory focused command was run from `ios/` after adding test-only regressions and before changing production:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 65
    Executed 67 tests, with 19 assertion failures (0 unexpected)

The RED witnesses demonstrated:

- a 96-status synchronous source reached receive nesting depth 96 instead of 1;
- malformed, unknown, and binary synchronous messages reached depth 3 instead of 1;
- one completion invoked twice published the duplicate state and created an extra pending registration;
- teardown after a synchronous malformed message could not prevent the eager second receive;
- a factory that called Start on every bounded invocation recursively entered four factories and never installed/resumed the intended returned task;
- factory-window Stop and Unpair were lost, allowing the returned task to resume and receive instead of aborting the invalidated attempt.

The reentrant synchronous-status replacement and explicit generation-replacement cases passed during the initial RED, confirming the existing socket/generation checks were sound once an owned task existed.

During adversarial source review after the first GREEN, an adjacent same-object replacement case was added before its correction. If both stale and authoritative factory frames returned the same task object, the stale outer frame canceled the new generation's installed task:

    exit 65
    Executed 69 tests, with 1 assertion failure (0 unexpected)

That second RED drove a narrow identity guard: a stale factory return is canceled unless it is the exact task already owned by the authoritative replacement generation.

The newest-intent audit then exposed a separate reservation-unwind defect before any further production edit. A factory that synchronously called Stop (or Unpair) and then Start left `desiredRide` true, but the invalidated outer reservation canceled its candidate and cleared the only opening attempt. The exact focused command failed as follows:

    exit 65
    Executed 71 tests, with 8 assertion failures (0 unexpected)

Both committed cases failed: Stop/Unpair→Start did not open a fresh owned candidate after the factory frame unwound, and an always Stop→Start factory had no bounded semantic recovery. The existing 69 focused tests remained green during this RED.

## Minimal correction

- A private per-generation opening reservation is installed before invoking the socket factory. Same-generation Start can update desired ride but cannot recursively open while the factory is active.
- Stop and Unpair invalidate the current opening reservation; when its factory returns, that stale candidate is canceled before Connecting publication, resume, or receive. Disconnect clears the reservation, while public Connect advances generation and creates a new authoritative reservation.
- If an invalidated factory frame receives a newer Start intent, it requests one main-queue deferred reopen after the frame and public Connect call unwind. The reopen revalidates generation, semantic owner, desired ride, configuration, empty socket ownership, and absence of another active attempt.
- Semantic recovery is capped at one fresh attempt. If an adversarial recovery factory also issues Stop→Start, its candidate is canceled and no third factory call is scheduled; a later genuine public Start may begin a new bounded chain.
- Every returned candidate must still own its reservation, generation, empty socket slot, and configuration before installation. A stale return cannot cancel an identical task already installed by a reentrant newer generation.
- Each receive call owns a private registration identifier and receive epoch. Only the first completion matching the active registration can change state; duplicate completions are ignored.
- A synchronous completion schedules its rearm onto the next main-queue turn. Ordinary asynchronous completions retain immediate serialized rearm, preserving existing callback ordering and the test fake's one-outstanding-receive contract.
- Active registration and deferred rearm ownership reset on explicit replacement, disconnect, pair-only close, transport failure, and fresh socket installation. Every deferred block revalidates epoch, generation, and socket identity before registering another receive.

## GREEN verification

Final focused verification:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 0
    RDKCompanionClientTests:    64 passed
    RDKCompanionProtocolTests:   8 passed
    Executed 72 tests, with 0 failures

Final full suite:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 277 tests, with 0 failures

## Adversarial audit

- Ninety-six synchronously returned, distinctly identified Ready states publish in exact order with maximum socket receive depth 1, then leave exactly one pending receive. Failing that pending receive stops rearm and publishes one terminal connection failure.
- A failure returned synchronously during registration also stops with depth 1, no pending callback, no deferred rearm, and one transport cancel.
- Malformed, unknown, and binary synchronous frames publish no partial state but continue through the trampoline with depth 1 and exactly one pending receive.
- A malicious duplicate invocation of one registered completion consumes only the first result, publishes no duplicate state, and leaves one logical receive registration.
- Disconnect before a queued synchronous rearm prevents a second receive. A new explicit Connect from a synchronous Ready callback leaves the old task canceled with no rearm and the replacement with one receive.
- Factory→Start on every safely bounded invocation yields one factory, one installed/resumed task, one receive, retained desired ride, and exactly one Start at Ready.
- Factory-window Stop, Unpair, and Disconnect cancel the returned stale attempt before resume/receive. Reentrant new Connect makes the new generation authoritative with both distinct returned tasks and the same returned task identity.
- Factory-window Stop→Start and Unpair→Start return to the caller with exactly one factory call, then open one fresh candidate on the next main-queue turn and send one Start at Ready. An always Stop→Start factory performs exactly one deferred recovery (two total calls), never resumes either invalidated task, and does not recurse or loop.
- Stop, Unpair, Disconnect, and a new explicit Connect issued after the deferred reopen is queued but before it runs invalidate that work. The first three leave no socket; new Connect installs only the account-B candidate and the old generation cannot add another factory call.
- Round-3 Connecting, Paired, Ready, failure-callback, explicit-account, redundant-Start, split Pair/Start, stale-completion, privacy cutoff, newest-only location, and exact reconnect-delay tests remain green.
- Exact companion wire strings, URL/token handling, dedicated session ownership, Debug-only self-signed TLS, and public interfaces are unchanged.
- Companion-source search remains empty for `AgentSession`, `MicStreamer`, `AVAudioSession`, microphone, and `/agent`; no token or coordinate logging was added.
- `git diff --check` passes. Changed paths are limited to the companion client, its tests, and this report; the task ledger was not edited.

## Concerns

- Xcode emits the known post-success diagnostics-collector error that `simctl` is unavailable; both final commands themselves exited 0.
- The existing unrelated Swift 6 actor-isolation warning in `Actions/MessageComposer.swift` appears when the app recompiles.
- Physical relay authentication/TLS, real WebSocket cancellation timing, and board integration remain Task 16 evidence.
