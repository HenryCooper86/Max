# Max: realtime voice agents for any product

[![CI](https://github.com/HenryCooper86/Max/actions/workflows/ci.yml/badge.svg)](https://github.com/HenryCooper86/Max/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Max is an open kit for putting a talking, listening AI agent into your own product: a website, a web or mobile app,
a kiosk, a wearable. You run one small relay server. It holds your API keys, talks to the voice model you choose, and
gives every client the same simple WebSocket protocol. Your pages add the agent with one script tag, a React hook or a
few lines of JavaScript, and the agent can call your own code and APIs while it talks.

```html
<script src="https://voice.example.com/sdk/voice-agent.iife.js"></script>
<voice-agent relay="https://voice.example.com" token-url="/api/voice-token"></voice-agent>
```

- **Any voice model, one interface.** OpenAI Realtime, Google Gemini Live, xAI Grok Voice, ByteDance Doubao, a cascaded
  speech-to-text → any chat model → text-to-speech pipeline, or fully local open-weight models. Switch with one
  environment variable; your clients do not change.
- **Tools.** The agent looks things up and takes actions mid-sentence: functions in your relay, webhooks to any backend
  in any language (HMAC-signed), or functions in the page itself (scroll, fill a form, add to cart).
- **Production details handled.** Barge-in, echo cancellation, gapless playback, reconnects that keep the
  conversation, typed input, live captions, latency telemetry, short-lived session tokens so browsers never see a
  secret, origin allowlists and rate limits.
- **Every platform.** A web SDK with a ready-made widget, native iOS and Android clients, a Python reference device
  client and an embedded Linux client, all speaking the same [documented protocol](docs/protocol.md).
- **Try it with no keys.** The keyless demo backend runs the whole loop, tools included, before you sign up for
  anything.

## Quick start

You need Node.js 22.13 or newer.

```bash
git clone https://github.com/HenryCooper86/Max.git && cd Max
npm install
npm run build:sdk
```

Start the relay with the example shop assistant, using the keyless demo backend. The relay token is the secret your
own backend uses to mint short-lived tokens for browsers; any random string works locally:

```bash
RELAY_AUTH_TOKEN=dev-relay-secret TOOL_WEBHOOK_SECRET=dev-secret \
  ASSISTANT_CONFIG=examples/web-embed/assistant.config.json VOICE_PROVIDER=mock npx tsx server/index.ts
```

In a second terminal, start the example shop (your "own product") with the same two secrets:

```bash
RELAY_AUTH_TOKEN=dev-relay-secret TOOL_WEBHOOK_SECRET=dev-secret node examples/web-embed/server.mjs
```

Open <http://localhost:3000>, press the microphone button and, since the demo backend cannot understand speech, type `check stock {"product": "Trail Runner 2"}`. The
relay calls a code tool. `get_order_status {"orderId": "A-1042"}` calls a signed webhook on the shop's backend, and
`show_product {"product": "storm-shell-jacket"}` runs a tool inside the page.

To talk for real, restart the relay with a real backend:

```bash
RELAY_AUTH_TOKEN=dev-relay-secret TOOL_WEBHOOK_SECRET=dev-secret ASSISTANT_CONFIG=examples/web-embed/assistant.config.json \
  VOICE_PROVIDER=openai OPENAI_API_KEY=sk-... npx tsx server/index.ts
```

Now ask out loud: "Where is my order A-1042?" The full walkthrough, including your own assistant and production
setup, is in [getting started](docs/getting-started.md).

## Add the agent to your app

**One script tag.** The relay serves the SDK at `/sdk/`. The widget is a floating microphone button with a live
transcript and an optional text box.

```html
<script src="https://voice.example.com/sdk/voice-agent.iife.js"></script>
<voice-agent relay="https://voice.example.com" token-url="/api/voice-token" text-input></voice-agent>
```

**React.** Install the typed SDK package:

```bash
npm install max-voice-agent
```

```tsx
import { useVoiceAgent } from "max-voice-agent/react";

function Assistant() {
  const { status, transcript, start, stop } = useVoiceAgent({ url: "https://voice.example.com", token: fetchToken });
  return (
    <>
      <button onClick={status === "idle" ? start : stop}>{status === "idle" ? "Talk" : "Stop"}</button>
      {transcript.map((line) => (
        <p key={line.id}>
          {line.role}: {line.text}
        </p>
      ))}
    </>
  );
}
```

**Plain JavaScript**, for your own UI:

```js
import { VoiceAgent } from "max-voice-agent"; // or straight from your relay: https://voice.example.com/sdk/voice-agent.js

const agent = new VoiceAgent({ url: "https://voice.example.com", token: fetchToken, language: "en" });
agent.on("transcript", ({ transcript }) => render(transcript));
agent.on("status", (status) => (statusLabel.textContent = status));
talkButton.onclick = () => agent.start(); // from a click: browsers need a gesture for the microphone
```

`fetchToken` asks _your_ backend for a short-lived session token, which your backend mints with the relay's secret.
The [SDK reference](sdk/README.md) covers every option, event and method. Native apps and devices use the
[protocol](docs/protocol.md) directly.

## Give it tools

Tools are how the agent does real work. Declare them once and every voice backend that supports function calling can
use them.

```ts
// agent-tools.ts: runs inside the relay ("toolsModule" in assistant.config.json)
import { defineTool, defineTools } from "./server/tools";

export default defineTools([
  defineTool<{ orderId: string }>({
    name: "get_order_status",
    description: "Look up an order by its number, for example A-1042.",
    parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    async handler({ orderId }, { userId, signal }) {
      return orders.lookup(orderId, { owner: userId, signal });
    }
  })
]);
```

```json
// assistant.config.json: a webhook tool, served by any backend in any language
{
  "tools": [
    {
      "name": "book_table",
      "description": "Book a table for a number of people at a time.",
      "parameters": {
        "type": "object",
        "properties": { "people": { "type": "integer" }, "time": { "type": "string" } },
        "required": ["people", "time"]
      },
      "webhook": { "url": "https://api.example.com/voice/book-table", "secret": "${BOOKING_WEBHOOK_SECRET}" }
    }
  ]
}
```

```js
// In the page: tools only the client can run
agent.tools = [
  {
    name: "add_to_cart",
    description: "Add a product to the shopping cart.",
    parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    handler: ({ sku }) => cart.add(sku)
  }
];
```

The [tools guide](docs/tools.md) covers arguments, errors, timeouts, signatures and how to write tools a model uses
well.

## Choose a voice backend

| `VOICE_PROVIDER` | Backend                                                            | Needs                                  | Tools |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------- | ----- |
| `mock`           | Keyless demo (speech detection, typed turns, real tool calls)      | nothing                                | yes¹  |
| `openai`         | OpenAI Realtime, speech to speech                                  | `OPENAI_API_KEY`                       | yes   |
| `gemini`         | Google Gemini Live, speech to speech                               | `GEMINI_API_KEY`                       | yes   |
| `grok`           | xAI Grok Voice, speech to speech                                   | `XAI_API_KEY`                          | yes   |
| `doubao`         | ByteDance Doubao realtime voice, strongest in Chinese              | `DOUBAO_API_KEY`                       | no    |
| `pipeline`       | Speech-to-text → any OpenAI-compatible chat model → text-to-speech | `PIPELINE_API_KEY` or `OPENAI_API_KEY` | yes   |
| `local`          | The same pipeline on your own hardware (Whisper, Ollama, Kokoro)   | `LOCAL_VOICE=on`                       | yes   |
| `local-realtime` | A self-hosted server that speaks the OpenAI Realtime protocol      | `LOCAL_REALTIME_URL`                   | yes   |

¹ For `"device": "app"` assistants. The stock helmet assistant's demo is a scripted ride.

Models, voices and endpoints are all overridable; see [voice backends](docs/backends.md) and
[running locally](docs/local-models.md). Clients may pick a backend per session when the relay allows it.

## How it works

```text
 Your page / app / device                     Relay (this repo, Node.js)                  Voice model
 ┌───────────────────────┐   WebSocket /agent  ┌───────────────────────────────┐  vendor   ┌─────────────────┐
 │ <voice-agent>, SDK,   │ ──── mic PCM16 ───▶ │ auth: session tokens, origins │ ────────▶ │ OpenAI Realtime │
 │ iOS, Android, Python  │ ◀── voice PCM16 ─── │ session core: turns, barge-in,│ ◀──────── │ Gemini Live,    │
 │ client tools          │ ◀─ JSON events ───▶ │ wake word, memory, captions   │           │ Grok, Doubao,   │
 └───────────────────────┘   tool.call/result  │ tools: code, webhooks, client │           │ pipeline, local │
            ▲                                  └───────────────┬───────────────┘           └─────────────────┘
            │ session token                                    │ webhook (HMAC-signed)
 ┌──────────┴────────────┐                                     ▼
 │ Your backend          │ ◀──────────────────────────── your APIs and data
 └───────────────────────┘
```

Browsers and apps never hold a model key. Each connection gets its own session on the backend you chose. Everything a
user experiences as "the assistant", from turn-taking and interruptions to tool calls and captions, lives in one shared
session core, so it behaves the same whichever model is plugged in.

## Make it yours

Everything about the assistant lives in one file, `assistant.config.json`: its name, what it is for (`"device": "app"`
for a software assistant), its instructions, greeting, languages, voice, look and tools. Run `npm run setup` for an
interactive wizard, or edit it in the browser at Admin → Studio. The [configuration reference](docs/configuration.md)
lists every key.

```json
{
  "name": "Ava",
  "device": "app",
  "languages": ["en"],
  "greeting": "Hi, I'm Ava. What can I help you with?",
  "instructions": "You are the voice assistant of the Acme Outdoor web shop. Prices are in US dollars.",
  "toolsModule": "./agent-tools.ts"
}
```

With no config file the relay runs **Max**, the motorcycle-helmet assistant this kit grew out of, with its iOS,
Android and embedded clients, navigation, camera and hazard alerts. That reference product is documented in
[docs/max-helmet.md](docs/max-helmet.md).

## Documentation

| Guide                                      | What it covers                                                       |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | From clone to a voice agent in your own app, then to production      |
| [Web SDK](sdk/README.md)                   | Widget, `VoiceAgent`, React hook, events, client tools               |
| [Tools](docs/tools.md)                     | Code, webhook and client tools; signatures; writing good tools       |
| [Configuration](docs/configuration.md)     | Every `assistant.config.json` key and the main environment variables |
| [Voice backends](docs/backends.md)         | Each backend, its settings, and adding your own                      |
| [Protocol](docs/protocol.md)               | The `/agent` WebSocket protocol, for custom clients in any language  |
| [Security](docs/security.md)               | Session tokens, origins, webhook signing, prompt-injection advice    |
| [Deployment](docs/deployment.md)           | Docker, TLS reverse proxies, scaling, health checks                  |
| [Hardware and audio](docs/audio/README.md) | Putting the agent on your own device: audio contract and test bench  |
| [Running locally](docs/local-models.md)    | Open-weight speech and chat models on your own machine               |
| [Examples](examples/README.md)             | The web shop example and the Python device client                    |

## Project layout

```text
server/            The relay: auth, session core, voice engines, tools, Studio
  providers/live/  One file per voice engine, plus the shared session core
  tools/           Tool definitions, webhook runner, per-session broker
sdk/               Browser SDK: VoiceAgent, React hook, <voice-agent> widget
shared/            Protocol types shared by the relay and the web clients
protocol/          JSON Schema of the protocol; generates TS, Kotlin and Swift constants
src/               The relay's own web app: landing page, Studio, admin, helmet HUD
examples/          Runnable examples
ios/ android/ rdk/ Native and embedded clients of the reference helmet assistant
```

## Development

```bash
npm run dev     # relay on :8787 and the web app on :5173 with hot reload
npm test        # unit tests
npm run check   # everything CI runs: protocol, format, lint, dead code, types, tests, build
```

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security issues privately as
described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Use it in commercial and open-source products alike.
