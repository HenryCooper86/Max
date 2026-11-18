# Voice Agent SDK

Put a voice agent into any web page. The SDK talks to a voice-agent relay over
WebSocket: it streams the microphone, plays the agent's voice, keeps a
transcript, and runs tools you define in your page.

## Install

**With a bundler** (Vite, Next.js, webpack, …), install the `max-voice-agent` package. It is fully typed and ships
three entry points:

| Import                   | What you get                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `max-voice-agent`        | `VoiceAgent`, `VoiceAgentError`, `defineClientTool` and the types    |
| `max-voice-agent/react`  | `useVoiceAgent` (React 18 or newer is a peer dependency)             |
| `max-voice-agent/widget` | Registers the `<voice-agent>` element (browser only, not during SSR) |

Until the package is published to npm, build it from this repository and install the file:

```bash
npm run pack:sdk                                  # in this repository: writes dist/max-voice-agent-0.1.0.tgz
npm install /path/to/Max/dist/max-voice-agent-0.1.0.tgz   # in your project
```

Maintainers publish with `npm run pack:sdk && cd dist/sdk-package && npm publish`.

**Without a build step**, load it from your relay, which serves the built files at `/sdk/`:

| URL                        | Use it for                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `/sdk/voice-agent.iife.js` | One script tag; defines `<voice-agent>` and `window.VoiceAgentKit` |
| `/sdk/voice-agent.js`      | ES module: `VoiceAgent`, `defineClientTool`                        |

`npm run build:sdk` (part of `npm run build`) produces both.

## Session tokens

Never put the relay's secret in a page. Your backend calls the relay's
`POST /v1/session-tokens` (with `Authorization: Bearer $RELAY_AUTH_TOKEN`) and
hands the browser the short-lived `vst_...` token:

```ts
// your server
app.post("/api/voice-token", async (req, res) => {
  const r = await fetch(`${RELAY}/v1/session-tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 600, userId: req.user.id })
  });
  res.json(await r.json()); // { token, expiresAt }
});
```

Pass the browser a function so every connect and reconnect gets a fresh token:

```ts
token: async () => (await fetch("/api/voice-token", { method: "POST" }).then((r) => r.json())).token;
```

A relay with no auth needs no token.

## Vanilla JavaScript

```ts
import { VoiceAgent } from "max-voice-agent"; // or "https://your-relay/sdk/voice-agent.js"

const agent = new VoiceAgent({
  url: "https://relay.example.com", // http(s)://, ws(s)://, or a full .../agent URL
  token: async () => (await fetch("/api/voice-token", { method: "POST" }).then((r) => r.json())).token,
  language: "en",
  voice: "female",
  context: "The user is on the pricing page."
});

agent.on("transcript", ({ transcript }) => render(transcript));
agent.on("status", (status) => (label.textContent = status));
agent.on("error", (error) => console.error(error.code, error.message));

button.onclick = () => agent.start(); // must run inside a user gesture
stopButton.onclick = () => agent.stop();
```

### Options

| Option          | Type                              | Notes                                                                |
| --------------- | --------------------------------- | -------------------------------------------------------------------- |
| `url`           | `string`                          | Relay base or full `/agent` URL. Required.                           |
| `token`         | `string \| () => Promise<string>` | Function form is called before every (re)connect.                    |
| `language`      | `string`                          | For example `"en"`, `"zh"`.                                          |
| `voice`         | `"female" \| "male"`              |                                                                      |
| `backend`       | `string`                          | Voice backend id; honoured only if the relay allows switching.       |
| `context`       | `string`                          | Facts about your app. Max 2000 characters. Untrusted by the relay.   |
| `tools`         | `ClientTool[]`                    | Up to 32. See below.                                                 |
| `autoReconnect` | `boolean` (true)                  | Exponential backoff, 6 attempts. Idle closes (4001) never reconnect. |
| `speakFallback` | `boolean` (true)                  | Speak with `speechSynthesis` when the relay sends text for that.     |
| `audioContext`  | `AudioContext`                    | Reuse your own context for capture and playback.                     |

### Methods and state

- `start({ microphone? })`: connect and open the mic. Call it from a click or key press so the browser allows audio. Pass `{ microphone: false }` for a text-only session.
- `stop()`: end the conversation and release the mic. The agent can be started again.
- `mute()` / `unmute()`, `muted`
- `sendText(text)`: send a typed turn; returns `false` if there is no live session.
- `setContext(text)`: replaces the context for the **next** session (next `start()` or reconnect). It does not change a running session.
- `interrupt()`: silence the agent immediately.
- `destroy()`: stop, remove listeners, release everything.
- `status`: `idle | connecting | ready | listening | hearing | thinking | speaking | error | closed`. `speaking` comes from what is actually playing, not only from the relay.
- `transcript`: `{ id, role: "user" | "agent", text, final, at }[]`, a new array on every change.
- `capabilities`, `backend`: what the relay reported for the current session.

### Events

Subscribe with `agent.on(name, listener)`; it returns an unsubscribe function. `agent.off(name, listener)` also works.

| Event          | Payload                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `status`       | the new status                                                                       |
| `transcript`   | `{ transcript, item }`: whole list, changed line                                     |
| `message`      | a transcript item, once, when a turn is final                                        |
| `toolcall`     | `{ callId, name, arguments }` for client tools                                       |
| `toolactivity` | relay progress for any tool, server or client                                        |
| `error`        | `VoiceAgentError` with `code`: `microphone`, `token`, `connection`, `relay`, `audio` |
| `level`        | `{ mic, output }`, 0..1, up to ~30 Hz, for visualizers                               |
| `open`         | a session is established (again after each reconnect)                                |
| `close`        | `{ code, reason, willReconnect }`                                                    |

## Tools

Tools run in the page. The agent decides when to call them from the
description; your handler runs, and its return value goes back to the agent.

```ts
import { VoiceAgent, defineClientTool } from "max-voice-agent";

const openPage = defineClientTool<{ path: string }>({
  name: "open_page",
  description: "Navigate the user to a page of this site.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Site path, e.g. /pricing" } },
    required: ["path"]
  },
  handler: ({ path }) => {
    location.assign(path);
    return { ok: true };
  }
});

new VoiceAgent({ url, token, tools: [openPage] });
```

Handlers may be async. A thrown error or rejected promise is reported to the
agent as a tool error, and a handler that takes longer than about 14 seconds
is abandoned with `"timeout"` (the relay allows 15). A call to an unknown tool
is answered with `"unknown tool"`. Nothing a handler does can crash the client.
Tool names match `/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/`; the constructor throws on
invalid or duplicate names. Handlers are never sent to the relay, only the
name, description and parameters.

## React

```tsx
import { useVoiceAgent } from "max-voice-agent/react";

function Assistant() {
  const { status, transcript, start, stop, mute, unmute, isMuted, sendText, level, error } = useVoiceAgent({
    url: "https://relay.example.com",
    token: fetchToken,
    tools: [{ name: "get_cart", description: "Read the cart.", handler: () => cart }]
  });

  return (
    <>
      <button onClick={status === "idle" ? () => start() : stop}>{status === "idle" ? "Talk" : "Stop"}</button>
      <ul>
        {transcript.map((t) => (
          <li key={t.id}>
            {t.role}: {t.text}
          </li>
        ))}
      </ul>
    </>
  );
}
```

The agent is created once and destroyed on unmount, so connection options are
read from the first render. Tool handlers stay fresh: they always call the
latest closure, so reading props and state inside them is safe. The `agent`
field exposes the underlying `VoiceAgent`.

## Script tag

```html
<script
  src="https://relay.example.com/sdk/voice-agent.iife.js"
  data-relay="https://relay.example.com"
  data-token-url="/api/voice-token"
  data-accent="#0a7d5a"
  data-text-input
></script>
```

A `data-relay` attribute appends a floating `<voice-agent>` to the page. Without
it, only the element and `window.VoiceAgentKit` are registered, so you can place
the element yourself:

```html
<voice-agent relay="https://relay.example.com" token-url="/api/voice-token" position="inline" text-input></voice-agent>
<script>
  document.querySelector("voice-agent").tools = [
    { name: "get_time", description: "Current time.", handler: () => new Date().toISOString() }
  ];
  document.addEventListener("voice-agent:transcript", (e) => console.log(e.detail.item));
</script>
```

| Attribute (`data-` on the script) | Meaning                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `relay`                           | Relay base URL.                                                                                                             |
| `token`                           | A fixed token (development only).                                                                                           |
| `token-url`                       | Your endpoint. It is called with POST (GET if POST gets 404/405) before every connect and must return `{ "token": "..." }`. |
| `language`, `voice`, `backend`    | As in the options above.                                                                                                    |
| `context`                         | Facts about the page for the assistant, such as "The visitor is on the pricing page". Read at the next connect.             |
| `label`                           | Accessible name of the button. Default "Talk to the assistant".                                                             |
| `accent`                          | Brand colour, any CSS colour.                                                                                               |
| `position`                        | Bottom right by default; `inline` places it in the page flow.                                                               |
| `text-input`                      | Show a text box in the panel.                                                                                               |

The element has a Shadow DOM, a labelled toggle button (`aria-pressed`) with a
visible focus ring, a live transcript region, Esc to stop, light and dark themes
from `prefers-color-scheme`, and no motion under `prefers-reduced-motion`.
Changing connection attributes takes effect at the next session.

DOM events (bubbling, composed): `voice-agent:status` (`{ status }`),
`voice-agent:transcript` (`{ transcript, item }`), `voice-agent:toolcall`
(`{ callId, name, arguments }`), `voice-agent:error` (`{ error }`).

## Browser support

Needs `WebSocket`, `getUserMedia`, and `AudioContext`, in a secure context
(HTTPS or localhost). Capture uses an AudioWorklet loaded from a Blob URL and
falls back to `ScriptProcessorNode` where worklets are missing. If your Content
Security Policy restricts `script-src`, allow `blob:`. Current Chrome, Edge,
Firefox and Safari (iOS 14.5+) are supported. Browser speech fallback needs
`speechSynthesis`; without it, those replies stay text-only.

## License

[MIT](../LICENSE)
