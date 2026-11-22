# Voice Agent SDK

Put a voice agent into any web page. The SDK talks to a voice-agent relay over
WebSocket: it streams the microphone, plays the agent's voice, keeps a
transcript, and runs tools you define in your page.

## Install

**With a bundler** (Vite, Next.js, webpack, …), install the [`max-voice-agent`](https://www.npmjs.com/package/max-voice-agent)
package. It is fully typed and ships three entry points:

| Import                   | What you get                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `max-voice-agent`        | `VoiceAgent`, `VoiceAgentError`, `defineClientTool` and the types                        |
| `max-voice-agent/react`  | `useVoiceAgent` (React 18 or newer is a peer dependency)                                 |
| `max-voice-agent/widget` | Registers the `<voice-agent>` element (importing it during SSR is safe; it does nothing) |

```bash
npm install max-voice-agent
```

The package is **ESM-only**. Every entry has `types`, `import` and `default` conditions, so bundlers, Node and tools
that do not set `import` all resolve it. There is no CommonJS build: a `require` build would need a second set of type
declarations, and Node 22.12 and newer can `require()` an ES module anyway. If something goes wrong, see
[troubleshooting](../docs/troubleshooting.md).

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

| Option          | Type                              | Notes                                                                                     |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `url`           | `string`                          | Relay base or full `/agent` URL. Required.                                                |
| `token`         | `string \| () => Promise<string>` | Function form is called before every (re)connect.                                         |
| `language`      | `string`                          | For example `"en"`, `"zh"`.                                                               |
| `voice`         | `"female" \| "male"`              |                                                                                           |
| `backend`       | `string`                          | Voice backend id; honoured only if the relay allows switching.                            |
| `context`       | `string`                          | Facts about your app. Max 2000 characters. Untrusted by the relay.                        |
| `tools`         | `ClientTool[]`                    | Up to 32. See below.                                                                      |
| `transport`     | `"websocket" \| "webrtc"`         | `"webrtc"` sends audio over UDP where the relay offers it. See [WebRTC](#webrtc).         |
| `iceServers`    | `RTCIceServer[]`                  | STUN and TURN servers for `transport: "webrtc"`. Rarely needed.                           |
| `autoReconnect` | `boolean` (true)                  | Exponential backoff, 6 attempts. See [Errors and reconnecting](#errors-and-reconnecting). |
| `speakFallback` | `boolean` (true)                  | Speak with `speechSynthesis` when the relay sends text for that.                          |
| `audioContext`  | `AudioContext`                    | Reuse your own context for capture and playback.                                          |

### Methods and state

- `start({ microphone? })`: connect and open the mic. Call it from a click or key press so the browser allows audio. Pass `{ microphone: false }` for a text-only session.
- `stop()`: end the conversation and release the mic. The agent can be started again.
- `mute()` / `unmute()`, `muted`
- `sendText(text)`: send a typed turn; returns `false` if there is no live session.
- `sendImage(source, { text?, maxSide? })`: show the agent a picture; resolves to `false` if there is no live session or
  the relay does not take pictures. See [Pictures](#pictures).
- `startVideo(source?, { intervalMs?, maxSide?, facingMode? })` / `stopVideo()`, `videoSource`, `videoStream`: show the
  agent the camera or the screen while the conversation goes on. See [Live video](#live-video).
- `setContext(text)`: replaces the context for the **next** session (next `start()` or reconnect). It does not change a running session.
- `interrupt()`: silence the agent immediately.
- `resumeAudio()`: resume audio the browser blocked; call it from a click. Resolves to whether audio is running. `audioBlocked` tells you if it is needed.
- `destroy()`: stop, remove listeners, release everything.
- `status`: `idle | connecting | ready | listening | hearing | thinking | speaking | error | closed`. `speaking` comes from what is actually playing, not only from the relay.
- `transcript`: `{ id, role: "user" | "agent", text, final, at }[]`, a new array on every change.
- `capabilities`, `backend`: what the relay reported for the current session.
- `transport`: `"websocket"` or `"webrtc"`, whichever carries the current session; `undefined` when there is none.
- `agent`: the id of the agent the conversation is with, once the assistant has handed it over; `undefined` while it is with the agent every conversation starts with, and when the assistant has no [agents](../docs/conversations.md#several-agents-and-handing-over).

### Events

Subscribe with `agent.on(name, listener)`; it returns an unsubscribe function. `agent.off(name, listener)` also works.

| Event          | Payload                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `status`       | the new status                                                                                      |
| `transcript`   | `{ transcript, item }`: whole list, changed line                                                    |
| `message`      | a transcript item, once, when a turn is final                                                       |
| `toolcall`     | `{ callId, name, arguments }` for client tools                                                      |
| `toolactivity` | relay progress for any tool, server or client                                                       |
| `error`        | `VoiceAgentError`; its `code` is listed under [Errors and reconnecting](#errors-and-reconnecting)   |
| `warning`      | `{ code, message }`: `audio_blocked`, `protocol_mismatch` or `webrtc_unavailable` (see below)       |
| `audioresume`  | blocked audio can play now                                                                          |
| `level`        | `{ mic, output }`, 0..1, up to ~30 Hz, for visualizers                                              |
| `open`         | a session is established (again after each reconnect)                                               |
| `ended`        | `{ reason }`: the relay ended the conversation (`agent`, `idle` or `max_duration`); `close` follows |
| `agentchange`  | `{ agent }`: the conversation moved to another of the assistant's agents                            |
| `close`        | `{ code, reason, willReconnect }`                                                                   |

The warning codes: `audio_blocked` (the browser is holding audio back; call `resumeAudio()` from a click),
`protocol_mismatch` (the relay is newer than this SDK; see [Versions](#versions)) and `webrtc_unavailable`
(`transport: "webrtc"` could not be used and the session runs over the WebSocket).

## WebRTC

By default audio travels over the WebSocket. On a poor mobile network a lost packet then stalls the agent's voice.
With `transport: "webrtc"` audio travels over UDP as Opus, and the browser conceals lost packets.

```ts
const agent = new VoiceAgent({ url: "https://relay.example.com", token, transport: "webrtc" });
```

The relay must have it turned on (`WEBRTC=on`, see [WebRTC transport](../docs/webrtc.md)). Where it cannot be used
(the relay does not offer it, or the network blocks UDP) the SDK connects over the WebSocket instead and emits a
`webrtc_unavailable` warning, so it is safe to ask for it everywhere. `agent.transport` tells you which one a session
got. Everything else in this README applies to both.

## Pictures

`agent.sendImage(source, options?)` shows the agent a picture: a screenshot, a photo. The conversation's own model sees
it.

- `source`: a `Blob` or `File`, an `HTMLCanvasElement`, `HTMLImageElement` or `HTMLVideoElement` (its current frame), an
  `ImageBitmap`, or a `data:` URL string.
- `options.text`: words to send with it. Then it is a typed turn with the picture attached, and the agent answers
  aloud. Without `text` the picture joins the conversation silently: the agent does not answer it, and sees it with
  your user's next spoken or typed turn.
- `options.maxSide`: the longer side in pixels, 1024 by default. The picture is drawn to a canvas at that size, encoded
  as JPEG, and re-encoded at lower quality and then smaller until it fits the relay's limit of 240,000 base64
  characters. If it cannot be made to fit, or the source cannot be read, the promise rejects with a `VoiceAgentError`
  whose `code` is `image`.
- It resolves to `true` when the picture was sent, and to `false` when the session is not ready or the relay does not
  take pictures (`agent.capabilities?.imageInput` is not `true`). Check that first to decide whether to show a button.

The relay allows one picture a second and 50 per connection (a reconnect starts a new count), and answers a faster one
with an `error` event (the `relay` error code). A `sendImage` call made while another is still encoding, or less than a
second after the last one, resolves to `false` and sends nothing. The same call works over the WebSocket and over [WebRTC](#webrtc): the picture is one JSON
event.

```ts
// A file input
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (file) await agent.sendImage(file, { text: "What does this error mean?" });
});
```

```ts
// The camera: show the agent what the user is holding
const video = document.querySelector("video")!;
video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
await video.play();
await agent.sendImage(video, { text: "What is this?" }); // this frame only; it is not a video stream
```

The picture goes to the model's vendor and the relay does not write it to conversation records, logs, traces, resume state or memory. Which backends take pictures, and the settings
that turn it on for chat-model backends, are in [voice backends](../docs/backends.md#pictures).
The widget has a button for it: see [`image-input`](#script-tag). The iOS and Android clients have one too.

## Live video

`agent.startVideo(source?, options?)` shows the agent what the camera or the screen shows while the conversation goes
on, so the user can ask "what am I holding?" or "why is this page not loading?" without sending anything by hand.

```ts
cameraButton.onclick = async () => {
  if (agent.videoSource) return agent.stopVideo();
  const stream = await agent.startVideo("camera"); // or "screen", or a MediaStream you already have
  if (stream) preview.srcObject = stream; // a <video muted playsinline autoplay>, so the user sees what the agent sees
};
agent.on("video", ({ active }) => {
  if (!active) preview.srcObject = null;
});
```

- `source`: `"camera"` (the default), `"screen"` (the browser asks the user what to share), or a `MediaStream` of your
  own, for example `canvas.captureStream()`. A stream you pass in is left running when the video stops; a camera or a
  screen the SDK opened is turned off.
- `intervalMs`: the time between two frames, 1000 by default and never under 500. `maxSide`: the longer side of a
  frame, 768 pixels by default. `facingMode`: `"user"` (the default) or `"environment"` for a phone's back camera.
- It resolves to the stream, or to `null` when there is no ready session, the relay does not take video
  (`agent.capabilities?.videoInput` is not `true`), or the conversation ended while the browser was asking the user.
  It rejects with a `VoiceAgentError` whose `code` is `video` when the camera or the screen cannot be opened, which is
  also what the user's "no" looks like. Call it from a click: browsers ask for a camera or a screen only then.
- The video stops with `stopVideo()`, when the conversation ends, and when the user stops sharing in the browser's own
  controls. The `video` event (`{ active, source? }`) fires each time. Across a reconnect it stays on and frames go out
  again once the new session is ready.

Each frame is a small JPEG sent to the relay, which keeps the newest only; the model sees it with the user's next turn
(on Gemini Live, as it arrives). Frames go to the model's vendor and are not written to conversation records, logs,
traces, resume state or memory. The model looks when it is spoken to: it does not watch for motion or speak up by
itself. Details per backend are in [voice backends](../docs/backends.md#live-video). The widget has buttons for it:
see [`video-input`](#script-tag).

## Errors and reconnecting

`start()` rejects with, and the `error` event delivers, a `VoiceAgentError`. Branch on `error.code`:

| `code`         | When                                                                                                  | `closeCode` |
| -------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| `microphone`   | The browser refused the microphone or there is none. The original error is `error.cause`.             |             |
| `token`        | Your token function (or the public-agent request) failed.                                             |             |
| `connection`   | The relay could not be reached, timed out, or closed the connection for any other reason.             | when closed |
| `unauthorized` | The relay closed with 1008: it does not accept the credentials.                                       | `1008`      |
| `usage_limit`  | The relay closed with 4003: this account's voice minutes are used up.                                 | `4003`      |
| `relay`        | The relay sent an `error` event. The session may continue.                                            |             |
| `audio`        | Decoding or playing the agent's audio failed.                                                         |             |
| `image`        | `sendImage` could not read the picture or make it small enough. Rejects that call only.               |             |
| `video`        | `startVideo` could not open the camera or the screen (often the user's "no"). Rejects that call only. |             |

`unauthorized` and `usage_limit` are new in 0.2.0. Before, both surfaced as `connection`, and a microphone refusal also
surfaced as `connection`. The old codes keep their meaning for everything else. If your code treats `connection` as "the
relay hung up, try later", add these cases: retrying either one cannot succeed. `error.closeCode` carries the WebSocket
close code whenever there is one, so `error.closeCode !== undefined` still catches every close-driven failure in one
check. The same codes are used on the first connect and on a reconnect, and a failure also ends in status `error`.

Reconnect rules (with `autoReconnect: true`, the default):

| What happened                            | What the SDK does                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| First connect fails (any close, timeout) | Rejects `start()`; no automatic retry, except for 1008 below.                                   |
| Connection drops mid-session (1006 etc.) | Retries up to 6 times, waiting 1 s, 2 s, 4 s, then 8 s; the count resets once a session starts. |
| 1001, 1011                               | Same as above: the relay is restarting or its backend failed.                                   |
| 1008, token function or `project`        | Retries once with a freshly fetched token, then stops with `unauthorized`.                      |
| 1008, static `token` or no token         | Stops at once with `unauthorized`: the same token would be refused again.                       |
| 4001 (idle)                              | Never reconnects; status `closed`, no error. Call `start()` again.                              |
| The relay ended the conversation         | `ended` fires, then `close` with `willReconnect: false`. Never reconnects; status `closed`.     |
| 4003                                     | Never reconnects; `usage_limit`.                                                                |

A reconnect carries the conversation on. The relay gives each session a `resume` id, the SDK keeps it, and every
automatic reconnect sends it back, so the assistant still knows what was said and which agent the conversation was with.
`start()` always begins a new conversation. This works for assistants whose `device` is `app`, the relay keeps the
conversation in memory for 10 minutes, and a relay restart loses it; if the relay no longer has it, the session simply
starts fresh. See [running a conversation](../docs/conversations.md#carrying-a-conversation-across-a-dropped-connection).

When the relay ends a conversation itself (the assistant says goodbye, the user stays silent, a time limit passes), the
SDK emits `ended` with the reason, lets the last of the agent's speech finish playing, releases the microphone and
emits `close` with code 4001. It does not reconnect:

```js
agent.on("ended", ({ reason }) => {
  if (reason === "agent") showThanks();
});
agent.on("agentchange", ({ agent: id }) => showBadge(id));
```

With `autoReconnect: false` nothing is retried, including 1008. A browser cannot see the HTTP status of a refused
WebSocket upgrade (401 bad token, 403 origin not allowed): it reports a close with code 1006, which is why those show up
as `connection`. [Troubleshooting](../docs/troubleshooting.md) explains how to tell them apart.

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
is abandoned with `"timeout"` (the relay allows 15). A tool with
`background: true` is for slower work: the agent tells the user it has started
and carries on, the handler may take up to about 110 seconds, and the agent
reports the result when it is done. A call to an unknown tool
is answered with `"unknown tool"`. Nothing a handler does can crash the client.
Tool names match `/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/`; the constructor throws on
invalid or duplicate names. Handlers are never sent to the relay, only the
name, description and parameters.

## React

```tsx
import { useVoiceAgent } from "max-voice-agent/react";

function Assistant() {
  const { status, transcript, start, stop, mute, unmute, isMuted, sendText, sendImage, level, error } = useVoiceAgent({
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

The hook also returns `startVideo`, `stopVideo` and `video` (`"camera"`, `"screen"`, `"stream"` or `undefined`): see
[Live video](#live-video).

The client is created on mount and recreated when a connection option changes: `url`, `token` (a string),
`project`, `language`, `voice`, `backend`, `autoReconnect`, `speakFallback`, or the names, descriptions and parameters
of the tools. Replacing it ends a running conversation, so change these between sessions. Inline objects, arrays and
functions are compared by content, so writing `tools={[...]}` or `token: async () => ...` in the component body does not
restart anything. A token function, tool handlers and `context` are read live, and `context` applies from the next
session. It is safe under `<StrictMode>`. Before the component has mounted, `start()` rejects with a `VoiceAgentError`
(`code: "connection"`). The `agent` field exposes the underlying `VoiceAgent`, and is `undefined` until mounted.

### Next.js (App Router)

A `"use client"` component is still rendered once on the server, so it must only import code that is safe there. All
three entries are: importing them in Node does nothing and touches no browser API until you call `start()`.

```tsx
// app/talk.tsx
"use client";
import { useVoiceAgent } from "max-voice-agent/react";

export function Talk() {
  const { status, start, stop } = useVoiceAgent({ url: process.env.NEXT_PUBLIC_RELAY_URL!, token: fetchToken });
  return <button onClick={() => (status === "idle" ? start() : stop())}>Talk</button>;
}
```

Mint the token in a route handler such as `app/api/voice-token/route.ts` (see [Session tokens](#session-tokens)), and
check the user's session there. To use the widget instead, import it for its side effect in a client component:

```tsx
"use client";
import { useEffect } from "react";

export function Assistant() {
  useEffect(() => void import("max-voice-agent/widget"), []);
  return <voice-agent relay={process.env.NEXT_PUBLIC_RELAY_URL} token-url="/api/voice-token" />;
}
```

(TypeScript needs `voice-agent` declared in `JSX.IntrinsicElements`, as below.)

## Vue, Svelte, Angular and other frameworks

`<voice-agent>` is a standard custom element, so any framework can render it. Import `max-voice-agent/widget` once in
client code, set connection options as attributes, and tools as a property. Each framework needs to be told the tag is
not one of its own components:

```ts
// Vue 3 (vite.config.ts): do not try to resolve <voice-agent> as a component
vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "voice-agent" } } });
```

```vue
<script setup>
import "max-voice-agent/widget";
const tools = [{ name: "get_time", description: "Current time.", handler: () => new Date().toISOString() }];
</script>
<template>
  <voice-agent relay="https://relay.example.com" token-url="/api/voice-token" :tools.prop="tools" />
</template>
```

```svelte
<!-- Svelte 4 or 5: custom elements work without configuration. Set the property in an action or onMount. -->
<script>
  import "max-voice-agent/widget";
  const tools = [{ name: "get_time", description: "Current time.", handler: () => new Date().toISOString() }];
  const setTools = (el) => (el.tools = tools);
</script>
<voice-agent use:setTools relay="https://relay.example.com" token-url="/api/voice-token" />
```

```ts
// Angular: add CUSTOM_ELEMENTS_SCHEMA to the component (or module) that uses the tag
@Component({
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<voice-agent relay="https://relay.example.com" token-url="/api/voice-token"></voice-agent>`
})
export class AssistantComponent {}
```

In React, TypeScript declares the tag unknown until you add
`declare namespace JSX { interface IntrinsicElements { "voice-agent": any } }` (or use the hook). Listen for
`voice-agent:*` events with each framework's own event syntax, or with `addEventListener`.

## Script tag

With [Max Cloud](https://max.bionicloud.net/console), one line is enough: list your website in the console's
**Install** tab and paste

```html
<script
  src="https://max.bionicloud.net/sdk/voice-agent.iife.js"
  data-relay="https://max.bionicloud.net"
  data-project="pub_…"
></script>
```

The same `project` option works for `new VoiceAgent({ url, project })` and `useVoiceAgent({ url, project })`.

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
| `project`                         | A Max Cloud public agent id (`pub_…`): no backend or token needed, on websites listed in the console.                       |
| `token`                           | A fixed token (development only).                                                                                           |
| `token-url`                       | Your endpoint. It is called with POST (GET if POST gets 404/405) before every connect and must return `{ "token": "..." }`. |
| `language`, `voice`, `backend`    | As in the options above. `language` also picks the widget's own text language.                                              |
| `transport`                       | `webrtc` to send audio over WebRTC where the relay offers it. See [WebRTC](#webrtc).                                        |
| `context`                         | Facts about the page for the assistant, such as "The visitor is on the pricing page". Read at the next connect.             |
| `label`                           | Accessible name of the button. Default "Talk to the assistant" (localised, see below).                                      |
| `accent`                          | Brand colour, any CSS colour.                                                                                               |
| `position`                        | Bottom right by default; `bottom-left`, or `inline` to place it in the page flow.                                           |
| `text-input`                      | Show a text box in the panel.                                                                                               |
| `image-input`                     | Show a "Show a picture" button in the panel, on relays whose model can see one. See below.                                  |
| `video-input`                     | Show "Show my camera" and "Share my screen" buttons in the panel, on relays whose model takes video. See below.             |

The element has a Shadow DOM, a labelled toggle button (`aria-pressed`) with a
visible focus ring, a live transcript region, light and dark themes
from `prefers-color-scheme`, and no motion under `prefers-reduced-motion`.
Changing connection attributes takes effect at the next session.

DOM events (bubbling, composed): `voice-agent:status` (`{ status }`),
`voice-agent:transcript` (`{ transcript, item }`), `voice-agent:toolcall`
(`{ callId, name, arguments }`), `voice-agent:error` (`{ error }`),
`voice-agent:warning` (`{ warning }`, for example blocked audio),
`voice-agent:image` (`{ sent }`, after a picture was sent or was not),
`voice-agent:video` (`{ active, source? }`, when the camera or the screen went on or off).

With `image-input` the panel has a "Show a picture" button during a conversation. The user chooses a JPEG or PNG; the
widget sends it with [`sendImage`](#pictures) and shows it in the transcript. What is typed in the text box at that
moment goes with the picture as its question, and the assistant answers aloud; the words leave the box at once and
come back if the picture could not be sent; with an empty box, or without
`text-input`, the picture joins the conversation silently and the assistant sees it with the user's next turn. The
button is there only when the relay says its model takes pictures (`capabilities.imageInput`), so it is safe to set
the attribute on any page. A picture that was not sent (one went out less than a second ago, or the file cannot be
read as a picture) is said in the panel. To send a picture from your own code, such as a camera frame or a canvas,
call `el.sendImage(source, { text?, maxSide? })` on the element: it does what the button does. It resolves to whether the
picture was sent, and `voice-agent:image` fires with the same answer every time, also when there was no conversation
to send it in.

With `video-input` the panel has "Show my camera" and "Share my screen" buttons during a conversation, on relays whose
model takes video (`capabilities.videoInput`), and no screen button in a browser that cannot share one. A button stays
pressed while its video is on, and a small preview in the panel shows the user what the assistant sees. The video goes
off with the button, with the conversation, and when the user stops sharing in the browser. If the camera or the screen
cannot be opened, the panel says so. It is [`startVideo`](#live-video) underneath: for anything else, call it on
`el.agent`.

The error note names the problem: no microphone permission, a used-up allowance (`usage_limit`), refused credentials
(`unauthorized`), and so on. A code the widget does not know shows the error's own message before any generic text.
When the browser blocks audio, a "Tap to enable sound" button appears in the panel and resumes it.

### Language and text

All text, including screen-reader labels, is built in for English and Simplified Chinese. The language comes from the
`language` attribute (`zh`, `zh-CN`, `zh-Hans` choose Chinese), then the nearest `lang` attribute on the element or an
ancestor, then `<html lang>`, then English. Override any string with the `strings` property; set it once and it applies
immediately:

```js
const el = document.querySelector("voice-agent");
el.strings = {
  label: "Ask Acme", // the `label` attribute still wins over this
  mute: "Hush",
  typeMessage: "Ask a question",
  status: { thinking: "One moment" }, // idle, connecting, ready, listening, hearing, thinking, speaking, error, closed
  errors: { usage_limit: "Upgrade your plan to keep talking." } // microphone, token, connection, relay, audio, usage_limit, unauthorized
};
```

The other keys are `conversation`, `unmute`, `close`, `send`, `enableSound`, and for pictures `picture` (the button),
`pictureSent` (the text alternative of a picture in the transcript), `pictureNotSent` and `pictureUnusable`. Anything
you leave out keeps its built-in text.

### Keyboard and focus

The panel is a non-modal `dialog` named "Conversation". Starting a session moves focus into it; `Esc` or the Close
button stops the conversation, hides the panel and returns focus to the mic button. A new session reopens it.

### Theming

Set these custom properties on the element (or an ancestor's rule targeting `voice-agent`):

| Property         | Default (light / dark) | Used for                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------- |
| `--va-accent`    | `#2f6df6`              | The button, focus rings. The `accent` attribute sets it too.    |
| `--va-on-accent` | `#ffffff`              | Icon on the button.                                             |
| `--va-bg`        | `#ffffff` / `#1b1e24`  | Panel background.                                               |
| `--va-fg`        | `#14161a` / `#f1f3f7`  | Text.                                                           |
| `--va-muted`     | `#5b6270` / `#9aa3b2`  | Status text.                                                    |
| `--va-line`      | `#e3e6ec` / `#2f343d`  | Borders.                                                        |
| `--va-user`      | `#eef1f7` / `#2a2f38`  | Your own lines and pressed buttons.                             |
| `--va-error`     | `#b3261e` / `#ff8a80`  | The error note: 6.5:1 on the light and 7.3:1 on the dark panel. |

If you change `--va-bg` or `--va-error`, keep the text at 4.5:1 or better against the panel.

Parts for `::part()` styling: `root`, `panel`, `header`, `status`, `mute`, `close`, `lines`, `sound`, `note`, `input`,
`send` and `button` (the round mic button).

```css
voice-agent::part(button) {
  box-shadow: none;
}
voice-agent::part(panel) {
  border-radius: 8px;
}
```

## Versions

The SDK and the relay are released separately, so a page can run a newer or older SDK than the relay it talks to. They
stay compatible as long as they speak the same protocol version, which changes only for a breaking change to the wire
format. The SDK sends its protocol version and `max-voice-agent@<version>` in `session.start`, and the relay answers
with its own protocol version.

| SDK   | Protocol | Works with relays                                 |
| ----- | -------- | ------------------------------------------------- |
| 0.2.x | 1        | any relay that speaks protocol 1 (0.2.0 or newer) |
| 0.1.x | 1        | any relay that speaks protocol 1 (0.2.0 or newer) |

When the relay is ahead of the SDK, the session still runs and the client fires `warning` with code
`protocol_mismatch`: update the package. When the SDK is ahead, the relay logs a warning for its operator. Loading the
SDK from the relay itself (`https://your-relay/sdk/…`) always gives you the matching version.

`SDK_VERSION` and `PROTOCOL_VERSION` are exported from `max-voice-agent`.

## Browser support

Problems? [Troubleshooting](../docs/troubleshooting.md) covers HTTPS, microphone permission, blocked origins, token
endpoints, close codes and iOS Safari.

Needs `WebSocket`, `getUserMedia`, and `AudioContext`, in a secure context
(HTTPS or localhost). `transport: "webrtc"` also needs `RTCPeerConnection`; a
browser without it uses the WebSocket. Capture uses an AudioWorklet loaded from a Blob URL and
falls back to `ScriptProcessorNode` where worklets are missing. If your Content
Security Policy restricts `script-src`, allow `blob:`. Current Chrome, Edge,
Firefox and Safari (iOS 14.5+) are supported. Browser speech fallback needs
`speechSynthesis`; without it, those replies stay text-only.

## License

[MIT](../LICENSE)
