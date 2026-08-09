# Task 13 report: standalone iOS RDK companion client

## Scope

- Base: bb29cb4
- Commit subject: feat(ios-companion): connect pairing and ride state to the relay
- Production changes are limited to the standalone companion wire protocol, connection state, and dedicated /companion WebSocket client. The implementation does not construct or share the voice /agent transport.

## TDD evidence

### Mandatory RED

After the complete protocol/client tests were added and before any production file was created:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 65
    Testing failed:
      Cannot find type 'CompanionFix' in scope
      Cannot find 'RDKCompanionClient' in scope
      Cannot find type 'CompanionSocketTask' in scope
      Cannot find type 'CompanionHTTPStatusProviding' in scope
    ** TEST FAILED **

This was the intended missing-feature boundary: the synchronized test target compiled the new fixtures and failed because no Task 13 production protocol or client existed. There was no import, target-membership, or fixture error.

The adversarial audit also followed RED/GREEN for three lifecycle defects:

- stopping then starting again on the same ready socket initially omitted the second companion.start;
- a late failed completion from the old start send initially overrode a newer stop;
- a new fix submitted immediately after stop initially drained on the stale sharing authority.

The focused three-test RED produced four expected assertions, followed by 3/3 GREEN after adding action generations and immediate stop authority.

### Focused GREEN

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 0
    RDKCompanionClientTests:    24 passed
    RDKCompanionProtocolTests:  8 passed
    Executed 32 tests, with 0 failures
    ** TEST SUCCEEDED **

The protocol tests cover every server status/error, optional identity mapping, strict malformed/unknown/binary rejection, exact action and location fields, nil optional omission, finite/range validation, and URL/token normalization. The client tests cover main-thread ordered delivery, exactly one receive loop, pair/start/stop/unpair fields, pair-only closure, same-socket restart, six bounded retries at 1/2/4/8/16/30, reset after a valid status, auth and other HTTP upgrade rejection, desired-ride replay, stale receive/send/timer isolation, reentrant stop, and the single in-flight plus newest replacement fix contract.

## Full-suite verification

After the final force-unwrap removal and reconnect-source identity gate:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 237 tests, with 0 failures
    ** TEST SUCCEEDED **

    git diff --check
    exit 0

The build reports the existing Swift 6 isolation warning in Actions/MessageComposer.swift when that file recompiles. Xcode also emits an environment-only post-test diagnostic that its diagnostic collector cannot find simctl; neither warning changes the successful test exit.

## Adversarial audit

- Every receive, action-send, location-send, and reconnect callback checks the client generation plus socket/action/fix/reconnect identity before it can mutate state. A new connect, stop, unpair, or disconnect invalidates older ownership.
- onState delivery and the state machine run on the main queue. Reentrant stop/disconnect/new-connect callbacks are rechecked before start or fix drain, so the newest intent remains authoritative.
- A ride retries only across ordinary transport loss, with exactly six bounded delays. Valid server status resets the counter. Stop, unpair, disconnect, HTTP 401, and explicit non-101 upgrade rejection invalidate the timer owner.
- A paired-only socket closes intentionally without overwriting paired; a later start creates a fresh socket. Repeated ready/sharing messages do not repeat companion.start, while a completed stop permits a later same-socket start.
- Location owns at most one in-flight send and one newest replacement. A failure retains the newest unsent fix, reconnect ready/sharing drains only that fix, and stale completion cannot clear or replay newer work. Stop/unpair/disconnect clear location ownership.
- Server fields are bounded and type-checked; binary, unknown, malformed, non-finite, and out-of-range values fail closed. Client messages contain only the exact contract fields and never emit nil optionals.
- The relay URL accepts only ws/wss with a host, replaces the path/query/fragment, and installs exactly one trimmed account token query item. No token or location payload is logged.
- The convenience initializer creates a new URLSession/delegate per companion socket. Self-signed server trust is accepted only inside DEBUG compilation and only for the immutable opt-in captured for that connection; all other challenges use default evaluation.
- Source inspection of ios/MaxHelmet/Companion finds no AgentSession, MicStreamer, AVAudioSession, microphone, /agent, logging call, force unwrap, forced cast, or unbounded work queue. Async closures capture the client weakly, and client deinit closes the current socket.

## Concerns

- Upgrade-status detection uses URLSessionWebSocketTask.response through the dedicated wrapper plus the tested internal status-provider seam, as required. Physical authentication/TLS against the deployed relay remains integration evidence for Task 16.
- iOS background-location acquisition and one-fix-per-second throttling are intentionally deferred to Task 14; account/UI lifecycle wiring is Task 15.
