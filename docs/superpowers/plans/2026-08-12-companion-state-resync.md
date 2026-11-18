# Companion State Re-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A relaunched iOS app that is signed in but has no companion state opens a socket when the companion UI appears, so the relay can tell it whether a helmet is bound — replacing the wrong-six-digit-code trick that is currently the only escape from the pairing deadlock.

**Architecture:** One new entry point on `MainViewModel`, `syncCompanionStateIfNeeded()`, called from the companion section's existing `.onAppear`. It mirrors `performPairHelmet` minus the pairing. No new protocol events, no persisted state, no new UI.

**Tech Stack:** Swift / SwiftUI, XCTest, `xcodebuild`.

## Global Constraints

- **The relay is the single source of truth for a binding.** Do not persist companion state on the phone.
- **`.signedOut` is the only state that may trigger a sync.** It is the app's "I have no information" value; every other state was pushed by the relay.
- **No `companion.pair`, `companion.pairDiscover`, or `companion.start` may be sent by this path.** It connects and nothing else.
- **Do not change `performPairHelmet`'s connect-before-validate ordering.** Out of scope.
- Run the iOS suite with:
  `cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests`
- Baseline before this change: **416 tests, 0 failures.**

---

### Task 1: Re-sync companion state on companion-UI appearance

**Files:**

- Modify: `ios/MaxHelmet/UI/MainViewModel.swift` (add the entry point beside `pairHelmet()` at `:470`, and the private implementation beside `performPairHelmet()` at `:519`)
- Modify: `ios/MaxHelmet/UI/AgentSettingsPanel.swift:353` (existing `.onAppear`)
- Test: `ios/MaxHelmetTests/CompanionViewModelTests.swift`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `MainViewModel.syncCompanionStateIfNeeded()` — no parameters, no return value, safe to call from any thread (it hops to main like its siblings).

**Background the implementer needs:**

`authoritativeCompanionState` starts at `.signedOut` and is never persisted, so a relaunched app does not know it is paired. The relay does, and the board has correctly stopped broadcasting discovery and stopped showing a pairing code **because** it is paired. The rider is then stuck: `showsUnpair` is gated on `paired`, `canStartRide` refuses `.signedOut`, and the pairing controls are live but there is nothing to pair to.

`attachCompanion` in `server/companion-registry.ts` calls `syncCompanion(session)` immediately on attach, before handling any client event — so a bare connect with a valid account session is enough for the relay to push the binding. `performPairHelmet` connects _before_ validating the code, which is why a deliberately wrong code currently rescues the app.

`closePairOnlySocketIfIdle` in `RDKCompanionClient.swift` already closes a socket with no desired ride and no outstanding action once the transport reaches `paired`, so the sync socket tears itself down. Do not add teardown logic.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe`-equivalent (the `CompanionViewModelTests` class body) in `ios/MaxHelmetTests/CompanionViewModelTests.swift`:

```swift
// Bench 2026-08-12: every app install put the rider in a deadlock — the relay
// held the binding, the board had gone quiet because it was paired, and the
// app believed it was signed out. No helmet in the list, no six-digit code on
// the HUD, no 解除配对 button, and 开始 Helmet Ride silently no-oped. The only
// escape was typing a deliberately WRONG code, because pairHelmet() connects
// before it validates.
func testAppearingWithNoCompanionStateConnectsSoTheRelayCanTellTheTruth() {
    let harness = Harness()
    harness.events.removeAll()

    harness.viewModel.syncCompanionStateIfNeeded()

    XCTAssertEqual(harness.events, ["companion.connect:ws://relay.example/agent:account-session-token:false"])
    XCTAssertEqual(harness.client.startCount, 0, "a state sync must not start a ride")
    XCTAssertTrue(harness.client.pairCodes.isEmpty, "a state sync must not attempt a pairing")
    XCTAssertTrue(harness.client.pairDiscoverTokens.isEmpty, "nor a discovery pairing")
}

func testTheRelaysAnswerRestoresTheControlsTheDeadlockDisabled() {
    let harness = Harness()
    harness.viewModel.syncCompanionStateIfNeeded()

    harness.client.publish(.paired(deviceId: "rdk-1", label: "Helmet"))

    XCTAssertEqual(harness.viewModel.companionState, .paired(deviceId: "rdk-1", label: "Helmet"))
    let model = CompanionSettingsPresentation.make(
        isLoggedIn: true,
        pairCode: "",
        connectionState: harness.viewModel.companionState,
        rideOwned: false,
        permission: .precise,
        lastForwardedAt: nil,
        now: Date()
    )
    XCTAssertTrue(model.showsUnpair, "the rider can unpair again")
    XCTAssertTrue(model.isPrimaryActionEnabled, "开始 Helmet Ride is no longer dead")
}

func testASyncIsNotAttemptedFromAnyStateTheRelayAlreadySupplied() {
    let states: [CompanionConnectionState] = [
        .paired(deviceId: "rdk-1", label: nil),
        .ready(deviceId: "rdk-1", label: nil),
        .sharing(deviceId: "rdk-1", label: nil),
        .unpaired,
        .connecting,
        .failed(code: "connection", detail: "Companion connection closed."),
        .failed(code: "auth", detail: "expired")
    ]

    for state in states {
        let harness = Harness()
        harness.client.publish(state)
        harness.events.removeAll()

        harness.viewModel.syncCompanionStateIfNeeded()

        XCTAssertTrue(
            harness.events.filter { $0.hasPrefix("companion.connect:") }.isEmpty,
            "state \(state) came from the relay; re-syncing it would reconnect for nothing"
        )
    }
}

func testASignedOutRiderIsNotConnectedOnTheirBehalf() {
    let harness = Harness(accountToken: "")
    harness.events.removeAll()

    harness.viewModel.syncCompanionStateIfNeeded()

    XCTAssertTrue(harness.events.filter { $0.hasPrefix("companion.connect:") }.isEmpty)
}

func testASecondAppearanceWhileASyncIsInFlightOpensNoSecondSocket() {
    let harness = Harness()
    harness.events.removeAll()

    harness.viewModel.syncCompanionStateIfNeeded()
    // The real client publishes `.connecting` synchronously from `connect()`;
    // FakeCompanionClient does not, so drive it explicitly — this is the state
    // a second appearance actually finds in production. Without this the test
    // would only measure the fake and pass no matter what the guard does.
    harness.client.publish(.connecting)
    harness.viewModel.syncCompanionStateIfNeeded()

    XCTAssertEqual(
        harness.events.filter { $0.hasPrefix("companion.connect:") }.count,
        1,
        "a sync already in flight must not be restarted by another appearance"
    )
    XCTAssertEqual(harness.client.startCount, 0)
    XCTAssertTrue(harness.client.pairCodes.isEmpty)
}

func testAFailedSyncLeavesStartAsAWorkingRetry() {
    let harness = Harness()
    harness.client.onConnect = { harness.client.publish(.failed(code: "connection", detail: "Companion connection closed.")) }

    harness.viewModel.syncCompanionStateIfNeeded()

    XCTAssertEqual(harness.viewModel.companionState, .failed(code: "connection", detail: "Companion connection closed."))
    let model = CompanionSettingsPresentation.make(
        isLoggedIn: true,
        pairCode: "",
        connectionState: harness.viewModel.companionState,
        rideOwned: false,
        permission: .precise,
        lastForwardedAt: nil,
        now: Date()
    )
    XCTAssertTrue(model.isPrimaryActionEnabled, "a failed sync must not re-create the dead end")
}
```

`FakeCompanionClient` already records `pairCodes`, `pairDiscoverTokens`, `startCount`, and exposes an `onConnect` hook — the tests above use those directly. Do not add counters to it or change any existing member's semantics.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests
```

Expected: compilation failure — `syncCompanionStateIfNeeded()` does not exist. That is the correct RED for this task; fix only by adding the method, not by weakening a test.

- [ ] **Step 3: Add the entry point**

In `ios/MaxHelmet/UI/MainViewModel.swift`, immediately after `pairHelmet()` (`:470-472`):

```swift
    /// Ask the relay what it knows, when the app knows nothing.
    ///
    /// Companion state is not persisted, so a relaunched app starts at
    /// `.signedOut` while the relay may still hold a binding — and a paired
    /// board deliberately stops broadcasting discovery and stops showing a
    /// pairing code, so there is nothing for the rider to pair to. Connecting
    /// is enough: the relay syncs the binding on attach.
    func syncCompanionStateIfNeeded() {
        onMain { [weak self] in self?.performSyncCompanionState() }
    }
```

- [ ] **Step 4: Add the implementation**

In the same file, immediately after `performPairHelmet()` (which ends at `:543`):

```swift
    private func performSyncCompanionState() {
        dispatchPrecondition(condition: .onQueue(.main))
        // `.signedOut` is the only state that cannot have come from the relay.
        // Anything else was pushed by it and is either correct or a failure the
        // rider can already act on, so re-syncing would reconnect for nothing.
        guard !sessionTokenTransitionActive,
              !companionAccountTeardownActive,
              pendingUnpairOwner == nil,
              hasAccountSession,
              !rideOwned,
              authoritativeCompanionState == .signedOut else {
            return
        }

        let owner = advanceCompanionGeneration()
        advanceCompanionStatePublicationEpoch()
        bindCompanionState(owner: owner)
        companionClient.connect(
            relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
            sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
            allowSelfSignedTLS: allowSelfSigned
        )
        // Nothing follows the connect. `closePairOnlySocketIfIdle` closes this
        // socket once the relay's status lands, so the transport stays
        // ride-scoped.
    }
```

The guards mirror `performPairHelmet` exactly, minus the six-digit-code check and `canPair`, plus the `.signedOut` requirement. Keeping them aligned matters: a sync must never interrupt a ride start, an unpair transaction, or an account teardown.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests
```

Expected: PASS.

- [ ] **Step 6: Wire it to the companion UI**

In `ios/MaxHelmet/UI/AgentSettingsPanel.swift:353`, the companion section already carries:

```swift
        .onAppear { viewModel.startHelmetDiscovery() }
```

Change it to:

```swift
        .onAppear {
            viewModel.syncCompanionStateIfNeeded()
            viewModel.startHelmetDiscovery()
        }
```

Sync first: discovery is only useful once the app knows whether it is already paired, and a paired board is not broadcasting anyway.

- [ ] **Step 7: Run the whole iOS suite**

```bash
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests
```

Expected: 422 tests, 0 failures (416 baseline + 6 new). Every pre-existing test must still pass — if one now fails, the guards are wrong; do not edit the failing test to accommodate the change without saying so explicitly in your report.

- [ ] **Step 8: Commit**

```bash
git add ios/MaxHelmet/UI/MainViewModel.swift ios/MaxHelmet/UI/AgentSettingsPanel.swift ios/MaxHelmetTests/CompanionViewModelTests.swift
git commit -m "fix(ios-companion): re-sync pairing state when the companion UI appears"
```

---

## Manual verification on the bench

The unit tests cannot prove the deadlock is gone, because the deadlock needs a real relay holding a binding the app has forgotten. Reproduce it exactly as it occurred:

1. Pair the phone to the board and confirm `RDK 头盔已连接`.
2. Reinstall the app (`xcrun devicectl device install app …`) — this kills the process and wipes companion state while the relay keeps the binding.
3. Open the app and go to the companion section.
4. **Before this change:** `尚未连接 RDK 头盔`, no helmet listed, no 解除配对, dead 开始 Helmet Ride.
   **After:** the section resolves on its own — `RDK 头盔已连接` with 解除配对 present and Start enabled if the board is powered on, or `已配对，头盔离线` with 解除配对 present and Start correctly disabled if the board is powered down. Either is correct; no six-digit code typed.
5. Confirm on the relay that exactly one `companion phone attached` line appears for that appearance, and **no** `companion request rejected` line:
   `ssh -i ~/Desktop/LightsailDefaultKey-ap-northeast-2.pem ubuntu@3.35.135.136 'grep -iE "companion" ~/.pm2/logs/max-out.log | tail -5'`
6. Leave the screen and return to it; confirm no further connects once the state is known.
