# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Prototype AI voice agent for a motorcycle helmet ("Max"). A React HUD frontend talks to an
Express/WebSocket backend that relays voice and chat to Volcengine services. The agent speaks
Chinese by default, also handles English and Japanese, and refuses any other language.

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

Smoke tests (server must be running):

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/ark/chat -H 'content-type: application/json' -d '{"text":"最近的加油站，简短回答。"}'
```

## Architecture

Two processes in development. The Vite client proxies `/ark`, `/health`, and `/agent` (WS) to
the backend on `:8787`, so the browser only ever talks to the Vite origin (see `vite.config.ts`).

### Two independent paths, two credential sets

1. **Ark text command path** — `POST /ark/chat` → `server/providers/ark.ts`. Uses the
   Volcengine **Ark** chat-completions API (`ARK_API_KEY`). Handles typed commands and the
   browser Web Speech API voice-command flow. The browser speaks replies with its own TTS.
2. **Doubao realtime voice path** — `WS /agent` → `server/providers/doubao.ts`. Uses the
   separate Volcengine **Doubao Speech / OpenSpeech** realtime dialogue WebSocket (`DOUBAO_*`
   credentials). Full speech-to-speech: browser mic PCM in, synthesized voice PCM out.

These are different Volcengine products with different credentials — do not conflate them.

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
- Mic transmission is gated by `transmittingRef` and the track's `enabled` flag, so the
  latched toggle and the hold-to-talk (push-to-talk) button share one reused audio graph.
- Barge-in (`stopAgentSpeech`) cancels browser TTS and stops queued Doubao audio whenever the
  rider starts talking or sends a new command.
- The 女声/男声 voice toggle sets `voiceGenderRef`. Browser TTS picks a matching voice (with a
  pitch shift when no genuine gendered voice is installed); the live Doubao speaker is chosen
  server-side from `voiceGender` in `session.start`, so switching mid-session reconnects the
  relay (`restartSession`) to start a fresh session with the new speaker.
- `src/ErrorBoundary.tsx` wraps the app so a render crash shows a recoverable screen.

### Language gating

Only Chinese, Japanese, and Latin scripts are accepted. `isSupportedLanguageText` and the
refusal message live in `shared/language.ts`, imported by both `src/main.tsx` and
`server/providers/ark.ts`. Unsupported input short-circuits to the refusal without calling Ark.

### Server config

`server/config.ts` resolves and validates env vars at startup. `validateConfig()` logs
warnings (missing `ARK_API_KEY`, or `VOICE_PROVIDER=doubao` with no Doubao credentials) but
the server still starts so the mock path stays usable. `index.ts` reads `config` for the
provider choice, the `/health` payload, and the offline-fallback decision.

### Offline fallback

When Ark credentials are missing or rejected, `/ark/chat` returns a local canned reply from
`createLocalHelmetReply` (keyword-matched, marked `fallback: true`) instead of an error.
Set `HELMET_AGENT_OFFLINE_FALLBACK=false` to make it fail hard with HTTP 500 instead.

## Configuration

Copy `.env.example` to `.env` (gitignored). Key variables:

- `VOICE_PROVIDER` — `mock` (default) or `doubao`, selects the `/agent` provider.
- `ARK_API_KEY`, `ARK_ENDPOINT_ID` / `ARK_MODEL` — Ark text path. If `ARK_ENDPOINT_ID`
  (`ep-...`) is set it overrides `ARK_MODEL`. Never pass the API-key ID as the model.
- `DOUBAO_API_KEY` (+ `DOUBAO_RESOURCE_ID`) — newer Speech-console auth. When empty, the
  legacy `DOUBAO_APP_ID`/`DOUBAO_APP_KEY`/`DOUBAO_ACCESS_KEY` path is used instead.
- `HELMET_AGENT_SYSTEM_PROMPT` / `DOUBAO_SYSTEM_ROLE` — the "Max" persona prompt for each
  path; `DEFAULT_AGENT_SYSTEM_PROMPT` in `ark.ts` is the in-code fallback for both.

The persona (name "Max", helmet-assistant role, three-language rule, concise hands-free
replies) is defined identically in the system prompt and these env defaults — keep them
consistent when changing agent behavior.
