# iOS AMap Physical-Device Validation Harness

## Purpose

The native AMap route surface cannot run in the available arm64 simulator, and
the normal route flow currently depends on an authenticated relay account. Add
a narrow development-only path that supplies deterministic guidance to the
existing app so the real consent and map UI can be validated on a signed iPhone
without relay credentials.

This harness is verification support, not a second navigation implementation.
It must exercise the production `AgentScreen` → `GuidanceCard` →
`GuidanceMapHost` → `AMapRouteMap` path.

## Constraints

- Compile all harness entry points and fixture data only in Debug builds.
- Do not change Release behavior, production routing, relay protocols, or
  signing settings.
- Do not auto-accept AMap consent or construct an AMap object before the rider
  accepts the existing disclosure.
- Do not commit, print, snapshot, or otherwise expose the local AMap key.
- Do not add a second map implementation, UI-test target, or simulator fallback.
- Use real AMap network tiles on the physical device; do not mock the SDK.

## Launch Contract

Two explicit Debug-only launch arguments control the harness:

- `--debug-amap-route` injects one fixed mainland-China `GuidanceState` into the
  existing `AgentSession.State`. The fixture contains a short Shanghai WGS-84
  polyline, rider coordinate, maneuver text, distance, and ETA. Production
  display conversion continues to produce GCJ-02 at the AMap boundary.
- `--debug-reset-amap-consent` removes only the app's persisted AMap map-consent
  decision before the fixture route appears. It exists so first-use, decline,
  reconsider, and accept behavior can be repeated without uninstalling the app
  or erasing unrelated settings.

The reset flag does not accept consent. With an unknown decision, the existing
just-in-time sheet appears and remains the only way to create the accepted
capability used by `AMapRouteMap`.

Launching without `--debug-amap-route` follows the ordinary app path. Release
builds contain no active argument parsing, fixture injection, or consent reset
path.

## App Integration

Add a focused Debug-only harness boundary rather than branching throughout the
views:

1. At app appearance, the harness parses the process arguments.
2. If requested, it resets only `AMapConsentStore.defaultsKey`.
3. It installs the deterministic `GuidanceState` through a Debug-only
   `AgentSession` injection method.
4. The published session state causes the ordinary HUD and guidance card to
   render. No map-specific view receives a special testing parameter.

The injected route lives only in memory. A subsequent ordinary launch does not
restore it, and relay/session state remains authoritative outside the explicit
Debug launch.

## Physical-Device Integration Test

Add an opt-in XCTest that compiles only for a physical iOS target and runs only
when `RUN_AMAP_DEVICE_INTEGRATION=1` is supplied. The test:

1. obtains the configured key from the app test host without logging its value;
2. constructs an accepted-consent capability inside the test process;
3. hosts the production `AMapRouteMap` with the deterministic display model;
4. waits for the real SDK map-load completion rather than sleeping;
5. verifies one route overlay, one rider annotation, a fitted finite region,
   disabled map interaction, and the AMap attribution surface; and
6. requests a completed map snapshot to prove that the native renderer produced
   content.

Simulator and ordinary test runs skip this opt-in test without touching the
AMap SDK. The test target inherits the existing development team only through
the verification command, so the project does not gain a machine-specific
signing change.

## Manual Validation

Build and install the configured Debug app on the paired iPhone, then launch it
with both arguments. Validate this sequence through the visible device UI:

1. The route appears in the normal HUD and the existing Chinese disclosure is
   presented just in time.
2. Choosing **暂不启用** keeps the guidance summary visible, shows **地图未启用**,
   and creates no native map surface.
3. Choosing **启用地图**, then **同意并启用**, displays native AMap tiles, the
   route line, rider marker, fitted route, and visible AMap attribution.
4. Relaunching the route without the reset argument does not prompt again.
5. Helmet start/stop remains a two-way helmet tap, no microphone dock appears,
   and active mute remains separate.

If the paired device cannot expose a controllable or inspectable UI, record that
limitation instead of inferring a visible result from unit tests.

## Failure Behavior

- A missing key keeps the production **地图暂不可用** state and never crashes.
- Invalid fixture geometry fails the existing display-model gate before SDK
  construction.
- SDK or tile-load failure drives the existing unavailable state and fails the
  opt-in device test with a sanitized error category, never a key value.
- Running a Release build with either argument has no effect.

## Verification

- Test argument parsing, consent-reset scope, fixture validity, and state
  injection with RED/GREEN unit tests.
- Mutate the Debug gate, reset scope, and fixture injection to prove the tests
  fail for the intended reasons.
- Run the full simulator XCTest suite and no-key simulator build.
- Run Debug and Release generic-device builds, and verify the Release binary has
  no harness argument strings.
- Run the opt-in integration test on the paired iPhone with the configured key,
  without emitting the key in commands or logs.
- Install and visibly exercise the Debug harness sequence on the paired iPhone.
- Re-run tracked-secret and ignored-local-key scans before completion.

## Acceptance Criteria

- A deterministic Debug launch reaches the production route card without relay
  authentication.
- Consent remains unknown/declined until the existing UI records acceptance;
  no pre-consent AMap call is introduced.
- The physical-device test observes a completed native AMap render with the
  production overlay, rider marker, viewport, interaction, and attribution
  behavior.
- Visible device validation confirms real AMap tiles and the complete
  decline/reconsider/accept flow.
- Release behavior and binary surface are unchanged, and the local key remains
  ignored, untracked, and undisclosed.
