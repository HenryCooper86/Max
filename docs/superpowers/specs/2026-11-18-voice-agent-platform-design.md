# Voice agent platform: tools, session tokens, embeddable SDK

Date: 2026-11-18

## Goal

Make the kit the go-to way to put a voice agent into any project: a web app, a
mobile app, a device. Until now the kit was a complete product (a wearable
assistant with its own apps). A developer who wanted a voice agent _inside their
own product_ had to fork the web HUD. This design adds the three things that are
missing for that:

1. **Tools**: the agent calls the developer's code or APIs mid-conversation.
2. **Session tokens**: a browser on any site connects without holding the
   relay's secret.
3. **An SDK**: `VoiceAgent` (framework-free), `useVoiceAgent` (React) and a
   one-line `<script>` widget.

Plus a general-purpose `app` device preset so the assistant is not a riding
assistant unless asked to be.

## Protocol additions (`/agent` WebSocket)

All additions are optional and backwards compatible. Existing clients ignore
them.

### Client → relay

`session.start` gains:

| Field     | Type               | Limits                                                                                |
| --------- | ------------------ | ------------------------------------------------------------------------------------- |
| `tools`   | `ClientToolSpec[]` | ≤ 32 tools. Tools the _client_ executes (see `tool.call`).                            |
| `context` | `string`           | ≤ 2000 chars. Facts from the host app ("the user is on the pricing page"). Untrusted. |

```ts
type ClientToolSpec = {
  name: string; // /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
  description: string; // ≤ 1024 chars
  parameters?: object; // JSON Schema object; ≤ 8 KiB serialised. Default: no arguments.
};
```

New events:

```ts
{ type: "tool.result"; callId: string; output?: unknown; error?: string }   // answer to tool.call
{ type: "text.input"; text: string }                                         // ≤ 2000 chars; a typed turn
```

`text.input` is a turn the user typed instead of spoke. It is always addressed
(no wake word), shows up as a final user transcript, and gets a spoken reply.

### Relay → client

```ts
{ type: "tool.call"; callId: string; name: string; arguments: Record<string, unknown> }
{ type: "tool.activity"; callId: string; name: string; where: "server" | "client";
  state: "started" | "succeeded" | "failed"; durationMs?: number; error?: string }
```

`tool.call` is sent only for tools the client declared. The client must answer
with exactly one `tool.result` within 15 s (`TOOL_CALL_TIMEOUT_MS`) or the call
fails with `"timeout"`. `tool.activity` is sent for every tool call, server or
client, so a UI can show "Looking up your order…".

`ProviderCapabilities` gains `tools: boolean` and `textInput: boolean`.

## Server tools

Declared in `assistant.config.json`:

```json
{
  "tools": [
    {
      "name": "get_order_status",
      "description": "Look up an order by its number.",
      "parameters": {
        "type": "object",
        "properties": { "orderId": { "type": "string" } },
        "required": ["orderId"]
      },
      "webhook": {
        "url": "https://api.example.com/voice/order-status",
        "headers": { "Authorization": "Bearer ${ORDER_API_KEY}" },
        "timeoutMs": 8000
      }
    }
  ],
  "toolsModule": "./agent-tools.ts"
}
```

- **Webhook tools**: `POST url` with JSON
  `{ tool, callId, arguments, session: { id, language, userId? } }`. A 2xx JSON
  or text body is the result. Anything else is an error. `${VAR}` in header
  values is replaced from the relay's environment, so secrets stay in `.env`.
  Only `https:` URLs are accepted, plus `http:` to localhost.
- **Code tools**: `toolsModule` is a TS/JS module, resolved relative to the
  config file, whose default export is an array of
  `{ name, description, parameters?, handler(args, ctx) }`. The helper
  `defineTool` / `defineTools` lives in `server/tools/index.ts`.
  `ctx = { callId, sessionId, language, userId?, signal, log }`.
- Name clashes: server tools win over client tools. A duplicate client tool is
  dropped.

Results are serialised (`JSON.stringify` unless already a string) and capped at
16 KiB before they reach the model.

## Engines

`EngineConfig.tools: ToolSpec[]`, `EngineEvents.onToolCall({ callId, name, arguments })`,
`VoiceEngine.sendToolResult?(callId, output)`, `VoiceEngine.sendText?(text)`.

| Engine                     | Tools                                                                                                     | Text input                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenAI/Grok/local realtime | `session.tools`, `response.output_item.done` (function_call) → `function_call_output` + `response.create` | `conversation.item.create` user `input_text` + `response.create` |
| Gemini Live                | `setup.tools.functionDeclarations`, `toolCall` → `toolResponse`                                           | `realtimeInput.text`                                             |
| Pipeline / local           | chat-completions `tools`, streamed `tool_calls`, ≤ 4 rounds per turn                                      | the text replaces the transcribed turn                           |
| Doubao, mock               | not supported (`tools: false`)                                                                            | mock: yes, Doubao: no                                            |

## Session tokens

`POST /v1/session-tokens`, authorised by `Authorization: Bearer $RELAY_AUTH_TOKEN`.

Body (all optional): `{ ttlSeconds?: 30..3600 = 600, userId?: string, context?: string }`.

Response: `{ token: "vst_…", expiresAt: <epoch ms> }`.

The token opens `/agent?token=vst_…` until it expires, so the SDK can reconnect.
It grants nothing else: no admin, no testing data. `userId` and `context` are
stamped onto every session the token opens, and a session's own `context` is
appended after them. Tokens live in memory, so a relay restart revokes them.

## The `app` device preset

`device: "app"` is a general-purpose software assistant. Its user is "the
user", not "the rider". Its prompt carries no riding context, safety modes or
navigation rules. `assistant.config.json` also gains `instructions` (extra
instructions added to the generated persona) and `greeting` (a line spoken when
the microphone first opens).

## SDK (`sdk/`)

- `sdk/src/client.ts`: `VoiceAgent` class (framework-free, browser).
- `sdk/src/react.ts`: `useVoiceAgent(options)` hook.
- `sdk/src/widget.ts`: `<voice-agent>` custom element and auto-mount from a `<script data-…>` tag.
- Built by `vite.sdk.config.ts` into `dist/sdk/`: `voice-agent.js` (ESM),
  `voice-agent.umd.cjs`/IIFE `voice-agent.iife.js` (exposes `window.VoiceAgentKit`),
  `react.js`. The relay serves `dist/sdk/*` at `/sdk/*` with
  `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *`.
