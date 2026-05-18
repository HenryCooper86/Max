# Horizon Helmet Voice Agent

Prototype AI voice agent for a motorcycle helmet. The app provides a helmet-style rider HUD, microphone streaming demo, Ark-powered command responses, browser speech recognition, and browser text-to-speech playback.

## Current Capabilities

- Helmet HUD with mic, status, latency, noise, navigation, and transcript panels.
- Mock live voice relay over WebSocket for testing the streaming path without production credentials.
- Ark chat command mode through a server-side route so the API key is not exposed to browser code.
- Browser speech recognition for command capture when supported by the browser.
- Browser text-to-speech for agent replies.
- Doubao realtime voice provider for low-latency speech-to-speech sessions.

## Tech Stack

- React 19
- Vite 6
- TypeScript
- Express
- WebSocket relay with `ws`
- Volcengine Ark-compatible chat completions endpoint

## Project Structure

```text
.
├── src/
│   ├── main.tsx              # Helmet HUD and client voice/command logic
│   └── styles.css            # App styling
├── server/
│   ├── index.ts              # Express API and WebSocket relay
│   └── providers/
│       ├── ark.ts            # Ark chat completion client
│       ├── doubao.ts         # Doubao realtime voice provider
│       ├── mock.ts           # Mock live voice provider
│       └── types.ts
├── .env.example              # Environment variable template
├── package.json
└── vite.config.ts
```

## Setup

Install dependencies:

```bash
npm install
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Add your Ark key to `.env`:

```bash
VOICE_PROVIDER=mock
ARK_API_KEY=your-ark-api-key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-1-6-250615
```

Run the app:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

## Using The App

Use `Ask Ark` for the working AI response path:

1. Type a rider command in the command bar.
2. Click `Ask Ark`.
3. The app sends the command to `/ark/chat`.
4. The reply appears in the transcript and is spoken by browser text-to-speech.

Use `Voice Command` if your browser supports the Web Speech API. This captures speech as text, sends it to Ark, and speaks the reply.

Use `Start Voice` to exercise the realtime audio streaming path. In the default configuration, this connects to the mock WebSocket provider and emits simulated rider/agent transcript events. With `VOICE_PROVIDER=doubao`, the backend connects to the Doubao realtime dialogue WebSocket, sends browser mic PCM frames, and relays returned PCM voice audio back to the browser.

## Environment Variables

### Ark Command Mode

```bash
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-1-6-250615
HELMET_AGENT_SYSTEM_PROMPT=You are Horizon, an AI voice agent for a motorcycle helmet. Keep replies short, clear, hands-free, and safety-first.
```

### Realtime Voice Provider

Default:

```bash
VOICE_PROVIDER=mock
```

Doubao realtime voice mode:

```bash
VOICE_PROVIDER=doubao
DOUBAO_AGENT_WS_URL=wss://openspeech.bytedance.com/api/v3/realtime/dialogue
DOUBAO_RESOURCE_ID=volc.speech.dialog
DOUBAO_APP_ID=
DOUBAO_ACCESS_KEY=
DOUBAO_BOT_NAME=Horizon Helmet
DOUBAO_SYSTEM_ROLE=You are a motorcycle helmet voice assistant. Keep replies short, hands-free, and safety-first.
DOUBAO_REALTIME_MODEL=1.2.1.1
DOUBAO_VOICE=zh_female_vv_jupiter_bigtts
```

The Ark API key from Volcengine Ark is not the same credential set as the Doubao realtime speech-dialog WebSocket API. Ark powers the command/reply text path. Doubao realtime voice needs the speech-dialog app credentials above.

## API Routes

### `GET /health`

Returns backend health and selected realtime voice provider.

### `POST /ark/chat`

Request:

```json
{
  "text": "Find the nearest gas station and keep it short."
}
```

Response:

```json
{
  "reply": "Nearest gas is 0.5 miles ahead on the right."
}
```

### `WS /agent`

Browser audio relay endpoint used by `Start Voice`.

Client events:

```json
{ "type": "session.start", "sampleRate": 16000, "channels": 1 }
{ "type": "audio.start" }
{ "type": "audio.stop" }
```

Browser-to-server binary messages are 16 kHz PCM16 mono audio frames. When using Doubao, server-to-browser binary messages are 24 kHz PCM16 mono voice audio frames returned by the realtime API.

## Scripts

```bash
npm run dev       # Run Vite client and Express/WebSocket server
npm run build     # Type-check and build production assets
npm run preview   # Preview built client
```

## Security Notes

- `.env` is ignored by git.
- Ark calls go through the local server so `ARK_API_KEY` is not bundled into frontend JavaScript.
- Do not commit real API keys, app keys, or access tokens.

## Verification

Build:

```bash
npm run build
```

Smoke test Ark:

```bash
curl -s http://localhost:8787/ark/chat \
  -H 'content-type: application/json' \
  -d '{"text":"Nearest gas station, short reply."}'
```

Smoke test health:

```bash
curl -s http://localhost:8787/health
```

## Next Steps

1. Confirm the production Ark model or endpoint ID to use for helmet responses.
2. Replace mock navigation/noise values with real helmet/mobile telemetry.
3. Add proper wake-word flow and push-to-talk behavior.
4. Add interruption controls and richer realtime state labels for Doubao sessions.
