# Voice Test Plan — test every function with your own voice

This is a **speak-it-yourself** test plan. You read each utterance aloud, listen
to Max's reply, and check the HUD. It tests the same behaviors the vitest suite
covers, but driven by your real voice through the **live Doubao provider**.

> **The mock provider will not work for this.** The mock replays scripted turns
> regardless of what you say — your microphone is ignored. Real ASR (hearing
> your actual words) only happens with `VOICE_PROVIDER=doubao`. So this whole
> plan requires the live provider.

## Setup (one time)

```bash
# .env on the relay machine:
#   VOICE_PROVIDER=doubao
#   DOUBAO_API_KEY=...            (or DOUBAO_APP_ID + DOUBAO_APP_KEY + DOUBAO_ACCESS_KEY)
#   AGENT_WAKE_WORD=on            # default; needed for the wake-word tests
npm run dev:server                 # relay on :8787
```

Then connect a client at `ws://localhost:8787/agent` (web `npm run dev:client`,
or the iOS/Android app). Grant microphone permission. Open the hidden developer
panel (long-press the Max logo) so you can watch the raw event stream and
session.memory while you talk.

Confirm before starting: `session.started` shows `provider: "doubao"`,
`mode: "live"`, `capabilities.synthesizedAudio: true`. If it says `mock`,
your `.env` isn't loaded — fix that first or the rest of this plan is invalid.

## How to read a step

Each step is one utterance. Format:

> **Say:** `…` — **Expected:** what Max says / HUD shows — **Pass when:** the
> single thing that proves it worked.

Speak naturally; ASR tolerates minor mishearings. Keep each utterance short.
Don't restart the session between steps unless a step says to — several tests
rely on the 12 s follow-up window and session memory carrying over.

---

## A. Wake word "Max" (4 steps, ~1 min)

Tests `shared/wake.ts` — name gating, follow-up window, no-name suppression.

> **A1. Say:** `今天天气怎么样` (no name)
> **Expected:** Max stays silent. No agent transcript line, no TTS.
> **Pass when:** the transcript log shows nothing from the agent. (Your rider
> line may still appear briefly then get dropped.)

> **A2. Say:** `Max，今天天气怎么样`
> **Expected:** Max answers the weather; status flips `speaking`.
> **Pass when:** an `agent` transcript line appears **and** you hear TTS.

> **A3. Within 12 s, say:** `前面路况呢` (no name)
> **Expected:** Max still answers — the follow-up window is open.
> **Pass when:** Max replies without the name. This proves the 12 s window.

> **A4. Wait 15 s in silence, then say:** `前面路况呢` (no name)
> **Expected:** Max is silent again — the window has closed.
> **Pass when:** no reply. (If Max replies, the follow-up window timer is
> broken.)

Optional toggle check: set `AGENT_WAKE_WORD=off`, restart the relay, say
`今天天气怎么样` (no name) → Max now answers every utterance.

---

## B. Language detection + language rule (3 steps)

Tests `shared/language.ts` and the Chinese-first/English-second/other-rejected
prompt rule in `server/providers/doubao.ts`.

> **B1. Say:** `Max，前面路况怎么样`
> **Expected:** Max replies in **Chinese**; transcript tag `zh`; Chinese voice.
> **Pass when:** the reply is Chinese and the transcript shows `zh`.

> **B2. Say:** `Max, switch to English. How's the weather ahead?`
> **Expected:** Max replies in **English**; transcript tag `en`.
> **Pass when:** the reply is English and the transcript shows `en`.

> **B3. Say:** `マックス、天気はどう？` (Japanese)
> **Expected:** Max replies in Chinese: `我只支持中文和 English` (short refusal).
> **Pass when:** Max does **not** speak Japanese and gives that refusal line.

---

## C. Voice selection (1 step)

Tests `doubaoSpeaker` + the shared-Max-role rule.

> **C1. In the UI, switch to 男声, then say:** `Max，你好`
> **Expected:** Max replies in a male voice, same Max persona/language.
> **Pass when:** the voice is clearly male and Max still introduces itself as
> Max (not a different character). Switch back to 女声 and confirm the reverse.

---

## D. Weather Q&A (1 step)

Tests `server/weather.ts` end-to-end with real Open-Meteo data (needs location
permission, or `DEFAULT_RIDER_LAT`/`DEFAULT_RIDER_LON`).

> **D1. Say:** `Max，前面天气怎么样`
> **Expected:** Max's spoken answer matches the `实时天气` card — description,
> temperature, wind, risk, and the rider advice.
> **Pass when:** what Max says agrees with the card (same risk level, same
> temperature ballpark). If the card is empty, location isn't set — fix that
> first; this test is meaningless without real weather.

---

## E. Session memory — destination (2 steps)

Tests `updateSessionMemory` / `inferDestination` (destination-bearing phrase
required; bare infinitives must **not** capture).

> **E1. Say:** `Max，导航去加油站`
> **Expected:** Max acknowledges navigating to a gas station; the dev panel's
> `session.memory` event shows `destination: "加油站"`.
> **Pass when:** `session.memory.destination` is populated.

> **E2. Say:** `Max，还有多远`
> **Expected:** Max references the gas station (it remembered the destination).
> **Pass when:** Max's answer mentions the destination, not a generic reply.

> **E3 (negative). Say:** `Max，我想骑快一点`
> **Expected:** Max replies about riding — but `session.memory.destination`
> stays empty (a bare "ride" must not be captured as a destination).
> **Pass when:** `destination` is **not** set to "ride" / "骑".

---

## F. Session memory — emergency escalation (1 step)

Tests `inferIntent` (EMERGENCY_PATTERN) → `responseModeForRide` → emergency
persona and safety rule.

> **F1. Say:** `Max，我摔车了，需要帮助`
> **Expected:** `session.memory.lastIntent` becomes `emergency`,
> `responseMode` becomes `emergency`; Max switches to the emergency persona —
> short, safety-first, mentions `生命安全` / pulling over / calling for help.
> **Pass when:** the intent/memory updates show emergency **and** Max's tone is
> the emergency one, not casual.

---

## G. ADAS hazard alert + barge-in (2 steps)

Tests `shared/adas.ts` + `server/hazard-injector.ts`. On the live path this
**only fires on the `ADAS` scenario**.

> **G1. Pick the `ADAS` scenario, open hands-free, then keep talking so Max is
> mid-sentence. Wait ~5 s.**
> **Expected:** An interrupting `hazard.alert` fires — the ride pulse jumps to
> caution/critical, Max's current speech is **cut off** (barge-in), and Max
> announces one of the directional warnings, e.g. `注意，后方车辆高速接近。
保持车道，握稳车把，不要急刹。`
> **Pass when:** (1) the alert interrupts speech, (2) Max reads the warning
> **once** (no double TTS — the transcript line is display-only), (3) the HUD
> hazard level rises.

> **G2. While Max is speaking any reply, say:** `Max，停`
> **Expected:** Max stops immediately (barge-in from the rider).
> **Pass when:** TTS cuts off the moment you speak.

---

## H. Identity & prompt attribution (2 steps)

Tests `buildIdentityPrompt` — Max names no company, **never** ByteDance/Doubao.

> **H1. Say:** `Max，你是哪家公司开发的`
> **Expected:** Max says it is Max, the helmet's voice assistant, without naming
> a company. It must **not** say ByteDance or Doubao.
> **Pass when:** no company and neither ByteDance nor Doubao is named.

> **H2. Say:** `Max，你是豆包吗`
> **Expected:** Max denies being Doubao/ByteDance (per the explicit forbid in
> the prompt).
> **Pass when:** Max does not claim to be Doubao.

---

## I. Ride intelligence / HUD fusion (observe, 1 step)

Tests `shared/ride.ts` — scenario → hazard level → `态势摘要` card. Not driven
by voice; driven by the scenario selector while you watch.

> **I1. Switch scenarios in order:** `通勤` → `横风` → `紧急`.
> **Expected:** the ride-pulse hazard rises normal → caution → critical, and
> the `态势摘要` card's rider action changes
> (`保持节奏…` → `放缓一点…` → `优先靠边…`).
> **Pass when:** all three levels and actions appear in sequence as you switch.

> **Bug regression check:** while on `横风`, wait for a `weather` event whose
> risk is **lower** than the current hazard. The ride-pulse hazard must **not**
> drop from the weather event (it's owned by `ride.context`); only the
> `态势摘要` card reflects the lower weather risk. This is the ratchet fix —
> confirm the hazard does not ratchet down from weather.

---

## Not voice-testable — verify by inspection

These functions have no utterance; check them once in the dev panel / relay log
during the session above.

| Function                                            | Where to look                                | What confirms it                                                                    |
| --------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Provider capabilities (`shared/agent.ts`)           | dev panel → `session.started`                | `capabilities.synthesizedAudio`/`serverVad` true on Doubao                          |
| Doubao frame protocol (`doubao.ts`)                 | relay log while you talk                     | JSON ASR frames + raw PCM audio frames, no parse errors                             |
| Relay auth & rate limit (`server/auth.ts`)          | reconnect from a raw `ws` client             | token/origin/rate-limit gates reject as configured                                  |
| WebSocket relay lifecycle (`session-controller.ts`) | dev panel raw stream                         | `connection`→`session.started`→`ride.context`→`session.memory`→`weather`→turn cycle |
| Client event validation (`session-controller.ts`)   | send a bad `session.start` from a raw client | relay rejects "Invalid sampleRate" etc.                                             |
| Audio packet metrics (`shared/audio.ts`)            | web audio HUD while you talk                 | outgoing FPS tracks send rate; dropped frames increment under load                  |
| Mock scenario cycling (`mock.ts`)                   | N/A on the live path                         | re-run with `VOICE_PROVIDER=mock` to see guided cruise                              |

---

## One-page runbook (print this)

| #   | Say / do                       | Pass when                                            |
| --- | ------------------------------ | ---------------------------------------------------- |
| A1  | `今天天气怎么样` (no name)     | Max silent                                           |
| A2  | `Max，今天天气怎么样`          | Max answers + TTS                                    |
| A3  | (≤12 s) `前面路况呢`           | Max answers (follow-up)                              |
| A4  | (>12 s) `前面路况呢`           | Max silent (window closed)                           |
| B1  | `Max，前面路况怎么样`          | Chinese reply, tag `zh`                              |
| B2  | `Max, switch to English…`      | English reply, tag `en`                              |
| B3  | `マックス、天気はどう？`       | Chinese refusal `我只支持中文和 English`             |
| C1  | switch 男声, `Max，你好`       | male voice, same Max                                 |
| D1  | `Max，前面天气怎么样`          | spoken answer matches 实时天气 card                  |
| E1  | `Max，导航去加油站`            | `session.memory.destination = 加油站`                |
| E2  | `Max，还有多远`                | Max mentions the destination                         |
| E3  | `Max，我想骑快一点`            | `destination` stays empty (no false capture)         |
| F1  | `Max，我摔车了，需要帮助`      | intent/memory → emergency, emergency persona         |
| G1  | ADAS scenario, talk, wait ~5 s | interrupting alert, TTS once, hazard rises           |
| G2  | `Max，停` while Max talks      | speech cuts off (barge-in)                           |
| H1  | `Max，你是哪家公司开发的`      | no company named, not ByteDance/Doubao               |
| H2  | `Max，你是豆包吗`              | Max denies being Doubao                              |
| I1  | switch 通勤→横风→紧急          | hazard + rider action escalate through 3 levels      |
| I2  | on 横风, weather risk drops    | ride-pulse hazard does not ratchet down from weather |

A green run of A–I plus the inspection table covers every function the vitest
suite covers, exercised by your voice on the live agent.
