# Live Agent Testing Guide

This document describes every function of the Max helmet voice agent and how to
test it with our three-layer testing framework. "Live agent" means the real
Doubao realtime voice provider (`VOICE_PROVIDER=doubao`); the **mock provider**
is a faithful stand-in that replays the same event stream, so most behavior can
be exercised without Doubao credentials.

The three layers, from cheapest to most realistic:

| Layer                | What it exercises                                                       | How to run                                                                    | When to use it                                                                                            |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **1. Unit (vitest)** | Pure functions & protocol — no sockets, no audio                        | `npm test`                                                                    | Every change. Fast, deterministic, the regression gate.                                                   |
| **2. Mock relay**    | Full client ↔ relay ↔ provider event flow, binary PCM, scenario cycling | `npm run dev` (web) or the iOS simulator with `VOICE_PROVIDER=mock` (default) | UI, HUD, turn-state, ADAS timing, scenario demos — no credentials needed.                                 |
| **3. Live Doubao**   | Real ASR + TTS through ByteDance's realtime WebSocket                   | `VOICE_PROVIDER=doubao` + Doubao creds, any client                            | Voice quality, wake-word suppression, latency, weather Q&A — the things only the real provider can prove. |

Prerequisites for layers 2–3:

```bash
# Relay must be listening on :8787 before any client connects.
npm run dev                 # relay + web client together (http://localhost:5173)
# — or —
npm run dev:server          # relay only, for native clients
# — or double-click —
./start-relay.command
```

The relay URL clients must use is exactly `ws://localhost:8787/agent` (any other
path is rejected with HTTP 400). The shared test server is
`wss://3.35.135.136/agent`.

For the iOS client end-to-end, the `run-ios-simulator` skill builds, installs,
grants mic permission, fixes the saved relay URL, taps the hands-free button,
and verifies the WebSocket — see `.claude/skills/run-ios-simulator/SKILL.md`.

---

## How to run a single test

vitest filters by substring against the file path **and** the test name:

```bash
npm test -- wake                  # every test whose name/path contains "wake"
npm test -- "matches the bare name"
npm test -- tests/doubao-frame.test.ts
npm test -- -t "rejects frames that are too short"
npm run test:watch                # watch mode, reruns on change
```

All 79 tests currently live in `tests/` and run in well under a second.

---

## 1. Wake word — "Max"

**What it does:** On the live Doubao path the agent only replies when the rider
addresses it by name. The matcher tolerates casing, CJK/fullwidth punctuation,
common ASR mishearings, the name glued to Chinese, and an optional "Hey/你好"
greeting — but ignores the name embedded in a larger word ("maximum"). A 12 s
follow-up window keeps a conversation open without repeating the name. Disable
with `AGENT_WAKE_WORD=off` (mock is unaffected — its scripted demo always
responds).

**Code:** `shared/wake.ts` (`containsWakePhrase`, `WAKE_FOLLOWUP_WINDOW_MS`).
Applied in `server/providers/doubao.ts` (suppresses Doubao's reply when the rider
transcript lacks the name).

**Unit test:** `tests/wake.test.ts` — 12 cases covering bare name, name-anywhere,
optional greeting, punctuation/fullwidth, mishearings, glued-to-Chinese,
word-boundary rejection, and no-name negatives.

```bash
npm test -- wake
```

**Live test (mock):** Start the relay with `VOICE_PROVIDER=mock` (default) and the
web client. Because the mock always responds, wake-word behavior is **not**
exercised here — use the live path below.

**Live test (Doubao):**

```bash
VOICE_PROVIDER=doubao npm run dev:server   # + DOUBAO_* creds in .env
```

Connect any client, open hands-free, and speak:

- "今天天气怎么样" (no name) → Max stays silent (reply suppressed).
- "Max，今天天气怎么样" → Max answers; status shows `speaking`.
- Continue "前面路况呢？" within 12 s (no name) → Max still answers (follow-up window).

Expected: transcript only appears (and TTS only fires) on utterances that include
the name or fall inside the follow-up window. Toggle `AGENT_WAKE_WORD=off` and
confirm every utterance now gets a reply.

---

## 2. Language detection

**What it does:** Any Han character → Chinese (`zh`); everything else → English
(`en`), the only other supported voice. Drives which voice/language the agent
uses and how transcript items are tagged.

**Code:** `shared/language.ts` (`detectLanguage`). Ported to
`ios/.../AgentProtocol.swift` and `android/.../AgentProtocol.kt`.

**Unit test:** `tests/language.test.ts` — Han-only, Latin, kanji-as-Chinese, and
the non-Han/non-Latin fallback (Cyrillic/Arabic/kana → `en`).

```bash
npm test -- language
```

**Live test:** On any client with the relay running, the transcript log tags each
turn with its language. Speak a Chinese sentence then an English one and confirm
the language tag switches. On the live Doubao path, a Chinese utterance gets the
Chinese voice and vice-versa.

---

## 3. Provider capabilities

**What it does:** Declares what each provider can do (server VAD, synthesized
audio, transcript events, barge-in, voice selection, weather context, session
memory, emergency mode). Sent to clients in `session.started.capabilities`.

**Code:** `shared/agent.ts` (`providerCapabilities`, `ProviderCapabilities`,
`DEFAULT_CAPABILITIES`). Mirrored on native as `ProviderCapabilities` in
`AgentProtocol.swift` / `AgentProtocol.kt` and stored on session `State`.

**Unit test:** `tests/agent.test.ts` — Doubao declares `serverVad`,
`synthesizedAudio`, `weatherContext`, `emergencyMode`; mock declares
`transcriptEvents` + `sessionMemory` but no synthesized audio.

```bash
npm test -- "agent contracts"
```

**Live test:** Connect a client and inspect the first `session.started` event.
With `VOICE_PROVIDER=mock`, `capabilities.synthesizedAudio` is false (the mock
emits text only, the client uses browser TTS). With `VOICE_PROVIDER=doubao`,
`synthesizedAudio` and `serverVad` are true (Doubao sends real PCM voice and
does its own VAD). The native apps surface this in the hidden developer panel
(long-press the Max logo → raw status).

---

## 4. Session memory & safety policy

**What it does:** Tracks language, last intent, destination, and response mode
across a ride. Infers emergency intent and escalates the response mode; keeps
riding/navigation answers concise; builds the safety, personality, intent, and
session-memory prompt fragments fed to Doubao.

**Code:** `shared/session.ts` (`createSessionMemory`, `updateSessionMemory`,
`inferIntent`, `responseModeForRide`, `buildSafetyPrompt`,
`buildPersonalityPrompt`, `buildIntentGuidancePrompt`, `buildSessionMemoryPrompt`).

**Unit test:** `tests/session.test.ts` — emergency escalation, concise-vs-normal
mode, language/destination/intent inference (including the bare-infinitive
destination negative), per-personality prompt fragments, intent guidance
fallback, and high-speed safety policy (>60 km/h).

```bash
npm test -- "session memory"
```

**Live test (mock):** Start the relay and web client, pick the `紧急` scenario.
The HUD shows `紧急模式` and the safety prompt fragment; speak "帮我回家" and the
`session.memory` event updates `destination`. Watch the raw event stream in the
developer panel to confirm `responseMode` and `destination` propagate.

**Live test (Doubao):** With `VOICE_PROVIDER=doubao`, say "I crashed, I need
help" — `inferIntent` flips to `emergency`, `responseModeForRide` returns
`emergency`, and Max switches to the emergency persona. Confirm the system
prompt actually changed by inspecting the relay logs (`logger.ts` prints the
session start).

---

## 5. Ride intelligence (ride context)

**What it does:** Turns the selected `rideMode` + `scenario` into a safety
policy, response style, hazard level, and HUD focus; builds the `态势摘要`
situation-summary card; fuses ride hazard with weather risk into
normal/caution/critical. `combineHazardLevels` is `max` (only raises).

**Code:** `shared/ride.ts` (`scenarioDefaultMode`, `rideModeFromScenario`,
`describeRideMode`, `buildRideContextSummary`, `combineHazardLevels`,
`scenarioLabel`). Mirrored on native (`scenarioDefaultMode`,
`combineHazardLevels`, `rideModeHazard`, `RideContext`).

**Unit test:** `tests/ride.test.ts` — scenario→mode mapping, explicit-mode
override, emergency hazard/safety rule, ride-context summary content, and the
max-hazard fusion.

```bash
npm test -- "ride intelligence"
```

> **Bug note (fixed):** because `combineHazardLevels` only raises, mutating
> `rideContext.hazardLevel` on every weather event left the HUD stuck high when
> weather improved — on the live path a whole session can pass between
> `ride.context` events. The web, iOS, and Android clients now fold the current
> weather in at render time and leave `rideContext.hazardLevel` to the server's
> `ride.context` events. When re-testing this, confirm weather risk is reflected
> in the `态势摘要` card **without** ratcheting the ride-pulse hazard.

**Live test (mock):** Cycle scenarios via the web scenario selector or the mock
provider's auto-cruise. Each `ride.context` event updates speed, route phase,
network, battery, hazard level, and glanceable focus on the HUD. Pick `横风`
(caution) then `紧急` (critical) and confirm the ride pulse escalates and the
summary card's rider action changes.

---

## 6. Weather risk

**What it does:** Maps Open-Meteo weather codes to Chinese descriptions, assesses
risk (normal/caution/critical) from description + wind speed, and builds a rider
summary including crosswind warnings above the wind threshold.

**Code:** `server/weather.ts` (`describeWeatherCode`, `assessWeatherRisk`,
`buildWeatherSummary`). Fetch runs in `server/providers/doubao.ts` and the mock
provider; a mid-ride refresh runs every `WEATHER_REFRESH_MS` (default 10 min).

**Unit test:** `tests/weather.test.ts` — code mapping (clear/rain/thunder/unknown),
risk thresholds (calm→normal, rain/strong-wind→caution, severe→critical), and
summary content incl. crosswind.

```bash
npm test -- weather
```

**Live test:** Grant location permission on the client (or set
`DEFAULT_RIDER_LAT`/`DEFAULT_RIDER_LON`). On connect, Max greets with real
weather and the `实时天气` card shows description, temp, wind, risk, and advice.
On the live path, ask "前面天气怎么样" and confirm the spoken answer matches the
card. To test a refresh, set `WEATHER_REFRESH_MS=15000` and watch for a new
`weather` event after 15 s.

---

## 7. ADAS proactive hazard alerts

**What it does:** A catalog of simulated directional hazards (rear approach,
forward collision, blind spot, cross-traffic, pedestrian, lane departure,
tailgating). The hazard injector fires an **interrupting** `hazard.alert` that
raises the ride-pulse hazard and announces the danger via a display-only
transcript (so the client's TTS reads it once, not twice).

**Code:** `shared/adas.ts` (`ADAS_SCENARIOS`, `getAdasScenario`,
`formatAdasAlert`, `adasDirectionLabel`) and `server/hazard-injector.ts`
(`createHazardInjector`).

**Unit test:** `tests/adas.test.ts` — catalog well-formedness, unique threat
ids, rear/front/side coverage, the canonical rear-approach scenario, alert
formatting, the injector firing an interrupting display-only alert that raises
the hazard, and the mock provider auto-injecting after `startAudio`.

```bash
npm test -- adas
```

**Live test (mock):** The mock auto-injects on every session (~11 s; ~5 s on the
`ADAS` scenario). Open hands-free on any client, pick `ADAS`, and within ~5 s an
interrupting alert appears: the ride pulse jumps to caution/critical, the
agent's transcript line shows the directional warning, and TTS reads it once.
Confirm there is no double-read (display-only transcript + client TTS).

**Live test (Doubao):** Only the `ADAS` scenario injects on the live path. With
`VOICE_PROVIDER=doubao` and the `ADAS` scenario, confirm the interrupting alert
cuts off any in-progress agent speech (barge-in) and Max announces the hazard.

---

## 8. Doubao realtime frame protocol

**What it does:** Speaks Volcengine's realtime dialogue framing — a 4-byte header
then big-endian `uint32` event/length fields and a JSON or raw payload. The send
and parse halves must stay in sync.

**Code:** `server/providers/doubao.ts` (`buildHeader`, `buildFullClientRequest`,
`buildAudioRequest`, `parseDoubaoFrame`, `EventSend`, `EventReceive`,
`MessageType`, `extractChatText`, `extractAsrText`, `normalizeTranscriptText`).

**Unit test:** `tests/doubao-frame.test.ts` — client-request header/event
construction, audio-only PCM request, JSON server-response parse, raw audio
parse, and rejection of too-short / unsupported-message-type / truncated-payload
frames; plus `extractAsrText`, `extractChatText` (incl. deep-payload recursion
guard), and `normalizeTranscriptText` space-tolerance.

```bash
npm test -- "doubao-frame"
```

**Live test (Doubao):** This is only reachable on the live path. With
`VOICE_PROVIDER=doubao`, watch the relay log: you'll see outbound
`StartConnection` / `TaskRequest` frames and inbound JSON (ASR/chat) and raw PCM
(audio) frames. If the frame parser ever throws on a real Doubao frame, the
session drops with a parse error — that's the regression signal for this layer.

---

## 9. Doubao voice & prompt building

**What it does:** Picks the Doubao speaker voice by gender (with env overrides
`DOUBAO_VOICE` / `DOUBAO_VOICE_MALE` and a fallback off the unsupported male
realtime speaker), and builds the identity, language-interaction, and
voice-setting prompts. The developer is attributed to neueHCT — **never**
ByteDance/Doubao — and the agent speaks Chinese first, English second, nothing
else.

**Code:** `server/providers/doubao.ts` (`doubaoSpeaker`,
`DEFAULT_AGENT_SYSTEM_PROMPT`, `buildIdentityPrompt`,
`buildLanguageInteractionPrompt`, `buildVoiceSettingPrompt`).

**Unit test:** `tests/doubao-voice.test.ts` — default + overridden speakers per
gender, the unsupported-speaker fallback, shared Max role / "音色只影响声音",
neueHCT attribution with the explicit ByteDance/Doubao forbid, and the
Chinese-first/English-second/other-rejected language rule.

```bash
npm test -- "doubaoSpeaker"
```

**Live test (Doubao):** Set `DOUBAO_VOICE=zh_female_custom_bigtts` (or any valid
voice id) and confirm Max speaks in that voice. In the dev panel, the raw
session-start log shows the assembled system prompt; confirm it contains
"Horizon Continental Technology" and the language rule, and that the agent
refuses to attribute itself to ByteDance if asked "你是哪家公司的".

---

## 10. Relay auth & rate limiting

**What it does:** Gates the WebSocket upgrade — optional shared token
(`RELAY_AUTH_TOKEN`), origin allowlist for browsers (`RELAY_ALLOWED_ORIGINS`,
native apps send no `Origin` and pass), and a per-IP connection rate limit
(`RELAY_CONN_PER_MINUTE`, default 30) enforced as a **true sliding 60 s window**
(no burst at the minute boundary).

**Behind a reverse proxy** (the Caddy/Lightsail deploy) set `RELAY_TRUST_PROXY=on`
so the real client IP is read from `X-Forwarded-For` — `RELAY_TRUSTED_PROXY_HOPS`
entries from the **right** (default 1 = single Caddy). Left of that is
client-supplied and never trusted, so a forged `X-Forwarded-For` can't dodge the
limit. With trust off behind a proxy, every client collapses onto the proxy's
address and the per-IP limit becomes a single global bucket — the relay logs a
startup warning for exactly this misconfiguration.

**Code:** `server/auth.ts` (`authorizeUpgrade`, `checkRateLimit`, `clientAddress`,
`resetRateLimit`).

**Unit test:** `tests/auth.test.ts` — open-when-unconfigured, token required when
set, browser origin allowlist with native bypass, the sliding rate-limit window
(cap, unaffected other IPs, recovery after 60 s, partial-expiry — one slot frees
without a full reset), and proxy IP handling (trust-off ignores the header,
right-anchored real IP, spoofed-leftmost entry rejected, multi-hop peeling).

```bash
npm test -- "authorizeUpgrade"
```

**Live test:** With `RELAY_AUTH_TOKEN=s3cret`, connect from the web client
without `?token=` → handshake rejected; with `?token=s3cret` → accepted. Set
`RELAY_ALLOWED_ORIGINS=https://max.example.com` and open the client from a
different origin → rejected. Set `RELAY_CONN_PER_MINUTE=3` and reconnect
repeatedly from one IP → 4th attempt within a minute is rejected, recovers a
minute later. Behind Caddy, confirm the startup log prints `Relay proxy trust:
on (1 hop via X-Forwarded-For)` — and that leaving `RELAY_TRUST_PROXY=off` there
prints the proxy-collapse warning instead.

---

## 11. WebSocket relay lifecycle

**What it does:** The `/agent` relay runs a full session lifecycle —
`session.start` → `session.started` → `ride.context` → `session.memory` →
`weather` → turn cycle (`status`/`transcript`/`metric`) — over JSON events with
binary PCM interleaved.

**Code:** `server/session-controller.ts` (`AgentSessionController`,
`parseClientEvent`, `normalizeRawData`).

**Unit test:** `tests/websocket.test.ts` — a real `ws` server on an ephemeral
port runs a mock session end-to-end (JSON + binary audio) and asserts the
expected event sequence; plus client-event validation and fragmented-frame
normalization.

```bash
npm test -- "WebSocket relay"
```

**Live test:** The whole mock layer (any client) is this test, just through a
real client instead of a raw socket. Open hands-free and confirm the same event
sequence appears in the dev panel's raw status: `connection` → `session.started`
→ `ride.context` → `session.memory` → `weather` → `status`/`transcript` cycle.

---

## 12. Client event validation (incl. `demo.guided`)

**What it does:** `parseClientEvent` validates inbound client events before they
reach a provider — rejects bad `sampleRate`/`channels`/`scenario`/`voiceGender`/
`voicePersonality`, unsupported event types, and a malformed `demo.guided`
enabled flag. `normalizeRawData` reassembles fragmented binary frames.

**Code:** `server/session-controller.ts` (`parseClientEvent`, `normalizeRawData`).

**Unit test:** `tests/websocket.test.ts` — valid `session.start` accepted,
invalid `sampleRate`/`scenario` and unknown events rejected, `demo.guided`
accepted with `enabled:true` and rejected when the flag is missing, and
fragmented-frame normalization.

```bash
npm test -- "client event validation"
```

**Live test:** From a client, send `{"type":"session.start","sampleRate":44100}`
(e.g. via the dev panel or a raw `ws` client) → the relay closes with
"Invalid sampleRate". Send `{"type":"demo.guided","enabled":true}` → the mock
enters guided-cruise mode ("巡游演示已开启"). Native clients currently do not send
`demo.guided` (it's a web/dev toggle); if you want it on native, that's a
feature addition — see the open item in the project notes.

---

## 13. Audio packet metrics

**What it does:** Tracks outgoing frame rate and dropped frames over a sliding
window for the up-link PCM stream (16 kHz, mono, Int16).

**Code:** `shared/audio.ts` (`createPacketWindow`, `recordSentFrame`,
`recordDroppedFrame`).

**Unit test:** `tests/audio.test.ts` — emits FPS once the window elapses, and
tracks dropped frames while preserving the active window.

```bash
npm test -- "audio packet"
```

**Live test:** On the web client with hands-free open, the audio HUD shows
outgoing FPS and dropped-frame count. Speak continuously and confirm FPS tracks
~the configured send rate; induce load (e.g. throttle the tab) and confirm
dropped frames increment rather than the stream stalling.

---

## 14. Per-tester testing statistics

**What it does:** The web HUD persists a tester/workstation ID and sends it with
`session.start`, along with the browser time zone as the region. The relay keys
rows by tester ID + client IP, so a tester name is attached to the network that
ran it; clients that omit `testerId` become `ip:<address>` instead of
`anonymous`. The relay aggregates sessions, active runs, duration, mic uplink
bytes, audio/control downlink bytes, first-audio average/p95 latency, errors,
TTS fallbacks, recent transcript turns, completed session summaries, quality
flags, and 30-minute graph buckets by tester/IP. In the HUD, selecting a tester
ID or IP opens that tester's recent chat history; the session replay panel then
filters retained runs by pass/watch/fail, shows per-run bandwidth/latency/error
metrics, and exports one session as JSON evidence.

Completed sessions are appended to `~/.horizon-helmet-testing/sessions.jsonl`
by default. This path is intentionally outside `/home/ubuntu/app`, so rsync
deploys do not delete QA evidence. Use `TESTING_HISTORY_DIR=off` to disable
disk persistence, `TESTING_HISTORY_DIR=/path/to/dir` to move it, or
`TESTING_HISTORY_MAX_SESSIONS=500` to raise the retained window.

**Code:** `server/metrics.ts` (`beginTesterSession`,
`recordTesterClientAudio`, `recordTesterServerEvent`, `testingSnapshot`),
`server/session-controller.ts` (`testerId` validation + attribution), and
`src/App.tsx` (testing dashboard).

**Unit test:** `tests/metrics.test.ts` covers per-tester sessions, IP fallback,
region, bandwidth, latency, transcript turns, completed session summaries,
quality flags, errors, and fallbacks; `tests/websocket.test.ts` validates safe
`testerId` and `testerRegion` values.

```bash
npm test -- "per-tester"
npm test -- "tester ids"
```

**Live test:** Start the web client, set `Tester ID`, open hands-free, and speak
through a short mock or Doubao run. Confirm the testing panel increments active
sessions, mic up/downlink bandwidth, latency, and per-user rows. Then check:

```bash
curl -s http://localhost:8787/health | jq '.testing'
```

Expected: `testing.users[]` includes `testerKey`, `testerId`, `ipAddress`,
`region`, and a bounded `recentTurns[]` transcript list; `testing.sessions[]`
contains retained completed runs with `quality`, `flags`, per-session counters,
and `turns[]`; `testing.timeline[]` contains graph-ready minute buckets. Behind
Caddy/Lightsail, `RELAY_TRUST_PROXY=on` is required or the IP will be the local
proxy address instead of the tester address.

---

## 15. Mock provider scenario cycling

**What it does:** The mock provider replays scripted rider/agent transcripts and
metrics per scenario, auto-cycles through scenarios in guided-cruise mode, and
auto-injects ADAS alerts (every session; faster on `ADAS`). Exercises the full
streaming path with no credentials.

**Code:** `server/providers/mock.ts` (`createMockProvider`), driven by
`server/hazard-injector.ts` for alerts.

**Unit test:** `tests/adas.test.ts` ("mock provider ADAS injection") and
`tests/websocket.test.ts` (full lifecycle).

```bash
npm test -- "mock provider"
```

**Live test:** Default `VOICE_PROVIDER=mock`. On the web client, enable
guided-cruise (the `demo.guided` toggle or the scenario selector) and watch
scenarios rotate (`通勤` → `横风` → `低油` → …) with matching speed/route-phase/
weather/hazard on the HUD, plus a scripted rider/agent transcript each cycle.

---

## End-to-end: live Doubao on a real client

This is the only layer that proves voice quality, wake-word suppression, and
real latency.

```bash
# 1. Put Doubao credentials in .env (server/config.ts reads these):
#    DOUBAO_API_KEY=...           (or DOUBAO_APP_ID + DOUBAO_APP_KEY + DOUBAO_ACCESS_KEY)
#    VOICE_PROVIDER=doubao
#    AGENT_WAKE_WORD=on           (default; "off" disables name gating)

# 2. Start the relay
npm run dev:server

# 3. Connect a client at ws://localhost:8787/agent
#    - web:        http://localhost:5173  (npm run dev:client)
#    - iOS:        run-ios-simulator skill (build + install + drive)
#    - Android:    Android Studio run against the same relay
```

What to confirm in one pass:

1. `session.started` with `provider: "doubao"`, `mode: "live"`, and
   `capabilities.synthesizedAudio: true`.
2. Speaking the wake name → agent replies in real Doubao PCM; no name → silent.
3. Real weather Q&A matches the `实时天气` card.
4. Barge-in: speaking while Max talks interrupts and restarts the turn.
5. `ADAS` scenario → an interrupting hazard alert cuts off speech and announces.
6. Latency `metric` events appear with realistic ASR/think/firstAudio/total ms.

---

## Test matrix (all functions, one table)

| #   | Function                  | Code                                          | Unit test                                          | Live layer                      |
| --- | ------------------------- | --------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| 1   | Wake word "Max"           | `shared/wake.ts`                              | `tests/wake.test.ts`                               | Doubao                          |
| 2   | Language detection        | `shared/language.ts`                          | `tests/language.test.ts`                           | any                             |
| 3   | Provider capabilities     | `shared/agent.ts`                             | `tests/agent.test.ts`                              | any (inspect `session.started`) |
| 4   | Session memory & safety   | `shared/session.ts`                           | `tests/session.test.ts`                            | mock + Doubao                   |
| 5   | Ride intelligence         | `shared/ride.ts`                              | `tests/ride.test.ts`                               | mock                            |
| 6   | Weather risk              | `server/weather.ts`                           | `tests/weather.test.ts`                            | any (location)                  |
| 7   | ADAS hazard alerts        | `shared/adas.ts`, `server/hazard-injector.ts` | `tests/adas.test.ts`                               | mock (auto); Doubao (ADAS)      |
| 8   | Doubao frame protocol     | `server/providers/doubao.ts`                  | `tests/doubao-frame.test.ts`                       | Doubao                          |
| 9   | Doubao voice & prompts    | `server/providers/doubao.ts`                  | `tests/doubao-voice.test.ts`                       | Doubao                          |
| 10  | Relay auth & rate limit   | `server/auth.ts`                              | `tests/auth.test.ts`                               | any (reconnect)                 |
| 11  | WebSocket relay lifecycle | `server/session-controller.ts`                | `tests/websocket.test.ts`                          | any                             |
| 12  | Client event validation   | `server/session-controller.ts`                | `tests/websocket.test.ts`                          | any (raw `ws`)                  |
| 13  | Audio packet metrics      | `shared/audio.ts`                             | `tests/audio.test.ts`                              | web                             |
| 14  | Per-tester statistics     | `server/metrics.ts`, `src/App.tsx`            | `tests/metrics.test.ts`, `tests/websocket.test.ts` | web + `/health`                 |
| 15  | Mock scenario cycling     | `server/providers/mock.ts`                    | `tests/adas.test.ts`, `tests/websocket.test.ts`    | mock                            |

Run the whole unit suite at any time:

```bash
npm test      # full Vitest suite
npm run lint
npm run format:check
```

For the native clients, compile-check before relying on a run:

```bash
# Android (Kotlin, full type-check)
cd android && ./gradlew :app:compileDebugKotlin
# iOS (needs Xcode; parse/type-check what the macOS SDK allows)
swiftc -typecheck ios/MaxHelmet/Agent/*.swift   # see run-ios-simulator skill for a full build
```
