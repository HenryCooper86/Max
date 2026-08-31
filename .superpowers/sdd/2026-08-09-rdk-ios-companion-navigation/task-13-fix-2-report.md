# Task 13 fix round 2: isolate explicit sessions and action ownership

## Scope

- Base: `4a4d47b`
- Planned commit subject: `fix(ios-companion): isolate explicit sessions and action ownership`
- Addresses the independent review's explicit-connect privacy boundary, redundant Start completion ownership, adjacent Pair/Start ownership, and dedicated production-session coverage gap.

## Review validation and RED

The review was validated against `4a4d47b` before production edits. Public `connect` retained `desiredRide` plus pending/in-flight location, so either changed-token or same-token replacement resumed the prior ride on the new socket. `startRide` also advanced the single action epoch before its no-op guard, making the only pending start failure stale.

The exact mandatory focused command was run from `ios/` after adding the regression tests and before changing production:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 65
    Executed 44 tests, with 9 assertion failures (0 unexpected)

The five failing behaviors were:

- changed-token explicit connect sent the prior ride's start/location;
- same-token explicit connect did the same instead of acting as a deterministic session boundary;
- reentrant explicit replacement from a ready callback carried the newest old coordinate;
- repeated Start at connecting/ready/sharing masked the only start-send failure, leaving cancel count 0 and no one-second reconnect;
- Start while Pair was pending masked the Pair transport failure.

The convenience construction and strengthened dedicated-session/source guard passed during RED.

An adversarial follow-up then tested both directions of concurrent Pair and Start sends. Against the first minimal ownership change, the exact focused command produced a second strict RED:

    exit 65
    Executed 46 tests, with 4 assertion failures (0 unexpected)

Fresh Start disowned a pending Pair failure, and Pair disowned a pending Start failure. This proved one global action epoch was structurally too broad.

An early exploratory attempt to invoke the private convenience factory by extracting its stored Swift closure through `Mirror` was removed before the authoritative RED. Isolated runs and the simulator crash report showed that invoking the reflected closure returned an invalid existential on arm64 and caused `SIGBUS`. The committed coverage instead executes headless convenience construction and uses a source-coupling guard for the private production factory/session/task without widening interfaces or starting a network task.

## Minimal correction

- Every public `connect`, including same-token connect, now clears desired ride and all pending/in-flight location work before validating and opening the new session.
- Internal automatic reconnect remains separate and continues retaining only the newest location while the same ride intent is active.
- Action completion ownership is split into private pairing and ride families. Pair and Start can coexist without silencing each other's transport failures.
- Stop/fresh Start and Unpair advance the semantic families they actually supersede. Connect/disconnect invalidate both families and the socket generation.
- Redundant Start advances no ownership unless it sends a fresh `companion.start`; repeated connecting/ready/sharing calls remain idempotent.
- The standalone guard confirms the convenience initializer selects `DedicatedCompanionSocket`, whose private implementation owns a dedicated `URLSession` and WebSocket task, while construction itself creates no socket or state transition.

## GREEN verification

Focused after the final ownership correction:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 0
    RDKCompanionClientTests:    38 passed
    RDKCompanionProtocolTests:   8 passed
    Executed 46 tests, with 0 failures

Full suite after the final ownership correction:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 251 tests, with 0 failures

## Adversarial audit

- Changed-token and same-token explicit connect both revoke old ride, start, action, reconnect, pending-fix, and in-flight-fix authority before the new socket is created.
- Old receive, action-send, location-send, and timer completions remain rejected by generation/socket/epoch/owner checks. Reentrant explicit connect also makes the old ready handler fail its post-callback socket-generation guard.
- Internal transport recovery does not call public `connect`; it retains desired ride and the newest coordinate, waits the exact bounded delay, and sends one fresh start per ready socket.
- Repeated Start while connecting, ready, or sharing does not send a duplicate or advance ride ownership. Failure of the one actual start cancels the current socket and schedules exactly one one-second reconnect.
- Stop followed by a fresh Start advances ride ownership, so stale start/stop failures cannot override the new intent, while the fresh start's own failure remains active.
- Pair and Start sends carry separate family tickets. Failure of either remains relevant while both are concurrently valid on the same current socket. Unpair invalidates both pairing and ride work it supersedes.
- The convenience client constructs headlessly. The source guard reads both production companion files, asserts the dedicated socket/session/WebSocket path, and rejects `AgentSession`, `MicStreamer`, `AVAudioSession`, microphone, and `/agent` references case-insensitively.
- Exact companion wire strings, URL/token handling, newest-only location flow, bounded backoff, HTTP handling, and Debug-only self-signed TLS behavior are unchanged.

## Concerns

- Xcode continues to emit the known post-success diagnostics-collector error that `simctl` is unavailable; both verification commands themselves exited 0 with the results above.
- The existing unrelated Swift 6 actor-isolation warning in `Actions/MessageComposer.swift` appears when the app recompiles.
- Physical relay authentication/TLS and board integration remain Task 16 evidence.
