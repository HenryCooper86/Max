# Task 13 fix round 3: make companion state callbacks reentrant-safe

## Scope

- Base: `366a6f3`
- Planned commit subject: `fix(ios-companion): make state callbacks reentrant-safe`
- Addresses synchronous `.connecting` ownership, pair-only `.paired` close ownership, and adjacent ready/failure publish-then-act ordering.

## Review validation and RED

The review was validated against `366a6f3` before production edits. `openSocket` published `.connecting` while `socket` was nil, so synchronous Start recursively reopened, Pair/Stop/Unpair had no transport on which to serialize, and disconnect/new-connect acted before any candidate existed. The `.paired` handler published before its unconditional pair-only close, so reentrant Pair/Unpair/Stop sends were immediately canceled and their cancellation failures became stale.

The exact mandatory focused command was run from `ios/` after adding the regression tests and before changing production:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 65
    Executed 58 tests, with 32 assertion failures (0 unexpected)

The failures demonstrated:

- bounded recursive `.connecting` publication before any factory ran;
- synchronous reconnect `.connecting` reentry from Start;
- lost initial and reconnect Pair/Stop/Unpair controls;
- disconnect and new-connect callbacks acting before the candidate existed, so the candidate could not be canceled and replacement counts were wrong;
- pair-only `.paired` outer close canceling Pair, Unpair, and Stop, with cancellation-completed sends becoming stale;
- ready-callback location being emitted before the required fresh Start.

Protocol tests, observation-only paired close, Start/disconnect/new-connect at paired, the complete ready public-action matrix, and terminal reconnect-failure restart passed during RED. This separated the two reviewed defects from already-correct generation and failure-path behavior.

## Minimal correction

- `openSocket` now creates and installs the candidate socket and publishes its `.connecting` transport state only after the attempt has concrete ownership.
- After the synchronous callback returns, generation/socket/configuration ownership is revalidated before resume; socket ownership is revalidated again before beginning the one receive loop. Reentrant disconnect or replacement therefore cancels the exact candidate and the outer frame cannot resume or receive it.
- Reentrant Start now sees the owned connecting socket, retains ride intent, and cannot recursively open. Pair/Stop/Unpair serialize once on that same owned socket; automatic reconnect keeps its desired ride and newest-fix behavior.
- A private semantic callback ticket captures generation, pairing epoch, ride epoch, and desired-ride intent before status publication. Pair-only auto-close occurs only when the callback made no semantic command. Reentrant Pair/Unpair/Stop keep their sends and transport-failure ownership; Start keeps the socket; disconnect and explicit replacement continue to win through socket/generation identity.
- Ready publication temporarily gates location. A reentrant latest fix remains pending until the fresh Start is emitted, after which only the newest fix drains. Other public ready callbacks remain authoritative.
- The prior reentrant explicit-connect test no longer completes a nonexistent old location send: the corrected ready ordering intentionally emits no location before Start, and explicit replacement clears the queued old fixes.

## GREEN verification

Final focused verification, including an unguarded observer that calls Start on every initial and automatic-reconnect Connecting callback:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17' \
      -only-testing:MaxHelmetTests/RDKCompanionProtocolTests \
      -only-testing:MaxHelmetTests/RDKCompanionClientTests

    exit 0
    RDKCompanionClientTests:    51 passed
    RDKCompanionProtocolTests:   8 passed
    Executed 59 tests, with 0 failures

Full suite:

    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
      -project MaxHelmet.xcodeproj \
      -scheme MaxHelmet \
      -destination 'platform=iOS Simulator,name=iPhone 17'

    exit 0
    Executed 264 tests, with 0 failures

## Adversarial audit

- Initial and scheduled-reconnect Connecting callbacks cover Start both with a bounded RED witness and an unguarded always-Start observer. Each attempt creates exactly one factory/socket, resumes once, begins one receive, and retains the right ride intent.
- Pair, Stop, Unpair, location, disconnect, and new explicit connect are exercised at both Connecting sources. Same-socket controls are serialized once; teardown/replacement cancels the exact installed candidate before it can resume or receive; stopped/unpaired work cannot later reconnect or drain location.
- Paired callbacks cover Pair, Unpair, Stop, Start, rejected location, disconnect, and explicit replacement. A cancellation-completing fake proves pairing/ride send failures remain relevant instead of becoming stale through the outer close. Observation-only paired still closes exactly once.
- Ready callbacks cover Pair, Start, Stop, Unpair, disconnect, explicit replacement, and newest location. Start precedes location, while stop/unpair/replacement prevent the old handler from reviving ride or draining coordinates.
- Terminal reconnect exhaustion can synchronously start a fresh owned socket without the outer failure path rolling it back. Exact `1/2/4/8/16/30` retry behavior and existing reconnect owner/source checks remain covered.
- Redundant Start and split Pair/Start send ownership remain intact. Same-socket concurrently valid actions cannot disown one another's transport failures, while stop/unpair/connect/disconnect still invalidate the semantic work they supersede.
- Old sockets, receives, action completions, fix completions, and timers remain rejected by generation, socket identity, action-family epoch, send epoch, fix identifier, reconnect owner, and reconnect source.
- Source audit found no `AgentSession`, `MicStreamer`, `AVAudioSession`, microphone, or `/agent` reference in the companion production directory. Dedicated session ownership, Debug-only self-signed TLS handling, exact wire strings, token clearing, and newest-only location behavior are unchanged.
- `git diff --check` passes, and the changed paths are limited to the companion client, its tests, and this report. The task ledger was not edited.

## Concerns

- Xcode emits the known post-success diagnostics-collector error that `simctl` is unavailable; both final verification commands themselves exited 0.
- The existing unrelated Swift 6 actor-isolation warning in `Actions/MessageComposer.swift` appears when the app recompiles.
- Physical relay authentication/TLS, real WebSocket cancellation timing, and board integration remain Task 16 evidence.
