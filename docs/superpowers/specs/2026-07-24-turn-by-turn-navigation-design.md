# In-App Turn-by-Turn Guidance Design

## Summary

Turn the Spec 1 destination card into **live guidance**. "导航去天安门" resolves a
route and immediately begins guiding: the card goes live with the next maneuver,
distance, and ETA, and Max speaks maneuver prompts ("前方400米右转 … 现在右转")
as the rider drives. It stays in-app — never handing off to 高德/百度 — so the
device-action layer keeps working throughout. "停止导航" ends it.

This is **live guidance, not a full turn-by-turn engine**: continuous route
matching, spoken maneuver prompts, one debounced reroute per wrong turn, and
arrival — but not lane guidance, junction views, or the depth of a dedicated nav
app. MapKit gives a route, not a navigation engine; everything here is built by
hand on top of it, and it is car-routing only (no motorcycle profile, so it does
not respect 摩托车禁行 roads).

Builds on Spec 1 (`docs/superpowers/specs/2026-07-24-voice-device-actions-design.md`):
the `device.command`/`device.result` protocol, `DeviceActionRouter`, the
reconciliation-and-truthful-speech path, and the single relay grammar are reused.
It replaces Spec 1's static `DestinationResolver`/`DestinationCard` with live
guidance.

## Scope

### Goals

- Voice-triggered live guidance: `navigation.start` (auto-starts on "导航去X")
  and `navigation.stop`, through the existing spine.
- Continuous location that updates distance, ETA, and the next maneuver.
- Spoken maneuver prompts timed to distance (far / near / now).
- One debounced reroute per off-route excursion; arrival detection.
- A glanceable live guidance card.
- Truthful confirmations and spoken failures, as Spec 1 established.
- Mock-provider support so navigation commands demo without Doubao credentials.

### Non-goals

- Lane guidance, junction/3D views, speed limits, traffic. Out of scope.
- A dedicated map screen the rider stares at. The card is glanceable.
- Motorcycle routing. MapKit is automobile-only; the spoken summary must not
  imply a motorcycle-validated route.
- Background/screen-off navigation as a *new* capability. Guidance runs during
  the foreground hands-free session, which already keeps the screen awake; see
  "Why foreground-only works".
- Handing off to 高德/百度. Ruled out to keep the device-action layer alive.
- Android and web guidance. Both gain the generated event names; neither gains
  an implementation. Android must ignore the new commands without erroring.

## Why foreground-only works

Turn-by-turn is only useful if it keeps guiding for the whole ride. It does,
without any new background entitlement, because `MaxHelmetApp.swift` already sets
`isIdleTimerDisabled = true` whenever a hands-free session is active. The screen
stays awake and the app stays foregrounded for the duration of the session, so
continuous location works with the existing **WhenInUse** authorization — no
`location` background mode, no Always-authorization prompt. Guidance is scoped to
the foreground session, which matches the mounted-phone premise. If the rider
manually backgrounds the app, guidance pauses; that is acceptable and expected.

## Architecture

```text
"Max，导航去天安门"
  └─ relay grammar → device.command { navigation.start, query }
                        │
      DeviceActionRouter → NavigationController (DeviceActionHandler + CLLocationManagerDelegate)
                        │      │ MKLocalSearch + MKDirections → NavigationRoute (polyline + maneuver steps)
                        │      │ CLLocationManager continuous stream (WhenInUse, foreground session)
                        │      ▼
                        │   GuidanceEngine.step(location, route, progress)
                        │        → { progress', distanceToManeuver, remaining, offRoute, arrived, spokenPrompt? }
                        │      │
                        │      ├─ spokenPrompt? → local synthesizer (now-prompt cuts Max playback)
        device.result ◄─┘      └─ GuidanceState → live GuidanceCard (maneuver · distance · ETA · route map)

"Max，停止导航" → device.command { navigation.stop } → controller stops the stream, clears the card
```

### Units

- **`GuidanceEngine`** — pure. All route math and prompt-timing decisions, no
  I/O. The riskiest logic, made table-testable.
- **`NavigationRoute`** — the retained route: ordered polyline coordinates plus
  maneuver steps (instruction, coordinate, along-route distance) and the original
  total distance and ETA. This is what `MapKitRouteSearch` currently discards.
- **`NavigationController`** (`DeviceActionHandler`) — owns the location stream
  (through a `LocationStreaming` protocol), the active route and progress, the
  reroute/arrival lifecycle, and speech. Drives the engine on each fix.
- **`GuidanceCard`** — the live SwiftUI surface; replaces `DestinationCard`.
- **Server: grammar + grounding prompt** — `navigation.start`/`navigation.stop`
  in the one relay grammar.

### Reused from Spec 1, unchanged

The `device.command`/`device.result` events, `DeviceActionRouter` (incl. the
`isDeviceUnlocked` gate), the relay's reconciliation + corrective-speech path,
`DEVICE_ACTION_TIERS`, and the idle-timer behavior that keeps the screen awake.

### Replaces from Spec 1

`DestinationResolver` and `DestinationCard` are superseded by
`NavigationController` and `GuidanceCard`. The `destination.show` action stays in
the protocol schema for back-compat, but the grammar no longer emits it and the
`.destination`-equivalent route is served by the navigation handler.

## The guidance engine

`GuidanceEngine.step(location, route, progress) -> GuidanceUpdate` is pure.

**`GuidanceProgress`** (advanced each step): `maneuverIndex`,
`firedThresholds: Set<PromptThreshold>` (for the current maneuver), `arrived`,
and reroute-debounce bookkeeping.

**Each fix computes:**
- **Snap-to-route** — nearest point on the polyline → cross-track distance (how
  far off the line) and along-route position.
- **Distance to the next maneuver** — measured along the route.
- **Maneuver advancement** — passing the current maneuver (within a small radius,
  or moved past it along the route) advances `maneuverIndex` and clears that
  maneuver's fired thresholds.
- **Off-route** — cross-track distance beyond **50 m**.
- **Remaining distance + ETA** — remaining along-route distance; remaining time
  scaled from the route's original ETA by the remaining fraction.
- **Arrival** — within **30 m** of the destination sets `arrived`.

**Prompt thresholds** (`PromptThreshold`): **far ≈ 400 m**, **near ≈ 150 m**,
**now ≈ 40 m**. Each fires once per maneuver, tracked in `firedThresholds`, so no
maneuver double-announces. The engine returns `spokenPrompt` (or nil); the
controller voices it.

**Geometry primitives** — haversine distance and point-to-segment cross-track —
are pure helpers with their own tests.

## Continuous location, rerouting & arrival

**Location.** `NavigationController` owns its own `CLLocationManager`
(`desiredAccuracy = .bestForNavigation`, `activityType = .automotiveNavigation`,
`distanceFilter ≈ 10 m`), streaming only while navigating. The one-shot
`LocationProvider` stays untouched for weather. The controller reads its stream
through a `LocationStreaming` protocol so tests feed synthetic coordinates.

**Lifecycle:**
- **`navigation.start {query}`** — resolve the `NavigationRoute`, start the
  stream, speak the opening summary ("全程 12 公里，预计 25 分钟，前方右转"), show
  the card, return `ok`. Unresolvable → `unsupported("route.unavailable")`.
- **`navigation.stop`** — stop the stream, clear the card, speak "已停止导航",
  return `ok`. Called with nothing active → benign `failed("navigation.notActive")`
  → "现在没有在导航", reusing the Spec 2 guard pattern.
- **Each fix** — drive the engine, voice any prompt, update the card, then handle
  reroute and arrival.

**Rerouting.** On engine off-route, Max says "已偏离路线，正在重新规划", re-runs
`MKDirections` from the current position, swaps in the new route, and resets
progress. **Debounced** — one reroute per excursion with a short cooldown so a
wandering fix cannot spam reroutes; it can recur on the next wrong turn. If the
reroute fails, Max says it cannot re-plan and guidance stops cleanly rather than
pointing at a stale route.

**Arrival.** Within 30 m the engine sets `arrived`; the controller announces
"已到达目的地", stops the stream, and clears the card. Prompts and announcements
are client-originated (no relay turn), spoken through the existing local
synthesizer.

## Voice, grammar & the card

**Voice.** Prompts speak through the existing local synthesizer (`speak`, zh-CN).
Advance prompts (far/near) tolerate rare overlap with Max. The safety-critical
**now** prompt cuts any in-progress Max PCM playback (reusing the existing
barge-in stop) so "现在右转" is never buried under Max mid-sentence.

**Grammar.** Two actions in the one relay grammar:
- `导航去X / 带我去X / navigate to X` → `navigation.start {query}`
- `停止导航 / 结束导航 / 取消导航 / stop navigation` → `navigation.stop`

Both **low tier**. `destination.show` stays in the schema for back-compat but the
grammar stops emitting it. The grounding prompt's
"查询目的地并显示路线卡片" becomes "语音导航（实时路线指引，仅汽车路线）".

**The card.** `GuidanceCard` replaces `DestinationCard`. Glanceable-first: the
next maneuver (turn arrow + "右转 · 300米") is prominent; ETA and remaining
distance below; a small route map with the polyline and current position is
secondary. An off-route moment shows "重新规划中…". Driven by a published
`guidance: GuidanceState?` on the session state, exactly like Spec 1's
`destination`.

**Permissions:** none new. WhenInUse already exists.

## Error and edge handling

- Every command resolves to exactly one `device.result`; silence is a bug.
- Unresolvable or cross-border destination → `unsupported("route.unavailable")`.
- Reroute failure → guidance stops cleanly with a spoken explanation, not a stale
  route.
- `navigation.stop` with nothing active → benign `failed("navigation.notActive")`
  → "现在没有在导航".
- Location authorization denied → `denied("permission.location")`; Max says which
  permission and that Settings grants it. (The string is added to Spec 1's
  failure-speech map.)
- Locked/backgrounded device → the router's existing `device.locked` path; a
  session backgrounding mid-route pauses guidance and resumes on return.
- Unknown/old clients ignore `navigation.*` without erroring; the relay's 8 s
  timeout speaks the failure.

## Verification

### Automated

- **Vitest**: `navigation.start`/`navigation.stop` extraction across Chinese and
  English with near-miss negatives; low-tier assignment; grounding prompt names
  导航.
- **XCTest — the engine is the crown jewel** (pure, thoroughly table-tested):
  - `GuidanceEngine.step`: straight-route progress, along-route
    distance-to-maneuver, advancing past a turn, each prompt threshold firing
    exactly once, off-route at >50 m, arrival at <30 m, ETA scaling.
  - Geometry helpers: haversine and point-to-segment cross-track against known
    coordinates.
  - `NavigationController` via a fake `LocationStreaming` + fake route search:
    start resolves + streams + speaks the summary, stop clears, off-route triggers
    exactly one debounced reroute, arrival ends guidance, the `navigation.notActive`
    guard.
- Existing repository checks (protocol sync, lint, dead-code, fault matrix,
  build) stay green.

### Manual (physical device)

- A real drive or walk: start guidance, hear prompts land at the right distances
  before each turn, deliberately miss a turn and hear one reroute, reach the
  destination and hear arrival, and "停止导航" stops cleanly.
- Deny location → Max says the permission is missing and does not pretend to
  guide.
- Confirm an Android client receiving a `navigation.*` command ignores it.

## Acceptance criteria

- "导航去X" auto-starts live guidance; the card and spoken summary appear, and
  maneuver prompts fire at the right distances as the rider moves.
- Max's spoken confirmation matches the real result in every path; no navigation
  is claimed without a `status: "ok"` result.
- Off-route triggers exactly one debounced reroute per excursion; arrival ends
  guidance with an announcement; "停止导航" stops cleanly.
- Guidance runs for the whole foreground session with no new permission prompt.
- The feature demos end to end on the mock provider with no Doubao credentials.
