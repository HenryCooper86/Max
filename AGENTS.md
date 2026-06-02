# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Overview

Prototype AI voice agent for a motorcycle helmet ("Max"). A React HUD frontend talks to an
Express/WebSocket backend that relays realtime voice to Volcengine's Doubao Speech service.
The agent speaks Chinese by default, also handles English, and refuses any other language.
The UI is a single hands-free voice agent — one tap (or Space) to activate, then the rider
just talks (Doubao's server-side VAD handles turn-taking); no text chat.

`CLAUDE.md` is a mirror of this file for Claude Code — keep both in sync when updating
guidance.

## Commands

```bash
npm run dev          # Run Vite client (5173) and Express/WS server (8787) concurrently
npm run dev:client   # Vite client only
npm run dev:server   # tsx watch server only
npm run build        # tsc type-check (noEmit) then vite build -> dist/
npm run preview      # Serve the built client
npm run lint         # ESLint (flat config, typescript-eslint + react-hooks)
npm run format       # Prettier write; format:check verifies without writing
npm test             # Vitest run; test:watch for watch mode
npx vitest run tests/language.test.ts   # Run a single test file
./start-relay.command # Finder-friendly launcher for the backend relay only
```

`tsc` runs with `noEmit: true` purely for type-checking `src/`, `server/`, and `shared/`.
Tests live in `tests/` and cover the pure functions (frame protocol, event parsing, ride/
session/weather/audio helpers); Vitest picks them up with no config.

Smoke test (server must be running):

```bash
curl -s http://localhost:8787/health
```

## Architecture

Two processes in development. The Vite client proxies `/health` and `/agent` (WS) to the
backend on `:8787`, so the browser only ever talks to the Vite origin (see `vite.config.ts`).
In production there is one Node process: `server/index.ts` serves the built `dist/` client
itself when it exists. Doubao credentials never reach the browser — it only talks to the relay.

### WebSocket relay → session controller → provider

`server/index.ts` accepts browser WS connections on `/agent` and hands each one to an
`AgentSessionController` (`server/session-controller.ts`), which validates and parses every
client message — JSON event size caps, enum checks for `voiceGender`/`voicePersonality`/
`rideMode`/`scenario`, lat/lon range checks, audio frame size caps — before routing it to a
provider chosen by `VOICE_PROVIDER`: `mock` (default) or `doubao`.

Both providers implement the `AgentProvider` interface
(`start`/`startAudio`/`sendAudio`/`stopAudio`/`close`) declared in
`server/providers/types.ts`. The actual event/type definitions live in `shared/agent.ts`
(`ClientEvent`, `AgentEvent`, `ProviderCapabilities`); `types.ts` re-exports them.
`mock.ts` plays scripted, scenario-specific transcripts, telemetry, and turn-state cycles so
the hands-free HUD can be exercised with no credentials. Add new realtime providers by
implementing `AgentProvider` and wiring them into `selectProvider` in `index.ts`.

### Realtime voice path (Doubao)

`server/providers/doubao.ts` connects to the Volcengine **Doubao Speech / OpenSpeech**
realtime dialogue WebSocket. Full speech-to-speech: browser mic PCM in, synthesized voice PCM
out. It speaks a **custom binary frame protocol** (4-byte header, big-endian uint32
event/length fields, JSON or raw payloads). The `MessageType`/`EventSend`/`EventReceive`
enums and `buildHeader`/`buildFullClientRequest`/`parseDoubaoFrame` define it — keep send and
parse logic in sync. Frame parsing and speaker selection are unit-tested in
`tests/doubao-frame.test.ts` and `tests/doubao-voice.test.ts`.

### Shared modules — the agent's "brains"

The pure logic lives in `shared/` so both providers and the client reuse it, and so it can be
unit-tested without any I/O:

- `shared/agent.ts` — canonical client/server event types, provider capability matrices.
- `shared/ride.ts` — ride modes (骑行/停车/导航/紧急) and demo scenarios (通勤/横风/低油/小队/紧急):
  each mode carries a response style, safety rule, HUD focus, and hazard level that get folded
  into the agent prompt; `combineHazardLevels` fuses ride and weather risk.
- `shared/session.ts` — per-session memory (language, destination, last intent, response
  mode), regex-based intent inference, and the safety/personality/intent prompt builders.
- `shared/audio.ts` — packet-window math for outgoing-FPS / dropped-frame metrics.
- `shared/language.ts` — zh/en detection used to pick browser TTS voices.

`session.start` carries `rideMode`, `scenario`, `voiceGender`, `voicePersonality`, and
optional `lat`/`lon`; providers turn those into prompt context (Doubao) or scripted
scenario output (mock), and emit `ride.context`, `session.memory`, and `telemetry` events
that drive the HUD's 态势摘要 (ride pulse) card and latency readouts.

### Live weather context

`server/weather.ts` fetches current weather from **Open-Meteo** (free, no API key),
classifies rider risk (`assessWeatherRisk` → normal/caution/critical + advice), and returns a
Chinese summary. When `session.start` carries `lat`/`lon` (sent after a geolocation grant),
`doubao.ts` folds the summary into the agent's `system_role` and emits a `weather` event the
HUD renders. If geolocation is denied, the server falls back to `DEFAULT_RIDER_LAT`/`LON` or
a built-in Seoul demo location (`server/config.ts`). Weather is best-effort — a failed lookup
never blocks the session.

### Audio pipeline

- Browser → server: 16 kHz PCM16 mono frames. `public/pcm-worklet.js` is an `AudioWorklet`
  processor that runs off the main thread — it downsamples mic audio to 16 kHz and emits
  320-sample (20 ms) PCM16 frames over its message port. `src/main.tsx` loads it via
  `audioWorklet.addModule("/pcm-worklet.js")` (served statically from `public/`) and forwards
  each frame as a binary WS message.
- Server → browser (Doubao only): 24 kHz PCM16 mono binary frames, scheduled gaplessly via
  `playbackCursorRef`. Active `AudioBufferSourceNode`s are tracked so barge-in can stop them.

### Client resilience and rider controls

All client logic lives in `src/main.tsx` (HUD components in `src/components/`).

- The `/agent` WebSocket auto-reconnects with exponential backoff (`MAX_RECONNECT_ATTEMPTS`
  in `main.tsx`); `intentionalCloseRef` distinguishes a user disconnect from a dropped link.
- Hands-free is one toggle (`startMic`/`stopMic`, also bound to Space): activating it requests
  geolocation, opens the relay, and streams the mic continuously — Doubao's VAD segments
  turns, so the rider never taps again. `stopMic` disables the audio track but keeps the
  graph alive for an instant restart, so transmission is gated by `transmittingRef` and the
  track's `enabled` flag.
- `turnState` (`idle`/`listening`/`hearing`/`thinking`/`speaking`) is derived from server
  `status` events by `mapTurnState` and drives the `HelmetVisual` caption and ring colour.
- Barge-in (`stopAgentSpeech`) cancels browser TTS and stops queued Doubao audio whenever the
  rider starts talking.
- Session-affecting controls (女声/男声 voice gender, personality, ride mode, scenario) are
  fixed at session start, so changing any of them mid-session reconnects the relay
  (`restartSession`) to start a fresh session. When Doubao returns reply text but no audio,
  the browser speaks it with its own TTS (`speak`), picking a voice via `detectLanguage`.
- The HUD keeps the full in-memory transcript, deduplicates repeated entries with
  `normalizeTranscriptText` (mirrored in `doubao.ts` — keep both in sync), and can export the
  log as JSON (`exportTranscriptLog`).
- `src/ErrorBoundary.tsx` wraps the app so a render crash shows a recoverable screen.

### Server config

`server/config.ts` resolves and validates env vars at startup. `validateConfig()` logs a
warning when `VOICE_PROVIDER=doubao` but no Doubao credentials are set; the server still
starts so the mock path stays usable. `index.ts` reads `config` for the provider choice and
the `/health` payload (which reports provider, credential status, and capabilities).

## Configuration

Copy `.env.example` to `.env` (gitignored). Key variables:

- `VOICE_PROVIDER` — `mock` (default) or `doubao`, selects the `/agent` provider.
- `DOUBAO_API_KEY` (+ `DOUBAO_RESOURCE_ID`) — newer Speech-console auth. When empty, the
  legacy `DOUBAO_APP_ID`/`DOUBAO_APP_KEY`/`DOUBAO_ACCESS_KEY` path is used instead.
- `DOUBAO_SYSTEM_ROLE` — the "Max" persona prompt. `DEFAULT_AGENT_SYSTEM_PROMPT` in
  `doubao.ts` is the in-code fallback.
- `DOUBAO_VOICE` / `DOUBAO_VOICE_MALE` — realtime speaker IDs for the 女声/男声 toggle.
- `DEFAULT_RIDER_LAT` / `DEFAULT_RIDER_LON` — fallback weather coordinates when geolocation
  is denied (built-in Seoul demo location if blank).

The persona (name "Max", helmet-assistant role, Chinese/English-only rule, concise hands-free
replies) is defined identically in `DEFAULT_AGENT_SYSTEM_PROMPT` and the `DOUBAO_SYSTEM_ROLE`
default — keep them consistent when changing agent behavior.

## Android app

`android/` is a native Kotlin + Jetpack Compose client (package `com.horizon.maxhelmet`)
that speaks the same `/agent` relay protocol as the web HUD — the Node server needs no
changes to support it. Key mapping: `agent/AgentProtocol.kt` ports `shared/agent.ts` +
`shared/language.ts`, `agent/MicStreamer.kt` ports `public/pcm-worklet.js` (16 kHz PCM16,
20 ms frames), `agent/PcmPlayer.kt` ports the playback scheduling, and
`agent/AgentSession.kt` ports the `useHelmetAgent` hook (reconnect backoff, transcript
dedup, barge-in, TTS fallback). When the relay protocol or these web-side helpers change,
update the Android counterparts too.

Build (Gradle needs JDK ≤ 21 — use Android Studio's bundled JBR, not Homebrew Java):

```bash
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

See `android/README.md` for emulator/device setup and relay URL configuration.

## iOS app

`ios/` is a native Swift + SwiftUI client (bundle id `com.horizon.maxhelmet`) that speaks the
same `/agent` relay protocol as the web HUD and Android app — the Node server needs no changes.
It mirrors the Android two-layer split: `Agent/` is pure protocol + audio + session logic,
`UI/` is the SwiftUI HUD. Key mapping: `Agent/AgentProtocol.swift` ports `shared/agent.ts` +
`shared/ride.ts` + `shared/language.ts` (and `AgentProtocol.kt`), `Agent/MicStreamer.swift`
ports `public/pcm-worklet.js` (16 kHz PCM16, 20 ms frames via `AVAudioEngine`),
`Agent/PcmPlayer.swift` ports the 24 kHz playback scheduling (`AVAudioPlayerNode`),
`Agent/AudioRouter.swift` configures `AVAudioSession` (iOS handles Bluetooth HFP routing), and
`Agent/AgentSession.swift` ports the `useHelmetAgent` hook (reconnect backoff, transcript dedup,
barge-in, `AVSpeechSynthesizer` TTS fallback). Platform differences: the Android foreground
service becomes the `UIBackgroundModes = audio` capability, and there is no manual SCO routing.
When the relay protocol or the web-side helpers change, update the iOS counterparts alongside
the Android ones.

Build: open `ios/MaxHelmet.xcodeproj` in Xcode 16+ and Run (no SPM/CocoaPods deps; iOS 17+).
The target uses a file-system-synchronized group, so new `MaxHelmet/` files need no "add to
target" step. See `ios/README.md` for relay URL and self-signed-cert setup.

## Test server deployment

A shared test box runs on AWS Lightsail (`https://3.35.135.136/`, self-signed cert) with
`VOICE_PROVIDER=doubao`, managed by `pm2` (process `horizon`) behind Caddy. Deployment is an
**rsync push from a developer machine** (the box can't reach the internal GitLab), followed by
`npm install && npm run build && pm2 restart horizon` on the server. The server keeps its own
`.env` — never copy credentials over. Full commands are in README.md ("Deploy to the test
server").
