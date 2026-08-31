# Task 13 fix round 1: keep stopped rides authoritative

## Scope

- Base: db87a5e
- Planned commit subject: fix(ios-companion): keep stopped rides from forwarding location
- Addresses the independent review's Important ride-intent finding and the standalone convenience/source-test coverage gap.

## Review validation and RED

The review was validated against db87a5e before production edits. The relay's ready/sharing state unconditionally restored canSendLocation, sharing rewrote the locally owned startSentOnSocket flag, and sendLatest retained work with no desired ride.

The exact mandatory focused command was run after adding the committed regression tests and before changing production:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 65
    Executed 39 tests, with 5 failures

The five behavioral failures were:

- ready before start emitted location;
- stop followed by a raced fix and ready/late-sharing emitted location;
- stop/late-sharing/rapid-restart/ready omitted the fresh second start;
- unpair followed by late ready/sharing emitted location;
- a post-disconnect fix crossed the next account connection and emitted on ready.

The new production convenience construction test and case-insensitive source-coupling guard both passed during RED, proving the test fixtures and executable guard were valid independently of the lifecycle failures.

## Minimal correction

- sendLatest now rejects fixes unless the current local desiredRide is true.
- ready/sharing can authorize location only while desiredRide is true.
- drainLatestFix rechecks desiredRide at the final send boundary.
- sharing no longer mutates startSentOnSocket; that flag now records only a locally sent companion.start.
- startRide on an already-ready socket establishes current location authority and drains only current desired work after sending the fresh start.
- Existing newest-fix tests now establish explicit ride intent before exercising location forwarding.

## GREEN verification

Focused:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 0
    RDKCompanionClientTests:    31 passed
    RDKCompanionProtocolTests:   8 passed
    Executed 39 tests, with 0 failures

Full suite:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 244 tests, with 0 failures

    git diff --check
    exit 0

Production coupling search:

    rg -n 'AgentSession|MicStreamer|AVAudioSession|microphone|/agent' ios/MaxHelmet/Companion
    exit 1 (expected: no matches)

## Adversarial audit

- Initial ready and sharing status cannot forward a fix without an explicit startRide.
- Stop clears desired intent and fix ownership immediately. New/raced fixes are dropped, and later ready/sharing cannot restore location authority.
- Unpair has the same cutoff. Disconnect drops later fixes and prevents them from crossing a new token/account connection.
- A late sharing after stop cannot claim a local start was sent. A rapid restart followed by ready sends exactly one new companion.start in start/stop/start order; repeated ready/sharing does not duplicate it.
- Reentrant stop/unpair/disconnect during onState still clears canSendLocation and pending/in-flight work before the post-callback drain recheck.
- Receive, action-send, location-send, and reconnect generation/socket/epoch guards are unchanged. Reconnect still preserves only the newest fix while desiredRide remains true.
- The convenience initializer is executed without connect and emits no connection state before explicit teardown. The committed source guard reads both production companion files and fails case-insensitively on AgentSession, MicStreamer, AVAudioSession, microphone, or /agent coupling.
- No private TLS/session implementation was made public. The dedicated Debug-only trust behavior and URL/token wire contract are unchanged.

## Concerns

- Xcode continues to emit the known post-success simulator diagnostic that its collector cannot find simctl; test commands themselves return the results above.
- Physical relay authentication/TLS and board integration remain Task 16 evidence.
