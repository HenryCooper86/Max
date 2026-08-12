# RDK iOS GPS and Web HUD Recovery Implementation Plan

**Goal:** Keep iOS GPS sharing alive after a recoverable relay rejection and render the active route on an authenticated direct-LAN RDK Web HUD without exposing the rider's raw coordinates.

**Architecture:** Treat the relay's fix-validation errors (`location.sequence`, `rate`, `timestamp`, `coordinates`, `accuracy`, `course`, and `speed`) as per-fix feedback rather than transport state, leaving the authoritative `ready`/`sharing` state and sender gate intact. Keep `location.state` and `location.binding` terminal because they describe session mismatch rather than a bad sample. For non-loopback HUD clients, retain the existing removal of `navigation.position` and transform route coordinates into a normalized, translation- and scale-free schematic before serialization; loopback clients continue to receive exact geometry.

**Tech Stack:** Swift, XCTest, TypeScript, Node.js WebSocket server, Vitest.

## Constraints

- Keep the 10-second stale threshold and relay validation unchanged; a stale signal must still be reported when fixes genuinely stop.
- Only fix-validation errors are recoverable here. Location binding/state, authentication, pairing, and connection failures keep their current semantics.
- Never send the rider position or raw route coordinates to a non-loopback HUD peer, even when it has the bench token.
- Preserve the route shape and maneuver-marker placement in the direct-LAN schematic.
- Do not mutate the `HudState` supplied to `publish`.

## Task 1: Recover the iOS location stream after a rejected fix

**Files:**

- Test: `ios/MaxHelmetTests/RDKCompanionClientTests.swift`
- Modify: `ios/MaxHelmet/Companion/RDKCompanionClient.swift`

- [x] Add an XCTest that enters `sharing`, sends a fix, receives `companion.error` with `code: "location.rate"`, then verifies the next fix is transmitted and the published state remains `sharing`.
- [x] Run the focused XCTest and confirm it fails for the existing sender shutdown.
- [x] Add a narrow fix-validation-error branch in `handleServerState` that preserves the last authoritative transport state, keeps the desired ride's location gate open, and drains the newest queued fix without publishing `.failed`.
- [x] Re-run the focused XCTest and the complete `RDKCompanionClientTests` class.

Focused command, from `ios/`:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

## Task 2: Show a privacy-preserving route schematic on the LAN HUD

**Files:**

- Test: `tests/rdk-hud-server-security.test.ts`
- Modify: `rdk/agent/src/hud/server.ts`
- Modify: `docs/superpowers/specs/2026-08-12-rdk-hud-route-card-design.md`

- [x] Change the security regression tests so an authenticated non-loopback peer receives a normalized route on both initial replay and later broadcast, while `navigation.position` and every literal raw coordinate remain absent.
- [x] Pin normalization for route and maneuver points, caller-state immutability, and unchanged full-fidelity loopback frames.
- [x] Run the focused Vitest file and confirm the new expectations fail because the current server sends `route: null`.
- [x] Normalize each route point relative to the route's latitude/longitude bounds in `remoteHudSnapshot`; retain destination metadata and omit the rider position.
- [x] Update the route-card design note to document that authenticated direct-LAN clients receive topology-only schematic coordinates, while exact geometry remains loopback-only.
- [x] Re-run the focused HUD security and render tests.

Focused command:

```bash
npx vitest run tests/rdk-hud-server-security.test.ts tests/rdk-hud-render.test.ts
```

## Task 3: Verify the integrated change

- [x] Run `npm run check` from the repository root.
- [x] Run the full iOS `MaxHelmetTests` suite on the iPhone 17 simulator.
- [x] Review `git diff --check`, the final diff, and repository status for unrelated changes.
- [x] Deploy the RDK HUD source with a backup, restart and health-check `max-agent`, and install the signed rebuilt app on the connected iPhone.
- [ ] Run a live ride that confirms continuous fresh fixes and an authenticated direct-LAN navigation route card; do not claim physical end-to-end validation before this passes.

Full iOS command, from `ios/`:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests
```
