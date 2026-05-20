# Max 摩托车头盔 AI

Prototype AI voice agent for a motorcycle helmet. Max keeps the same name and motorcycle helmet assistant role, speaks Chinese by default, can also use English or Japanese, and refuses other languages. Realtime Doubao voice defaults to the working female Chinese voice.

## Frontend Preview

![Max Motorcycle Helmet AI frontend](docs/assets/frontend-screenshot.png)

## Current Capabilities

- Helmet HUD with mic, status, latency, noise, navigation, and transcript panels.
- Mock live voice relay over WebSocket for testing the streaming path without production credentials.
- Ark chat command mode through a server-side route so the API key is not exposed to browser code.
- Browser speech recognition for command capture when supported by the browser.
- Browser text-to-speech for agent replies.
- Doubao realtime voice provider for low-latency speech-to-speech sessions.
- AudioWorklet mic capture that runs off the main thread for glitch-free streaming.
- Push-to-talk (hold-to-talk) control alongside the latched mic toggle.
- Barge-in: agent speech stops as soon as the rider talks or sends a new command.
- Automatic WebSocket reconnect with exponential backoff if the relay drops.
- Startup config validation that warns about missing Ark or Doubao credentials.

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
│   ├── ErrorBoundary.tsx     # Recoverable screen for render-time crashes
│   └── styles.css            # App styling
├── public/
│   └── pcm-worklet.js        # AudioWorklet: mic downsample + PCM16 framing
├── server/
│   ├── index.ts              # Express API and WebSocket relay
│   ├── config.ts             # Env config resolution and startup validation
│   └── providers/
│       ├── ark.ts            # Ark chat completion client
│       ├── doubao.ts         # Doubao realtime voice provider
│       ├── mock.ts           # Mock live voice provider
│       └── types.ts
├── shared/
│   └── language.ts           # Language gating shared by client and server
├── tests/                    # Vitest unit tests for the pure functions
├── .env.example              # Environment variable template
├── eslint.config.js
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
# Optional: use your Ark endpoint ID here when you have one.
ARK_ENDPOINT_ID=ep-your-endpoint-id
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

Use `询问 Ark` for the working AI response path:

1. Type a rider command in Chinese, English, or Japanese in the command bar.
2. Click `询问 Ark`.
3. The app sends the command to `/ark/chat`.
4. The reply appears in the transcript and is spoken by browser text-to-speech.

Use `语音指令` if your browser supports the Web Speech API. This captures Chinese speech by default, sends it to Ark, and speaks the reply with Chinese browser text-to-speech when supported. If Ark credentials are missing or rejected, the server returns a short local fallback reply by default so the voice flow still responds while credentials are being fixed.

Use `开始语音` to exercise the realtime audio streaming path. In the default configuration, this connects to the mock WebSocket provider and emits simulated rider/agent transcript events. With `VOICE_PROVIDER=doubao`, the backend connects to the Doubao realtime dialogue WebSocket, sends browser mic PCM frames, and relays returned female Chinese PCM voice audio back to the browser.

Use `按住说话` for push-to-talk: the mic transmits only while the button is held and mutes on release. The latched `开始语音` toggle and `按住说话` share the same audio session, so you can mix the two. Whenever the rider starts talking or sends a new command, any in-progress agent speech is interrupted (barge-in).

## Environment Variables

### Ark Command Mode

```bash
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_ENDPOINT_ID=
ARK_MODEL=doubao-seed-1-6-250615
HELMET_AGENT_SYSTEM_PROMPT=你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认使用中文回答；如果骑手明确使用英文，可以用英文回答；如果骑手明确使用日文，可以用日文回答。只允许中文、英文、日文三种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文、English、日本語。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险或分心请求时，给出更安全的替代方案。声音设定为中文女声。
HELMET_AGENT_OFFLINE_FALLBACK=true
```

For Volcengine Ark quick-start usage, `ARK_API_KEY` plus either `ARK_ENDPOINT_ID` (`ep-...`) or a public model ID in `ARK_MODEL` is enough for the app's text command path. `ARK_KEY_ID` is only API-key metadata and is not sent to `/chat/completions`.

Set `HELMET_AGENT_OFFLINE_FALLBACK=false` when you want `/ark/chat` to return HTTP errors instead of local fallback replies.

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
DOUBAO_API_KEY_ID=
DOUBAO_API_KEY=
DOUBAO_APP_ID=
DOUBAO_APP_KEY=
DOUBAO_ACCESS_KEY=
DOUBAO_BOT_NAME=Max
DOUBAO_SYSTEM_ROLE=你是 Max，一位友好、冷静、以安全为先的摩托车头盔 AI 助手。你的名字保持 Max，角色保持 Motorcycle Helmet AI assistant。默认使用中文回答；如果骑手明确使用英文，可以用英文回答；如果骑手明确使用日文，可以用日文回答。只允许中文、英文、日文三种语言，不要使用其他语言。如果骑手使用其他语言或要求你使用其他语言，请用中文简短说明：我只支持中文、English、日本語。帮助骑手处理摩托车相关问题、导航、天气、路况、附近停靠点和骑行安全事项。回答要简短、清晰、适合免手操作。骑行中遇到危险或分心请求时，给出更安全的替代方案。声音设定为中文女声。
DOUBAO_REALTIME_MODEL=1.2.1.1
DOUBAO_INPUT_MODE=keep_alive
DOUBAO_VOICE=zh_female_vv_jupiter_bigtts
```

The Ark API key from Volcengine Ark is not the same credential set as the Doubao realtime speech-dialog WebSocket API. Ark powers the command/reply text path. Doubao realtime voice uses the Doubao Speech/OpenSpeech realtime dialogue endpoint. With the newer Speech console, set `DOUBAO_API_KEY`; the key ID can be stored in `DOUBAO_API_KEY_ID` for reference but is not sent. Legacy app credentials are used only when `DOUBAO_API_KEY` is empty.

## API Routes

### `GET /health`

Returns backend health and selected realtime voice provider.

### `POST /ark/chat`

Request:

```json
{
  "text": "帮我找最近的加油站，简短回答。"
}
```

Response:

```json
{
  "reply": "最近加油站在前方 0.5 英里右侧。"
}
```

### `WS /agent`

Browser audio relay endpoint used by `开始语音`.

Client events:

```json
{ "type": "session.start", "sampleRate": 16000, "channels": 1 }
{ "type": "audio.start" }
{ "type": "audio.stop" }
```

Browser-to-server binary messages are 16 kHz PCM16 mono audio frames. When using Doubao, server-to-browser binary messages are 24 kHz PCM16 mono voice audio frames returned by the realtime API.

## Scripts

```bash
npm run dev          # Run Vite client and Express/WebSocket server
npm run build        # Type-check and build production assets
npm run preview      # Preview built client
npm run lint         # Lint with ESLint
npm run format       # Format with Prettier (format:check to verify only)
npm test             # Run the Vitest unit tests (test:watch for watch mode)
```

## Security Notes

- `.env` is ignored by git.
- Ark calls go through the local server so `ARK_API_KEY` is not bundled into frontend JavaScript.
- Do not commit real API keys, app keys, or access tokens.

## Verification

Build, lint, and test:

```bash
npm run build
npm run lint
npm test
```

Smoke test Ark:

```bash
curl -s http://localhost:8787/ark/chat \
  -H 'content-type: application/json' \
  -d '{"text":"最近的加油站，简短回答。"}'
```

Smoke test health:

```bash
curl -s http://localhost:8787/health
```

## Next Steps

1. Confirm the production Ark model or endpoint ID to use for helmet responses.
2. Replace mock navigation/noise values with real helmet/mobile telemetry.
3. Add a wake-word flow on top of the existing push-to-talk control.
4. Add richer realtime state labels for Doubao sessions.
