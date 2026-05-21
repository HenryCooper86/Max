# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Prototype AI voice agent for a motorcycle helmet ("Max"). A React HUD frontend talks to an
Express/WebSocket backend that relays realtime voice to Volcengine's Doubao Speech service.
The agent speaks Chinese by default, also handles English and Japanese, and refuses any
other language. The UI is a single live voice agent — no text chat.

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
```

`tsc` runs with `noEmit: true` purely for type-checking `src/`, `server/`, and `shared/`.
Tests live in `tests/` and cover the pure functions; Vitest picks them up with no config.

Smoke test (server must be running):

```bash
curl -s http://localhost:8787/health
```

## Architecture

Two processes in development. The Vite client proxies `/health` and `/agent` (WS) to the
backend on `:8787`, so the browser only ever talks to the Vite origin (see `vite.config.ts`).

### Realtime voice path

`WS /agent` → `server/providers/doubao.ts`. Uses the Volcengine **Doubao Speech /
OpenSpeech** realtime dialogue WebSocket (`DOUBAO_*` credentials). Full speech-to-speech:
browser mic PCM in, synthesized voice PCM out. This is the only agent path.

### WebSocket relay and the provider pattern

`server/index.ts` accepts browser WS connections on `/agent` and, per connection, picks a
provider via `VOICE_PROVIDER`: `mock` (default) or `doubao`. Both implement the `AgentProvider`
interface in `server/providers/types.ts` (`start`/`startAudio`/`sendAudio`/`stopAudio`/`close`).
`mock.ts` emits scripted transcript/metric events for testing the streaming path without
credentials. Add new realtime providers by implementing `AgentProvider` and wiring them into
`selectProvider`.

### Audio pipeline

- Browser → server: 16 kHz PCM16 mono frames. `public/pcm-worklet.js` is an `AudioWorklet`
  processor that runs off the main thread — it downsamples mic audio to 16 kHz and emits
  320-sample (20 ms) PCM16 frames over its message port. `src/main.tsx` loads it via
  `audioWorklet.addModule("/pcm-worklet.js")` (served statically from `public/`) and forwards
  each frame as a binary WS message.
- Server → browser (Doubao only): 24 kHz PCM16 mono binary frames, scheduled gaplessly via
  `playbackCursorRef`. Active `AudioBufferSourceNode`s are tracked so barge-in can stop them.
- `doubao.ts` speaks a **custom binary frame protocol** (4-byte header, big-endian uint32
  event/length fields, JSON or raw payloads). The `MessageType`/`EventSend`/`EventReceive`
  enums and `buildHeader`/`parseDoubaoFrame` define it — keep send and parse logic in sync.

### Client resilience and rider controls

- The `/agent` WebSocket auto-reconnects with exponential backoff (`MAX_RECONNECT_ATTEMPTS`
  in `main.tsx`); `intentionalCloseRef` distinguishes a user disconnect from a dropped link.
- A single mic toggle (`startMic`/`stopMic`) starts and stops listening and auto-connects the
  relay on first use. `stopMic` disables the audio track but keeps the graph alive for an
  instant restart, so transmission is gated by `transmittingRef` and the track's `enabled` flag.
- Barge-in (`stopAgentSpeech`) cancels browser TTS and stops queued Doubao audio whenever the
  rider starts talking.
- The 女声/男声 voice toggle sets `voiceGenderRef`. The live Doubao speaker is chosen
  server-side from `voiceGender` in `session.start`, so switching mid-session reconnects the
  relay (`restartSession`) to start a fresh session with the new speaker. When Doubao returns
  reply text but no audio, the browser speaks it with its own TTS (`speak`), picking a voice
  via `detectLanguage` in `shared/language.ts`.
- `src/ErrorBoundary.tsx` wraps the app so a render crash shows a recoverable screen.

### Server config

`server/config.ts` resolves and validates env vars at startup. `validateConfig()` logs a
warning when `VOICE_PROVIDER=doubao` but no Doubao credentials are set; the server still
starts so the mock path stays usable. `index.ts` reads `config` for the provider choice and
the `/health` payload.

## Configuration

Copy `.env.example` to `.env` (gitignored). Key variables:

- `VOICE_PROVIDER` — `mock` (default) or `doubao`, selects the `/agent` provider.
- `DOUBAO_API_KEY` (+ `DOUBAO_RESOURCE_ID`) — newer Speech-console auth. When empty, the
  legacy `DOUBAO_APP_ID`/`DOUBAO_APP_KEY`/`DOUBAO_ACCESS_KEY` path is used instead.
- `DOUBAO_SYSTEM_ROLE` — the "Max" persona prompt. `DEFAULT_AGENT_SYSTEM_PROMPT` in
  `doubao.ts` is the in-code fallback.
- `DOUBAO_VOICE` / `DOUBAO_VOICE_MALE` — realtime speaker IDs for the 女声/男声 toggle.

The persona (name "Max", helmet-assistant role, three-language rule, concise hands-free
replies) is defined identically in `DEFAULT_AGENT_SYSTEM_PROMPT` and the `DOUBAO_SYSTEM_ROLE`
default — keep them consistent when changing agent behavior.
