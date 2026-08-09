# RDK Navigation with an iOS Location Companion

## Summary

Add live Amap turn-by-turn navigation to the RDK X5 client and its existing
bench HUD. The RDK remains the navigation authority: it handles the rider's
voice command, asks the Lightsail relay for an Amap route, advances the shared
TypeScript guidance engine, renders a turn-first card, requests maneuver
speech, reroutes, and ends at arrival.

The Max iOS app supplies the missing hardware input. A rider pairs one logged-in
iPhone to one RDK helmet, explicitly starts a **Helmet Ride**, and the app
forwards native Core Location fixes through a lightweight relay WebSocket. The
location stream continues while the phone is locked or the app is backgrounded,
but only until the rider ends Helmet Ride. This is a companion channel, not a
second voice-agent session: it opens no microphone, creates no Doubao provider,
and does not run the iOS app's own navigation controller.

The existing Lightsail `AMAP_API_KEY` stays the only Amap credential required.
No Amap key, map SDK, or route-provider logic reaches the iPhone or RDK.

## Context

The relay already implements:

- Amap place resolution and driving routes in `server/routing.ts`;
- `nav.request`, `nav.route`, and `nav.error` protocol events;
- route-summary and reroute-success reconciliation;
- a mock route provider for keyless automated tests;
- embedded text-to-PCM speech through `server/speech.ts`;
- the canonical TypeScript guidance engine in `shared/guidance.ts`.

Web, iOS, and Android already implement the same six-rule guidance contract.
The RDK is the remaining platform: its capability matrix deliberately marks
`navigation.start` and `navigation.stop` as `device.notYet`, its HUD has no
navigation state, and the board has no GPS/GNSS input.

The current RDK HUD is served over plain HTTP on the local network. A phone
browser cannot be the production location source because browser geolocation
requires a secure context, and a different device's LAN IP is not the
`localhost` exception. The native iOS companion avoids that constraint and
also supports locked-screen riding without a new browser application.

## Goals

- Pair one authenticated Max iOS account with one stable RDK device.
- Provide foreground and locked-screen iOS location during an explicit Helmet
  Ride session.
- Make `navigation.start` and `navigation.stop` truthful, supported RDK
  actions with exactly one `device.result` per command.
- Reuse the deployed Amap service and the existing `nav.*` route protocol.
- Convert WGS-84 phone fixes to GCJ-02 exactly once at the RDK location edge.
- Reuse `shared/guidance.ts` directly for prompt thresholds, route progress,
  off-route detection, rerouting, and arrival.
- Add the approved turn-first RDK HUD card: next maneuver and distance first,
  destination, remaining distance/ETA, pairing/GPS state, then the existing
  camera and transcript surfaces.
- Speak maneuver, off-route, arrival, GPS-loss, and reroute-failure lines
  through the helmet's existing 24 kHz PCM downlink.
- Preserve absolute ADAS priority: hazard audio preempts and drops lower
  priority navigation or conversational audio rather than replaying it late.
- Pause safely on stale, inaccurate, missing, or disconnected phone location,
  retain the route, and resume from a fresh fix.
- Keep raw companion location out of durable storage, logs, transcripts, and QA
  evidence.

## Non-goals

- A route map in the RDK HUD. The approved first version is card-only.
- Amap JS, iOS Map, Android Map, or native Navi SDK integration for the RDK.
- Motorcycle-aware routing, lane guidance, traffic, junction views, or speed
  limits. The existing Amap driving-profile limitation remains.
- A browser, Android, or third-party location companion.
- Multiple phones per helmet or multiple helmets per iOS account.
- Offline routing or local RDK text-to-speech.
- Relaunching a force-quit or terminated iOS app for continuous navigation.
- Running the iOS app's existing navigation controller in parallel with RDK
  navigation.
- Turning the current bench HUD into a production optical helmet display.
- Persisting a route or resuming navigation after an RDK process reboot. The
  phone pairing persists; an interrupted route must be started again.

## User Experience

### Pair once

1. An authenticated RDK `/agent` session registers its stable device ID.
2. The relay creates a six-digit, five-minute, single-use pairing code and sends
   it to the RDK. The bench HUD shows the code and its expiry.
3. In the Max iOS settings panel, the rider opens **RDK Helmet**, enters the
   code, and taps **Pair**.
4. The relay requires an authenticated iOS account, validates and consumes the
   code, then persistently binds that account ID to the RDK device ID.
5. A successful new pairing replaces any older binding on either side and
   notifies the displaced companion. The settings panel shows the paired device
   label and last-seen state.

Pairing codes are bootstrap proof, not authentication. The RDK socket must pass
the relay's normal embedded/operator authentication, and the iOS companion must
present a valid account session. Codes are rate-limited by account and source
address, never logged, and removed on use or expiry.

### Start a ride

The rider taps **Start Helmet Ride** while the iOS app is foregrounded. The app:

- opens a lightweight authenticated `/companion` WebSocket;
- starts a dedicated companion Core Location stream;
- shows the system background-location indicator;
- sends at most one latest location fix per second;
- continues while the phone is locked or the app is backgrounded.

Helmet Ride is broader than one route. It remains active after arrival or
`navigation.stop`, so the rider can ask for another route without reopening the
phone. It ends only when the rider taps **Stop Helmet Ride**, unpairs, signs
out, or the server revokes the binding. Ending it immediately stops Core
Location, disables background updates, and closes the companion socket.

If iOS is force-quit or the process terminates, forwarding stops. The RDK
pauses guidance and the rider must reopen the app and start Helmet Ride again.
The app does not request Always authorization solely to gain relaunch behavior.

### Navigate

1. The rider says, for example, “Max，导航去人民广场” through the RDK headset.
2. The relay sends the existing `device.command { action:
"navigation.start" }` to the RDK.
3. RDK waits up to three seconds for a fresh, accurate phone fix. It converts
   that WGS-84 fix to GCJ-02 and sends the existing `nav.request`.
4. The RDK holds the command's `device.result` until the matching `nav.route`
   or `nav.error`; it never acknowledges a route optimistically.
5. Each accepted phone fix advances `shared/guidance.ts`, updates the HUD, and
   emits a structured navigation prompt only when a threshold or lifecycle
   event fires.
6. “停止导航” cancels an in-flight start or active route, clears the card, and
   answers exactly once. Helmet Ride and phone location remain active.

## Architecture

```text
Max iOS app                    Lightsail relay                    RDK X5
-----------                    ---------------                    -------
RDK pairing UI  ── /companion ─► CompanionRegistry ◄── /agent ── stable device ID
Keychain auth                   account ↔ device binding          PhoneLocationSource
Core Location WGS-84 ─────────► validate + forward ─────────────► WGS→GCJ boundary
                                                                   │
                                                                   ▼
voice command ───────────────── existing device.command ───────► RdkNavigationController
                                                                   │
                                                                   ├─ nav.request ───────► AmapRouteProvider
                                                                   ◄─ nav.route/error ───┘
                                                                   │
                                                                   ├─ shared guidance
                                                                   ├─ turn-first HUD
                                                                   └─ structured nav.prompt
                                                                        │
helmet playback ◄────────────── 24 kHz PCM ◄── validated TTS ───────────┘
```

### Ownership

- **iOS owns location acquisition and user consent.** It sends raw WGS-84
  fixes and companion lifecycle messages. It does not route or guide.
- **The relay owns pairing, authentication, Amap, and generated speech.** It
  forwards location without persisting it.
- **RDK owns navigation state.** It decides when a fix is usable, converts the
  datum, holds device-command results, advances guidance, reroutes, publishes
  HUD state, and requests bounded prompts.

No layer has two owners for route progress or prompt thresholds.

## Components

### Relay: `CompanionRegistry`

A focused server unit owns:

- active embedded sessions keyed by stable device ID;
- short-lived pairing codes;
- the durable one-to-one account-ID/device-ID bindings;
- active companion sockets keyed by authenticated account ID;
- attachment and detachment when either socket reconnects;
- per-connection sequence, rate, and freshness validation;
- status delivery to both peers.

Bindings live in a dedicated owner-only file beside `accounts.json`, written
with the same serialized, atomic write-then-rename pattern. The file contains
only account ID, device ID, creation time, and update time. If it is malformed
or unreadable, companion pairing fails closed; it never falls back to an open
mode.

The registry is transport-independent and unit-testable. The WebSocket route
adapts JSON messages to it; RDK session registration is an injected callback
from `SessionController` rather than a global socket reach-through.

### Relay: `/companion` WebSocket

`/companion` is separate from `/agent`. It requires the existing account bearer
session; the shared operator relay token alone cannot own a durable pairing. It
never creates an `AgentProvider`, audio session, tester session, transcript, or
memory record.

The endpoint accepts only companion JSON, with a small payload ceiling. It
rejects binary data, unknown event types, oversized strings, invalid
coordinates, invalid timestamps, and non-monotonic sequences. It applies
bounded reconnect-friendly errors rather than taking down an RDK agent socket.

### iOS: `RDKCompanionClient`

A standalone client owns `/companion` connection state, authenticated URL
construction, pairing/start/stop messages, bounded exponential reconnect, and
server event parsing. It reuses the effective token already held in Keychain
but does not reuse `AgentSession`; doing so would accidentally create a second
voice provider and microphone lifecycle.

The client keeps only the newest unsent fix. A disconnected phone does not
queue a ride history for later upload. On reconnect it sends the current fix,
not every missed fix.

### iOS: `CompanionLocationStream`

A separate `CLLocationManager` seam mirrors the existing testable navigation
location seam but has companion-specific lifecycle:

- start must be called from the foreground after the rider taps Start Helmet
  Ride;
- `desiredAccuracy = kCLLocationAccuracyBestForNavigation`;
- `activityType = .automotiveNavigation`;
- `allowsBackgroundLocationUpdates = true` only while Helmet Ride is active;
- `showsBackgroundLocationIndicator = true`;
- automatic pausing is disabled while the explicit ride session is active;
- stop reverses those flags and calls `stopUpdatingLocation()`.

The target adds `location` beside the existing `audio` value in
`UIBackgroundModes`. The existing When In Use authorization remains the chosen
permission level. The usage text is updated to name helmet navigation and
locked-screen forwarding explicitly.

The app sends WGS-84 latitude/longitude, horizontal accuracy, source timestamp,
course when valid, and non-negative speed when valid. A pure throttle allows at
most one send per second while always preferring the newest fix.

### iOS: settings and state

`AgentSettingsPanel` gains an **RDK Helmet** section:

- pair code input and Pair action;
- paired helmet label and online/offline state;
- Start/Stop Helmet Ride control;
- location permission/accuracy state;
- last successful forward age;
- Unpair action with confirmation.

Pairing requires login because durable bindings are account-owned. The screen
does not expose raw tokens or coordinates. Signing out stops Helmet Ride before
discarding the session token.

### RDK: stable device identity

The agent generates a random stable ID on first run and stores it in
`/var/lib/max/device-id` with owner-only permissions. Tests inject storage and
ID generation. The value is not a credential; the authenticated `/agent`
connection is the proof that registers it. `session.start` gains an optional
`deviceId` field, required by the RDK companion feature and ignored by older
clients.

### RDK: `PhoneLocationSource`

This unit consumes relay-forwarded phone events and owns:

- the latest valid WGS-84 fix;
- connection/sharing/accuracy/freshness status;
- the ten-second stale timer;
- pending first-fix waiters with a three-second bound;
- WGS-84 to GCJ-02 conversion at the single output boundary;
- status callbacks for the controller and HUD.

It rejects fixes when:

- latitude or longitude is non-finite or out of range;
- horizontal accuracy is negative or greater than 50 meters;
- the timestamp is more than ten seconds old or more than two seconds in the
  future;
- sequence is not newer within the current companion connection.

Rejected fixes never replace the last accepted fix. Once that last fix becomes
older than ten seconds it is no longer usable, even if the phone socket still
appears connected.

### RDK: `RdkNavigationController`

The controller is plain TypeScript with injected clock, location source,
send-event function, prompt sink, and state callback. It follows the proven web
controller and the generation/identity guards already established by iOS and
Android:

- one navigation start or reroute request is outstanding at a time;
- every start is held until a matching route/error/timeout;
- a second start cancels and resolves the first before replacing it;
- stop cancels pending first-fix and route waits as well as active guidance;
- stale answers cannot revive a superseded, stopped, arrived, or failed route;
- reroutes use the existing 20-second cooldown and single-in-flight latch;
- reroute failure clears the route instead of continuing on stale geometry;
- arrival wins over off-route, clears only the current route, and keeps Helmet
  Ride available.

On each fresh GCJ-02 fix the controller calls `shared/guidance.ts` directly. It
does not port or fork the engine.

`main.ts` routes navigation commands and `nav.route`/`nav.error` events through
this controller before the generic device dispatcher. The embedded capability
matrix then marks `navigation.start` and `navigation.stop` supported.

### RDK HUD

`HudState` gains companion and optional navigation snapshots. The approved
turn-first card displays:

- phone GPS connection and accuracy;
- next maneuver instruction;
- distance to the maneuver;
- destination;
- remaining distance and ETA;
- off-route/rerouting or location-paused status.

The card sits above the current camera row and transcript. It disappears after
stop, arrival, start failure, or reroute failure. When location pauses it stays
visible with its last values clearly frozen and a disconnected banner; it must
not look live.

No Amap JavaScript or route map is loaded into the RDK HUD.

## Protocol

All new event shapes are added to `protocol/agent-events.schema.json` and
regenerated. Older clients continue ignoring unknown server events.

### `/agent` additions

`session.start` gains optional `deviceId`.

Relay to RDK:

```ts
type CompanionPairingEvent = {
  type: "companion.pairing";
  code: string;
  expiresAt: number;
  paired: boolean;
};

type PhoneLocationEvent = {
  type: "phone.location";
  sequence: number;
  lat: number;
  lon: number;
  horizontalAccuracyMeters: number;
  timestamp: number;
  courseDegrees?: number;
  speedMps?: number;
};

type PhoneLocationStatusEvent = {
  type: "phone.location.status";
  state: "connected" | "sharing" | "stopped" | "stale" | "unpaired";
};
```

RDK to relay navigation speech:

```ts
type NavPromptEvent =
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "maneuver";
      maneuverIndex: number;
      threshold: "far" | "near" | "now";
      distanceMeters: number;
    }
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "offRoute" | "rerouteFailed" | "arrived" | "locationLost";
    };
```

The event never carries arbitrary speech text. The relay owns all templates
and, for maneuver prompts, looks up the instruction in the active route it
previously sent. It requires the current route command ID and valid maneuver
index, deduplicates `promptId`, rate-limits per session, bounds distance, and
rejects a prompt whose route ID is not the last route it issued. For fixed
lifecycle kinds, the authenticated RDK remains the physical-state authority;
the relay verifies the active route identity and supplies fixed text rather
than pretending it can independently prove arrival or off-route without the
phone fix. The same last-route state already held by `createNavHandler` becomes
the validation source rather than a second route copy. RDK sends arrival and
reroute-failure prompts before clearing its local route, preserving this check.

The server-owned fixed templates are:

- `offRoute`: “已偏离路线，正在重新规划。”
- `rerouteFailed`: “无法重新规划路线，已停止导航。”
- `arrived`: “已到达目的地。”
- `locationLost`: “手机定位已断开，导航已暂停。”

### `/companion` events

iOS to relay:

```ts
type CompanionClientEvent =
  | { type: "companion.pair"; code: string }
  | { type: "companion.start" }
  | { type: "companion.stop" }
  | { type: "companion.unpair" }
  | {
      type: "companion.location";
      sequence: number;
      lat: number;
      lon: number;
      horizontalAccuracyMeters: number;
      timestamp: number;
      courseDegrees?: number;
      speedMps?: number;
    };
```

Relay to iOS:

```ts
type CompanionServerEvent =
  | {
      type: "companion.status";
      state: "unpaired" | "paired" | "helmetOffline" | "ready" | "sharing";
      deviceId?: string;
      deviceLabel?: string;
      detail?: string;
    }
  | { type: "companion.error"; code: string; detail: string };
```

The server resolves the authenticated account before accepting any event.
`companion.start` is refused without a durable pairing. A temporarily offline
RDK does not block Helmet Ride: iOS receives `helmetOffline`, keeps only its
newest fix, and begins forwarding live fixes as soon as that stable device ID
reconnects. No offline fix history is uploaded.

## Navigation Speech and Audio Priority

The relay extends the existing embedded speaker rather than adding TTS
credentials to the board.

- Maneuver `far` and `near` prompts serialize behind current ordinary speech
  and expire if not started within three seconds.
- A `now` prompt is interrupting. RDK flushes queued ordinary playback before
  sending it; the relay truncates the current Doubao reply before synthesizing
  the prompt, preventing later chunks of the old reply from refilling the
  queue.
- Off-route, arrival, location-loss, and reroute-failure prompts use fixed
  server-owned text and the same serialized speaker.
- Reroute-success speech, which the relay already produces, is extended to the
  embedded speaker instead of remaining transcript-only.
- Synthesis failure is logged and counted but does not stop route progress or
  retry a time-sensitive line late. The HUD remains truthful.

`playback.write` gains a rank parameter. Ordinary relay audio is rank 0;
pre-rendered ADAS alerts write at their caution/critical rank. While a priority
hold is active, lower-ranked incoming audio is dropped before it enters the
queue or AEC reference. Equal-rank alert chunks remain playable, and a strictly
higher alert can still preempt a lower one. This closes the race where a nav
prompt requested just before a hazard would otherwise queue behind the alert
and play after the danger had passed.

Guidance progress records a threshold as fired even when ADAS suppresses its
audio. If a priority hold is already active, RDK emits no `nav.prompt`; if the
hazard begins after the request, ranked playback drops the arriving PCM.
Suppressed prompts are never replayed late.

## Failure Handling

### Pairing and connectivity

- Wrong, expired, reused, or rate-limited code: pairing remains unchanged and
  iOS shows a specific error.
- Pairing store unreadable: fail closed; neither an old nor a claimed mapping
  is trusted.
- iOS socket drops: RDK receives disconnected/stale status; iOS reconnects
  with bounded backoff and sends only its newest fix.
- RDK socket drops: iOS shows helmet offline. The durable account/device
  binding remains, and the relay reattaches when the same device ID returns.
- Relay restarts: the durable binding reloads; both clients reconnect without a
  new pairing code.
- iOS process terminates: no relaunch is promised. RDK pauses until the rider
  reopens the app and starts Helmet Ride.

### Location

- No acceptable first fix within three seconds: `navigation.start` answers
  once with `failed/location.unavailable`; no `nav.request` is sent.
- Existing permission denial is reported specifically as
  `denied/permission.location` when iOS can deliver that status; disconnected,
  stale, or inaccurate sources use `location.unavailable`.
- Active fix becomes stale or inaccurate: freeze progress and prompts, retain
  the route, mark the HUD paused, and request one `locationLost` line if relay
  speech is reachable.
- Fresh fix returns: clear the one-shot loss latch, run the guidance engine
  against the retained route, and use the ordinary off-route/reroute policy.
- No raw fixes are replayed after reconnect and no stale route instruction is
  spoken while paused.

`server/device-actions.ts` gains a fixed `location.unavailable` failure line:
“手机定位未连接，请打开 Max 并开始头盔骑行。”

### Routing

- Destination resolution and route errors remain the existing `nav.error`
  codes and speech.
- Route timeout resolves the held start once with `route.unavailable`.
- Stop during first-fix wait or route wait cancels the held start with
  `navigation.cancelled` before answering stop.
- Reroute failure speaks the existing fixed line and clears the card; stale
  geometry never continues guiding.

### Privacy

- Companion location is forwarded in memory only.
- Relay logs event type, device/account identifiers where operationally needed,
  and state transitions, never raw latitude/longitude, course, speed, or pair
  code.
- Pairing storage contains no location or route.
- Location never enters session memory, transcripts, tester metrics, SQLite QA
  evidence, or history archives.
- Amap receives the route origin/destination as it already does for other
  clients; this feature introduces no additional map provider.

## Testing

### Relay Vitest

- pairing code format, expiry, single use, and attempt limits;
- authenticated-only pairing and companion socket;
- one-to-one replacement and displaced-client notification;
- durable binding load/save, atomic persistence, and corrupt-store fail-closed;
- RDK and iOS reconnect in either order;
- location range, timestamp, accuracy, sequence, and one-Hz rate validation;
- newest-fix forwarding to only the paired RDK;
- no raw coordinate in logger calls or persisted pairing snapshots;
- structured prompt validation against active route, dedupe, rate limits, fixed
  templates, and arbitrary-text impossibility;
- interrupting versus serialized prompt behavior and three-second expiry;
- embedded reroute-success speech uses PCM while web/mobile remain single-spoken.

### RDK Vitest

- stable device ID creation, permissions, reload, and injected failure paths;
- `PhoneLocationSource` acceptance/rejection, three-second first-fix wait,
  ten-second staleness, accuracy gate, and single conversion boundary;
- navigation capability matrix now supports start/stop;
- start, superseding start, stop-during-start, route/error/timeout, stale answer,
  reroute cooldown, reroute failure, arrival, teardown, and reconnect;
- exactly one result for every navigation command;
- shared guidance fixtures drive identical far/near/now, off-route, and arrival
  outcomes;
- location pause freezes progress and prompt emission; fresh fix resumes;
- HUD reducer and serialized state include every Option A field and preserve
  existing transcript/camera behavior;
- ranked playback drops ordinary audio during ADAS, accepts the active alert,
  and still permits higher-severity preemption;
- `now` flush ordering and suppression of prompts while ADAS is active.

### iOS XCTest

- `/companion` request builders and response parsing;
- pairing, replacement, unpair, start, stop, and reconnect state machine;
- effective Keychain token reaches the companion socket without exposing it in
  view state;
- fake `CompanionLocationStream` proves foreground-only start, background flags,
  and complete stop cleanup;
- one-Hz newest-fix throttle and invalid Core Location value omission;
- sign-out and unpair stop location before clearing auth/pairing state;
- no `AgentSession`, microphone, iOS `NavigationController`, or second provider
  is started by companion mode;
- settings-panel rendering for unpaired, offline, ready, sharing, permission
  denied, and reduced/unusable accuracy.

### End-to-end automated

Use the keyless mock route and a deterministic WGS-84 coordinate trace through:

1. authenticated pairing;
2. Helmet Ride start;
3. `navigation.start` and held result;
4. route delivery and route-summary result;
5. far, near, and now prompts;
6. off-route and successful reroute;
7. stale-phone pause and fresh-fix resume;
8. arrival;
9. `navigation.stop` idempotency and companion stop.

### Physical acceptance

On the real iPhone, Lightsail relay, and RDK board:

- pair once, restart the relay and RDK separately, and confirm automatic
  reattachment;
- start Helmet Ride in the foreground, lock the phone for at least ten minutes,
  and confirm continuous fixes with the iOS background indicator;
- ask for a real Amap destination and confirm the HUD numbers match the route;
- hear far, near, and turn prompts through the helmet;
- disable phone location/network, confirm one warning and a frozen HUD, restore
  it, and confirm safe resume/reroute;
- trigger an armed test ADAS alert during a prompt and confirm the prompt is
  dropped, not played afterward;
- stop navigation by voice, start a second route without unlocking the phone,
  then end Helmet Ride and confirm background location stops promptly;
- inspect relay logs and durable stores to confirm no raw coordinate was saved.

## Delivery Order and Compatibility

1. Land and deploy relay protocol, pairing, prompt validation, and companion
   endpoint first.
2. Build and install the iOS companion UI/location client.
3. Deploy and restart the RDK agent with stable identity, controller, HUD, and
   audio-priority changes.
4. Run mock end-to-end verification before enabling the real Amap route.
5. Run the physical locked-screen acceptance ride.

The order is intentional. Old iOS and RDK clients ignore the new server events;
the new clients must not be deployed against a relay that rejects their new
client events. The existing web, Android, and native iOS navigation flows remain
unchanged.

The current iOS Debug self-signed trust path can be used for development. A
trusted domain/certificate remains required before production distribution,
independent of native Core Location authorization.

## Acceptance Criteria

- A logged-in iPhone pairs to exactly one stable RDK and reconnects after relay,
  phone-socket, or RDK-socket interruption without re-entering a code.
- Helmet Ride started in foreground continues forwarding while the phone is
  locked and stops location immediately when the rider ends it.
- RDK `navigation.start`/`stop` are supported and every command receives exactly
  one truthful result.
- The deployed Amap route drives the shared guidance engine and Option A HUD.
- Far, near, now, off-route, reroute, arrival, failure, and location-loss speech
  reaches helmet playback through relay TTS.
- Stale/inaccurate/missing location never advances or speaks route guidance.
- A fresh fix resumes a retained route and reroutes when appropriate.
- ADAS audio always wins; suppressed navigation/voice audio never plays late.
- No raw companion coordinate is durably stored or logged.
- Relay, RDK, iOS, mock end-to-end, and physical locked-screen tests pass.
