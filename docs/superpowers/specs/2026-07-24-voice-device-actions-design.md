# Voice-Triggered Device Actions Design

## Summary

Give Max real hands on iOS. Today `buildToolGroundingPrompt()` tells the agent it
has no maps, navigation, calling, vehicle, or messaging tools and forbids it from
claiming otherwise. This design adds a device-action spine — a relay-issued
command event, an on-device router, and a result event — plus five thin handlers:
torch, Max playback volume, music, SMS composition, and calling. Navigation lands
as an in-app destination card, not a hand-off. The grounding prompt is then
rewritten from "you have no tools" to "you have _these_ tools, and you claim
success only when the system returns it."

## Scope

### Goals

- A relay → client → relay command round trip that is protocol-versioned,
  schema-generated for TypeScript/Kotlin/Swift, and testable as pure functions.
- Spoken commands for: torch on/off, Max's own speaking volume, music
  play/pause/next, SMS composition, phone calls, and destination lookup.
- Truthful confirmations. Max never claims an action it did not complete.
- Every failure is spoken, never silent.
- Full mock-provider support so the whole feature demos without Doubao
  credentials.

### Non-goals

- Camera capture and the in-app gallery. That is Spec 2 and builds on this spine.
- Turn-by-turn navigation guidance. That is Spec 3 and builds on the destination
  card defined here.
- Android and web handlers. Both gain the generated event names; neither gains
  an implementation. Android must ignore unhandled commands without erroring.
- Voice-confirmation state machine. See "Confirmation tiers" for why.

## Existing context

- `server/providers/doubao.ts:1270` emits the final rider ASR transcript. That is
  the single hook point for intent extraction.
- `server/providers/doubao.ts:134` is `buildToolGroundingPrompt()`, the guardrail
  this design replaces.
- `server/providers/doubao.ts:281` is `buildDoubaoSessionConfig`. It sends
  `dialog`, `asr`, and `tts` only — **there is no `tools` field**. Whether
  realtime model `1.2.1.1` accepts tool declarations is unverified, and no
  authoritative Volcengine documentation was found. This design does not depend
  on it.
- `EventSend.ConversationTruncate` (513) is already defined and wired, so the
  relay can cut a wrong spoken turn mid-flight.
- The `transcript` event already carries `useBrowserSpeech`, giving us a
  deterministic corrective-speech path that needs no new machinery.
- `server/session-controller.ts:105` `parseClientEvent` validates every inbound
  client event; new events must be validated there.
- `ios/MaxHelmet/Agent/AgentSession.swift:692` `handleEvent` is the client event
  switch. That file is already 1054 lines and must not absorb action logic.
- The iOS target uses a synchronized group, so new Swift files need no project
  edits.

## Architecture

```text
rider speech
  └─ Doubao ASR final ─────────────► doubao.ts (rider final transcript)
                                            │
                            IntentExtractor (pure zh+en grammar)
                                            │
              AgentEvent "device.command" ──┴──► iOS DeviceActionRouter
                                                        │ handler + permission gate
              ClientEvent "device.result" ◄─────────────┘
                        │
          ok   → Doubao's own spoken confirmation stands
          fail → ConversationTruncate + corrective line via useBrowserSpeech
```

Doubao is speech-to-speech: the model is already speaking while the relay
dispatches the action. The two must never disagree. Reconciliation is therefore
the core of this design, not an afterthought — see "Reconciliation".

### Intent extraction

`server/device-actions.ts` (new) owns the `DeviceCommand` union and a pure
`extractDeviceCommand(text): DeviceCommand | null` implementing a curated Chinese
and English command grammar. It is a pure function with no I/O, matching the
Vitest style already used across `tests/`. The grammar matches both languages in
a single pass, which also handles code-switching ("Max, navigate 到公司"), so it
takes no locale argument.

The extractor is reached through an interface:

```ts
type IntentExtractor = (text: string) => DeviceCommand | null;
```

If Doubao function-calling is later confirmed to exist, a second extractor
implementation replaces the grammar with zero changes to the protocol, the
client, or any Swift file.

### Command and result events

Added to `protocol/agent-events.schema.json` and regenerated into
`shared/generated`, the Kotlin contract, and `GeneratedAgentProtocol.swift` via
`scripts/generate-agent-protocol.ts`.

`AgentEvent` gains `device.command`:

| Field       | Type               | Notes                                   |
| ----------- | ------------------ | --------------------------------------- |
| `type`      | `"device.command"` |                                         |
| `commandId` | string             | Relay-issued, like `turnId`             |
| `action`    | enum               | See "Action catalog"                    |
| `args`      | object             | Per-action, schema-validated            |
| `tier`      | `"low" \| "high"`  | Declared risk; see "Confirmation tiers" |

`ClientEvent` gains `device.result`:

| Field       | Type                                            | Notes                        |
| ----------- | ----------------------------------------------- | ---------------------------- |
| `type`      | `"device.result"`                               |                              |
| `commandId` | string                                          | Echoes the command           |
| `status`    | `"ok" \| "failed" \| "denied" \| "unsupported"` | Never absent                 |
| `reason`    | string (optional)                               | Machine-readable failure key |
| `detail`    | string (optional)                               | Human-readable, spoken       |

### Action catalog

| Action             | Tier | iOS mechanism                               | Notes                                       |
| ------------------ | ---- | ------------------------------------------- | ------------------------------------------- |
| `torch.set`        | low  | `AVCaptureDevice.torchMode`                 | No permission required                      |
| `volume.set`       | low  | Existing `PcmPlayer` gain                   | Max's own voice, **not** system volume      |
| `music.control`    | low  | `MPMusicPlayerController.systemMusicPlayer` | Apple Music and local library only          |
| `sms.compose`      | high | `MFMessageComposeViewController`            | Rider must tap Send; speed-gated            |
| `call.dial`        | high | `tel:` via `UIApplication.open`             | iOS always shows its own confirmation alert |
| `destination.show` | low  | `MKLocalSearch` + `MKDirections` ETA        | In-app card; no hand-off, no guidance       |

### Confirmation tiers

The tier field is declared in the protocol because Spec 2's camera and the
Android client will need it. **On iOS in Spec 1 it drives no separate UI.**

Both high-tier actions carry a mandatory native confirmation that cannot be
bypassed:

- `tel:` opened from a native app has shown a system confirmation alert since
  iOS 10.3. The undocumented `telprompt:` scheme risks App Store rejection and is
  not used. Truly hands-free dialing is impossible on iOS.
- `MFMessageComposeViewController` requires a physical tap on Send by design.

Adding a spoken "对吗？" turn on top of a system alert is double confirmation and
costs a full conversational turn. Instead, Max announces _who and what number_ it
is about to dial so the rider knows what they are approving, and the system alert
does the confirming. No pending-command table, no expiry timer, no confirm
grammar is built in Spec 1.

### Navigation as a destination card

Max never leaves the foreground. A backgrounded iOS app cannot open URLs, dial,
or toggle the torch, so handing off to 高德/百度 would silently break every
subsequent device command until the rider tapped back into Max. Staying in the
foreground is what keeps the action layer alive.

`destination.show` geocodes the spoken place, renders an in-HUD MapKit card with
route line, distance, and ETA, and speaks a one-line summary. It issues no
guidance and starts no route.

`MKDirections` works for routes inside mainland China (AutoNavi-backed);
cross-border requests from a China-region device return "Directions Not
Available" and surface as `status: "unsupported"`. MapKit offers no motorcycle
transport profile — only `automobile`, `walking`, and `transit` — so ETAs follow
car routing and will not respect 摩托车禁行 roads. The spoken summary must not
imply a motorcycle-validated route.

### Reconciliation

The relay holds each dispatched `commandId` until its result arrives.

- `status: "ok"` — the relay stays silent and Doubao's own spoken confirmation
  stands.
- Any other status — the relay sends `ConversationTruncate` to cut the model's
  in-flight speech, then emits a corrective `transcript` with
  `useBrowserSpeech: true` carrying `detail`.
- No result within 8 seconds — treated as a failure and reconciled the same way.
  The relay never leaves a command pending forever. The window is generous enough
  to cover a permission prompt the rider has to read, and short enough that Max
  does not go quiet mid-ride.

### Grounding prompt rewrite

`buildToolGroundingPrompt()` changes from a blanket denial to an explicit
allowlist: the six actions above are real; weather and ride context remain
relay-injected facts; everything else — real-time traffic, nearby-place search,
vehicle control, group messaging, third-party music apps, emergency dispatch —
remains explicitly unavailable and must never be claimed. The rule that any
external action may be reported complete only when the system returns success is
kept and strengthened, because it is now load-bearing rather than decorative.

### Contact resolution

Requesting Contacts read access, matching happens entirely on-device with pinyin
and fuzzy matching for Chinese names. The relay sends only the spoken name; the
resolved phone number never leaves the phone.

Rider transcripts are persisted for QA by `recordTranscriptTurn` in
`server/metrics.ts`, so a spoken name would otherwise land in stored transcripts.
Names carried by a `call.dial` or `sms.compose` command are redacted there — at
the persistence boundary, so live captions and Max's own context keep the real
name while stored evidence does not. Emergency shortcuts (110 / 120 / 122) are
built in and need no contact lookup.

## Components

**Server**

- `server/device-actions.ts` — new. `DeviceCommand` union, `extractDeviceCommand`
  grammar, `IntentExtractor` interface, redaction helper. Pure, no I/O.
- `server/providers/doubao.ts` — hook extraction at the rider-final transcript;
  rewrite `buildToolGroundingPrompt()`; add reconciliation and the pending-command
  timeout.
- `server/providers/mock.ts` — same hook so scenarios exercise actions without
  credentials.
- `server/session-controller.ts` — validate and route `device.result`.
- `server/metrics.ts` — apply redaction in `recordTranscriptTurn`.

**Protocol**

- `protocol/agent-events.schema.json` — `device.command`, `device.result`.
- Regenerate via `scripts/generate-agent-protocol.ts`.

**iOS** — new `ios/MaxHelmet/Actions/` group; `AgentSession.swift` only forwards.

- `DeviceActionRouter.swift` — dispatch, permission gating, result encoding.
- `DeviceActionHandler.swift` — the handler protocol, so every handler is fakeable
  in tests.
- `TorchController.swift`, `PlaybackVolumeController.swift`,
  `MusicController.swift`, `MessageComposer.swift`, `CallDialer.swift`,
  `ContactResolver.swift`, `DestinationResolver.swift`, `DestinationCard.swift`.

**iOS Info.plist** — add `NSContactsUsageDescription` and
`NSAppleMusicUsageDescription`. Torch requires no permission entry. No
`LSApplicationQueriesSchemes` is needed, since nothing hands off.

## Error and edge handling

- Every command resolves to exactly one `device.result`. Silence is a bug.
- Permission denied returns `denied` with the specific permission, and Max says
  which one and that it can be granted in Settings.
- A locked or pocketed phone is a first-class failure: the router checks
  application state and returns `failed` with reason `device.locked`, and Max says
  the phone must be unlocked first.
- `sms.compose` is refused unless `ride.context.speedKmh` is below 5 km/h — that
  is, the bike is stopped — returning `denied` with reason `unsafe.speed`. A
  message the rider must read and tap to send has no safe use at speed. When
  `speedKmh` is absent, the action is refused rather than allowed.
- `music.control` carries an optional `app` arg. The grammar populates it when the
  rider names a player (网易云, QQ音乐, Spotify, …); the handler then returns
  `unsupported`, and Max says plainly that it can only control Apple Music and the
  local library. With no named player the command targets the system player.
- Cross-border or unresolvable destinations return `unsupported`, not a guess.
- Unknown or malformed commands on old clients are ignored without erroring, and
  the relay's timeout path speaks the failure.

## Verification

### Automated

- Vitest: table-driven grammar extraction across Chinese and English, including
  near-miss negatives that must **not** trigger an action; reconciliation for each
  status; timeout expiry; contact-name redaction.
- Vitest: generated-protocol sync check stays green across TypeScript, Kotlin, and
  Swift.
- XCTest: router dispatch per action, contact fuzzy/pinyin matching, result
  encoding, the SMS speed gate, and the locked-device path — all against faked
  handlers.
- Existing repository checks (lint, dead-code, fault matrix, production build)
  stay green.

### Manual

- Each of the six actions driven by voice on a physical device against the mock
  provider, then against live Doubao.
- Deliberate failure paths: permission denied, locked screen, third-party music,
  cross-border destination — each must be spoken, and Max must not have already
  claimed success.
- Android client receives a `device.command` and ignores it without erroring.

## Acceptance criteria

- All six actions execute by voice on iOS with the app foregrounded.
- Max's spoken confirmation matches the actual result in every path, including
  every failure listed above.
- No action is claimed complete without a `status: "ok"` result.
- The relay leaves no command pending indefinitely.
- Phone numbers never leave the device; contact names never reach stored QA
  transcripts.
- The feature demos end to end on the mock provider with no Doubao credentials.
