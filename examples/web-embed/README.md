# Web embed example

A fictional web shop, "Acme Outdoor", with a voice assistant added by one `<script>` tag. It shows the three parts of a
real integration end to end:

| Part                | Where                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Your page           | [`index.html`](index.html) loads the SDK from the relay and adds `<voice-agent>`.        |
| Your backend        | [`server.mjs`](server.mjs) mints session tokens and receives a signed webhook tool call. |
| The relay and tools | [`assistant.config.json`](assistant.config.json) and [`agent-tools.ts`](agent-tools.ts). |

The assistant has three tools: `get_order_status` (a webhook to `server.mjs`), `check_stock` (code that runs inside the
relay) and `show_product` (a client tool that runs in the page and scrolls to a product).

## Run it

You need Node 22.13 or newer and the repository's dependencies. From the repository root:

```bash
npm ci
npm run build:sdk
```

Pick two secrets and use the same values in both terminals:

```bash
export RELAY_AUTH_TOKEN=$(openssl rand -hex 16)
export TOOL_WEBHOOK_SECRET=$(openssl rand -hex 16)
```

Terminal 1: the relay, with the keyless demo backend.

```bash
ASSISTANT_CONFIG=examples/web-embed/assistant.config.json VOICE_PROVIDER=mock \
  RELAY_AUTH_TOKEN=$RELAY_AUTH_TOKEN TOOL_WEBHOOK_SECRET=$TOOL_WEBHOOK_SECRET \
  npx tsx server/index.ts
```

Terminal 2: "your backend" and the page.

```bash
RELAY_AUTH_TOKEN=$RELAY_AUTH_TOKEN TOOL_WEBHOOK_SECRET=$TOOL_WEBHOOK_SECRET \
  node examples/web-embed/server.mjs
```

Open <http://localhost:3000>.

The page never sees `RELAY_AUTH_TOKEN`. It asks `POST /api/voice-token` on the example backend, which calls the relay's
`POST /v1/session-tokens` and returns a short-lived token.

## What to try

With `VOICE_PROVIDER=mock` the relay cannot understand speech, so use the text box in the widget. The demo runs a tool
when you type its name, optionally followed by JSON arguments:

- `get_order_status {"orderId":"A-1042"}`: the relay POSTs a signed request to the example backend, which answers from a
  small table. Try `A-1043` too, and an unknown number to see an error reach the assistant.
- `check_stock {"product":"Summit 40 backpack"}`: a code tool inside the relay.
- `show_product {"product":"storm-shell-jacket"}`: a client tool. The relay sends a `tool.call` to the page, the page
  scrolls to the card and answers with a `tool.result`.

Open the browser console to see each `voice-agent:toolcall` event. In `server.mjs`, change the signature secret and
see the webhook call fail with `bad signature`.

## Use a real backend

Stop the relay in terminal 1 and start it with a real backend and key:

```bash
ASSISTANT_CONFIG=examples/web-embed/assistant.config.json VOICE_PROVIDER=openai OPENAI_API_KEY=sk-... \
  RELAY_AUTH_TOKEN=$RELAY_AUTH_TOKEN TOOL_WEBHOOK_SECRET=$TOOL_WEBHOOK_SECRET \
  npx tsx server/index.ts
```

Reload the page, press the microphone button and ask "Where is my order A-1042?", "Is the Summit 40 backpack in stock?"
or "Show me the jacket." The model now chooses the tools itself. Other backends are listed in
[backends](../../docs/backends.md).

## Adapt it

- Change the persona, greeting and tools in `assistant.config.json`. The reference is in [tools](../../docs/tools.md).
- Replace `ORDERS` in `server.mjs` with a call to your own API. Authorise by the `userId` the token carries
  (`demo-shopper` here): see [security](../../docs/security.md).
- For a framework app, use the React hook or the `VoiceAgent` class from the [SDK](../../sdk/README.md) instead of the
  widget.
