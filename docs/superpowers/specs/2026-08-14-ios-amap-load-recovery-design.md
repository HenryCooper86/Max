# iOS AMap Transient-Load Recovery

## Purpose

Keep the production AMap route surface alive when the SDK reports transient
load failures so a later success callback can recover the visible map. The
current host removes `AMapRouteMap` after the first failure callback, which
prevents the same native map from receiving a later success callback.

Physical-device validation observed the callback sequence `true` ten times,
then `false`. The direct renderer test remained mounted and recovered, while
the production host immediately changed to **地图暂不可用** and dismantled the
map after the first `true` value.

## Scope

This change is limited to the lifetime and presentation of an already
authorized native AMap route surface.

- Preserve the existing consent, configured-key, route-geometry, and
  physical-device gates before constructing AMap.
- Preserve the existing display-only map behavior, route rendering, rider
  marker, fitted viewport, attribution, and disabled interactions.
- Do not add a timer, retry button, SDK reconstruction loop, simulator map, or
  second map implementation.
- Do not change relay behavior, route ownership, signing, key storage, or the
  Debug device-validation launch contract.

## Architecture

Separate structural map eligibility from transient load presentation.

`GuidanceMapHost` continues to derive a structural state from:

- persisted AMap consent;
- configured-key presence;
- valid route display geometry; and
- whether the runtime is a physical device.

Only an accepted decision with a key, valid geometry, and a physical-device
runtime yields the native-map state and its `AMapAcceptedConsent` capability.
Unknown, declined, missing-key, invalid-geometry, and simulator states retain
their existing non-map surfaces.

The `loadFailed` value no longer participates in this structural selector.
Once native-map eligibility succeeds, `AMapRouteMap` remains the stable child
while that eligibility remains true. The host renders it through a small,
device-agnostic `GuidanceMapLoadContainer` that owns a stack containing the map
content and a conditional **地图暂不可用** overlay driven by `loadFailed`.

`GuidanceMapLoadContainer` is the single production rendering boundary for
this behavior. It accepts the current failure Boolean and a map-content view;
it has no AMap dependency and therefore remains testable in the simulator.

The overlay is presentation only. It must not replace, recreate, disable, or
otherwise change the identity of the underlying `AMapRouteMap`.

## Data Flow

1. The production host validates consent, key, geometry, and device gates.
2. If any structural gate fails, the corresponding existing placeholder is
   shown and no native AMap object is constructed.
3. If all structural gates pass, the host creates `AMapRouteMap` once and
   supplies the existing `loadFailed` binding.
4. `mapViewDidFailLoadingMap` sets the binding to `true`. The host displays the
   unavailable overlay while leaving the native map mounted.
5. Repeated failure callbacks keep the same state and map identity.
6. `mapViewDidFinishLoadingMap` sets the binding to `false`. The overlay is
   removed and the recovered native tiles, route, rider marker, viewport, and
   attribution remain visible.
7. If the route card disappears or a structural gate becomes ineligible, the
   map is dismantled through the existing lifecycle. A newly created host
   begins with `loadFailed == false`; if eligibility is restored within the
   same surviving host, its next native map may retain the current failure
   value until that map reports its own failure or success callback.

## Failure Behavior

- A transient failure shows **地图暂不可用** without tearing down the map.
- A persistent failure leaves that overlay visible indefinitely while the
  authorized map remains mounted. There is no arbitrary recovery timeout.
- A success after one or more failures removes the overlay immediately.
- A failure after a prior success shows the overlay again without replacing
  the map, and another success may clear it.
- Unknown or declined consent never constructs AMap, regardless of load state.
- Missing key, invalid geometry, or simulator execution never constructs AMap
  and continues to show the existing unavailable surface.

## Testing

### Pure presentation contract

Remove `loadFailed` from the structural presentation selector and add a
separate overlay decision consumed by `GuidanceMapLoadContainer`. Tests prove:

- accepted consent plus key, geometry, and physical device always yields the
  native-map structural state, for both `loadFailed == false` and
  `loadFailed == true`;
- the unavailable-overlay decision exactly follows `loadFailed` once the
  structural native-map state is eligible; and
- unknown, declined, missing-key, invalid-geometry, and simulator inputs never
  yield a native map.

### Mounted recovery contract

Exercise the production `GuidanceMapLoadContainer` in a `UIHostingController`
with a harmless probe child instead of AMap. Drive the observed sequence of ten
failure values followed by success and prove:

- the native map remains mounted through every failure;
- the unavailable overlay is visible during failures;
- the same map identity remains present when success arrives; and
- the overlay disappears after success.

The renderer starts from the production initial state (`loadFailed == false`),
not the prior direct-test probe state (`true`). The probe records creation,
dismantling, and stable identity so the test does not infer lifetime solely
from enum values.

Update the opt-in physical-device test to use the same production container,
start from `false`, record actual failure/success writes, and wait for an SDK
success callback. A direct success remains valid; if failures occur first, the
test must remain alive through them and then validate the recovered renderer.

### Regression mutations

Temporarily perform and restore each mutation:

1. Reintroduce `loadFailed` into the structural map selector. The mounted
   recovery test must fail when the first failure removes the map.
2. Remove or disconnect the unavailable overlay. The failure-presentation test
   must fail.
3. Ignore the later success transition. The recovery test must fail because
   the overlay remains visible.

### Verification

- Run focused presentation and host lifecycle tests.
- Run the full no-key simulator test suite and simulator build, proving no AMap
  symbols leak into the simulator surface.
- Run a no-key generic iPhoneOS build, proving the device-only AMap boundary
  still compiles and links.
- Resume the opt-in signed physical-device renderer test.
- Repeat the visible Debug harness flow on the paired iPhone and confirm that
  accepting the disclosure can progress through transient failures to real
  AMap tiles, route, rider marker, viewport, and attribution.
- Stop and request action-time confirmation if an unexpected microphone or
  location permission prompt appears.
- Keep all verification output sanitized; never print or commit the local AMap
  key.

## Acceptance Criteria

- The observed `failure × 10 → success` sequence does not dismantle the native
  map.
- **地图暂不可用** is visible for current load failures and disappears after a
  later success.
- The recovered production surface displays real AMap tiles and the existing
  route rendering on a physical device.
- Persistent failures remain honest and visible without a timer or retry loop.
- Consent, key, geometry, and simulator gates remain fail-closed before SDK
  construction.
- The opt-in physical-device test no longer passes a lifecycle that production
  cannot survive.
- Release behavior, signing settings, local-key handling, and helmet controls
  remain unchanged.
