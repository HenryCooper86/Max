# iOS AMap Route Display and Helmet-Only Hands-Free Toggle

## Summary

Replace the Apple MapKit surface in the iOS live-guidance card with a native
AMap (高德地图) route display. Keep the existing relay-side AMap place search and
routing, iOS guidance engine, spoken maneuvers, rerouting, and navigation
lifecycle unchanged. The new SDK is display-only.

At the same time, remove the duplicate microphone start/stop dock. The animated
helmet becomes the sole hands-free session toggle: one tap starts hands-free and
the next tap stops it. The separate mute action remains available during an
active session because it changes microphone transmission without ending the
session.

This design supersedes the "no AMap iOS SDK" non-goal in
`2026-08-06-amap-navigation-design.md`. It does not change that spec's routing
provider, protocol, guidance semantics, or truthful-failure requirements.

## Goals

- Render the active iOS route and rider position over native AMap tiles.
- Preserve the existing relay-backed route and pure guidance architecture.
- Keep Core Location and the iOS guidance engine in WGS-84, converting only at
  the AMap display boundary.
- Meet AMap's privacy-compliance requirement before creating any `MAMapView`.
- Show the consent request just in time, when the first navigation route needs a
  map, rather than at app launch.
- Keep navigation functional when consent is declined, the SDK key is absent,
  or the map cannot load.
- Remove the microphone dock and all dead dock-specific presentation code.
- Preserve the helmet's start/stop behavior and accessibility semantics.

## Non-goals

- Replacing relay-side routing or adding on-device destination search.
- Adding AMap's Navigation SDK or Location SDK.
- Changing `NavigationController`, `GuidanceEngine`, maneuver thresholds,
  reroute behavior, arrival behavior, or spoken confirmation text.
- Adding interactive map browsing, destination search UI, lane guidance,
  traffic, speed limits, or background navigation.
- Adding a MapKit fallback after AMap integration.
- Changing the web, Android, or RDK map surfaces.
- Changing the separate in-session mute action.

## Chosen approach

Use AMap's native 3D Map SDK through the official CocoaPods distribution. Select
the no-IDFA pod because the app does not need advertising identifiers. Wrap
`MAMapView` in a focused SwiftUI `UIViewRepresentable` that owns display state
only: the route overlay, rider annotation, viewport, and SDK load status.

Two alternatives were rejected:

- A `WKWebView` around the AMap JavaScript API would add a JavaScript bridge,
  relay proxy configuration, and a second web lifecycle inside a small native
  card.
- Keeping MapKit would leave the app in its current state: AMap would provide
  the route, but the visible map would still be Apple's surface.

AMap's official iOS setup guide distributes the SDK through CocoaPods and
configures the key through `AMapServices`:
<https://lbs.amap.com/api/maps-sdk-for-ios/gettingstarted>. The map view's
privacy APIs must run before `MAMapView` is instantiated:
<https://a.amap.com/lbs/static/unzip/iOS_Map_Doc/iOS_Map_Doc/AMap_iOS_API_Doc_3D/interface_m_a_map_view.html>.

## Architecture

### Dependency and build configuration

Add `ios/Podfile` with `pod 'AMap3DMap-NO-IDFA', '~> 11.2'`. Commit the exact
resolved version in `Podfile.lock`, ignore generated `ios/Pods/`, and build the
app and tests through `ios/MaxHelmet.xcworkspace` after installation. Update
the iOS README commands accordingly.

The checked-in build configuration exposes an `AMAP_IOS_KEY` placeholder to
both Debug and Release builds and passes it into the app bundle. A local,
ignored `Secrets.xcconfig` supplies the registered key. The checked-in example
documents the setting name but never contains a real credential. Generated
CocoaPods settings remain included by the app's configuration files, so custom
key injection does not replace required linker and framework settings.

Although an iOS SDK key is restricted by bundle identifier and is recoverable
from a shipped app, the repository will not hardcode the supplied value in
Swift, plist source, documentation, tests, or logs. A missing or empty build
setting is a supported runtime state.

### AMap consent state

`AMapConsentStore` owns a persisted three-state decision:

- `unknown`: no choice has been recorded.
- `accepted`: the rider agreed to the disclosure and AMap map use may begin.
- `declined`: the rider declined and no AMap SDK object may be created.

When a guidance card first needs a map and the decision is `unknown`, it presents
a focused Chinese consent sheet. The sheet says that AMap supplies the map and
receives the network requests necessary to render it, links to AMap's privacy
policy at <https://lbs.amap.com/pages/privacy/>, and offers “同意并启用” and
“暂不启用”.

Acceptance is persisted so the prompt does not repeat. Declining displays a
“地图未启用” placeholder with an explicit “启用地图” action. That action reopens
the consent sheet only after a deliberate tap; the app does not nag on later
routes.

The accepted path performs the AMap compliance calls with “shown”, “contains
AMap disclosure”, and “agreed” states, enables HTTPS, and configures the key
immediately before the first map is created. The declined and unknown paths do
not call any AMap SDK API, including global configuration APIs.

### Display component

`AMapRouteMap` is a `UIViewRepresentable` around one `MAMapView` per guidance
card lifetime. It receives a display model rather than navigation controllers
or services. The display model contains:

- the route polyline;
- the optional current rider coordinate; and
- stable route identity needed to avoid rebuilding unchanged overlays.

The component:

- disables pan, zoom, rotation, tilt, and built-in user-location services;
- converts display inputs from WGS-84 to GCJ-02 through the existing
  `CoordinateDatum.wgs84ToGcj02` helper;
- rejects non-finite coordinates before creating SDK geometry;
- draws one `MAPolyline` using the HUD lume color;
- draws one custom rider annotation using the HUD ember color;
- replaces overlays and the annotation only when their inputs change;
- fits the full route with padding while preserving the AMap logo; and
- reports a load failure to the SwiftUI host without affecting guidance.

The component does not acquire location. `NavigationController` remains the
only owner of foreground guidance fixes, and `GuidanceState.currentLocation`
feeds the custom marker. This avoids a second permission path and avoids adding
AMap's Location SDK.

### Coordinate boundary

The current iOS navigation pipeline is deliberately WGS-84 internally:

```text
relay nav.route (GCJ-02)
  -> RelayNavigationSearch converts to WGS-84
  -> NavigationController + GuidanceEngine + Core Location use WGS-84
  -> AMapRouteMap converts display geometry to GCJ-02
  -> MAMapView renders route and rider in GCJ-02
```

This adds a display boundary instead of changing the proven engine to GCJ-02.
The inverse-then-forward route conversion is deterministic and covered by the
existing coordinate golden vectors plus new display-model tests. Guidance
calculations never consume the display conversion.

### Guidance card integration

`GuidanceCard` keeps the existing maneuver instruction, distance, ETA, route
height, accessibility summary, and non-interactive behavior. Its MapKit `Map`
is replaced with an AMap host that selects one of four visible states:

1. consent required;
2. AMap map active;
3. map not enabled because consent was declined; or
4. map temporarily unavailable because the key, geometry, or tiles failed.

Text and voice guidance remain visible in every state. There is no MapKit
fallback, because silently displaying another provider would make runtime
verification ambiguous.

## Helmet-only hands-free interaction

Remove `VoiceMicDock` from both the portrait and landscape stacks. Do not add a
replacement start/stop button. `HelmetVisual` keeps the existing
`viewModel.toggleHandsFree` action:

- hands-free off + helmet tap -> start;
- connecting/live + helmet tap -> stop or cancel; and
- the current dynamic accessibility label remains “开启免提” or “结束免提”.

Move `MuteUtilityPill` and its minimum hit-target constant into a focused voice
utility file. It remains visible only while hands-free is active. Delete the
dock meter, noise-floor curve, state presentation, transition model, and their
obsolete tests rather than leaving hidden dead code.

Update `AgentScreenLayout` reservations and comments to remove the 64-point dock
and associated spacing from both orientations. The freed space belongs to the
helmet and captions. Safety banners, crash UI, navigation cards, recording
indicators, and secondary controls retain their priority.

## Error handling

- **Consent unknown:** present the sheet; do not initialize AMap.
- **Consent declined:** show “地图未启用”; navigation continues.
- **Rider reconsiders:** an explicit placeholder action reopens the sheet.
- **Key missing or empty:** show “地图暂不可用”; do not crash or log a key.
- **Invalid route geometry:** reject it before SDK construction and show the
  unavailable state; maneuver guidance remains unchanged.
- **Tile or SDK load failure:** retain the text card and show the unavailable
  state. A later guidance-card appearance may retry after accepted consent.
- **Route or rider update:** replace stale overlays atomically so rerouted
  geometry and the prior route cannot appear together.
- **Navigation ends:** SwiftUI removes the card and releases its map view.
- **AMap dependency unavailable at build time:** the workspace build fails
  loudly; there is no conditional production build that silently restores
  MapKit.

## Testing

### Automated

- `AMapConsentStoreTests`
  - defaults to `unknown`;
  - persists acceptance and decline;
  - does not re-prompt after a recorded choice;
  - permits a declined rider to explicitly reopen and accept; and
  - never exposes the configured key through state or diagnostics.
- AMap display-model tests
  - convert route and rider WGS-84 inputs to GCJ-02;
  - preserve ordering and route identity;
  - reject NaN and infinite coordinates;
  - compute finite viewport bounds for ordinary and degenerate routes; and
  - keep navigation inputs unchanged.
- Guidance-card tests
  - select consent, active, declined, missing-key, and load-failure states
    deterministically; and
  - preserve the existing spoken/text guidance model in all map states.
- `AgentScreenLayoutTests`
  - update the chrome constants after dock removal;
  - prove portrait and landscape still fit supported phone sizes; and
  - prove the freed height is available to the helmet or captions.
- Helmet presentation tests
  - preserve start/stop accessibility labels and tap semantics.
- Voice utility tests
  - retain the mute pill's minimum 44-point interactive target.
- Remove `VoiceMicDockTests` and all assertions that exist only for the deleted
  meter and dock presentation.
- Run the complete XCTest suite and app build through
  `MaxHelmet.xcworkspace`.

### Manual

On a simulator and, where signing permits, a physical iPhone:

1. Start a first route with consent unknown and verify the just-in-time sheet.
2. Decline and verify no AMap map appears while prompts, ETA, rerouting, and
   stop-navigation continue.
3. Tap “启用地图”, accept, and verify the prompt does not recur.
4. Verify AMap tiles, the route line, rider marker, route fitting, and visible
   AMap attribution.
5. Verify route and rider alignment on a mainland-China coordinate fixture and
   during a live location run.
6. Build once without the local key and verify the honest unavailable state.
7. Tap the helmet from idle to start, then tap it again to stop; verify no
   microphone dock exists in portrait or landscape.
8. During an active session, verify mute still changes microphone state without
   ending hands-free.
9. Exercise captions, a hazard banner, recording, crash check-in, and an active
   navigation card in both orientations to confirm the revised layout does not
   overlap.

## Acceptance criteria

- The visible iOS route surface uses native AMap tiles, not MapKit.
- The AMap SDK receives no calls before the rider accepts the disclosed use.
- The rider is prompted only when the first route needs a map; a decline is
  respected until an explicit reconsider action.
- The supplied AMap iOS key is not committed or logged, and a missing key is a
  tested non-crashing state.
- Route and rider geometry align after the WGS-84-to-GCJ-02 display conversion.
- Spoken/text guidance and navigation lifecycle work with the map active,
  declined, or unavailable.
- The microphone dock and its dead presentation code are gone.
- The helmet is the only hands-free start/stop control and toggles both ways.
- The mute utility remains available during active hands-free sessions.
- The workspace app build and complete XCTest suite pass.
