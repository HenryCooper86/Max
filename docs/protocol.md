# The /agent WebSocket protocol

This page is for anyone writing their own client, in any language: a web page, a phone app, a microcontroller, a
server-side bot. The relay speaks JSON text messages and binary audio frames over one WebSocket.

If you are building a web page, the [SDK](../sdk/README.md) already does all of this. Read on when you need a custom
client.

Sources of truth, in order of authority:

- [`protocol/agent-events.schema.json`](../protocol/agent-events.schema.json) is a JSON Schema for every event.
- [`shared/agent.ts`](../shared/agent.ts) has the TypeScript types with comments.
- `parseClientEvent` in [`server/session-controller.ts`](../server/session-controller.ts) holds the exact validation
  limits.

Event names are also generated as constants for TypeScript (`shared/generated/agent-protocol.ts`), Kotlin and Swift.
After changing the schema, run `npm run generate:protocol`. `npm run check:protocol` fails when the generated files are
out of date.

## Connecting

```text
ws://localhost:8787/agent
wss://relay.example.com/agent?token=<token>
```

Use `wss://` in production (see [deployment](deployment.md)).

A relay with `WEBRTC=on` also accepts the same session over a WebRTC peer connection: the events on a data channel,
the audio as Opus tracks. Everything on this page applies unchanged, except that audio is not sent as binary frames.
[WebRTC transport](webrtc.md#for-client-authors) describes the handshake.

### Authentication

A relay with no `RELAY_AUTH_TOKEN` and no user accounts is open. Otherwise the connection must carry a token, in the
`token` query parameter or an `Authorization: Bearer <token>` header:

| Token                                    | Where it comes from                                                |
| ---------------------------------------- | ------------------------------------------------------------------ |
| A session token (`vst_...`)              | Your backend mints it with `POST /v1/session-tokens`. Short-lived. |
| The relay token (`RELAY_AUTH_TOKEN`)     | The operator's secret. Use it only from trusted code, not a page.  |
| A login session token from `/auth/login` | A signed-in user of the relay's own web app.                       |

Browsers cannot set headers on a WebSocket, so they use the query string. Native clients should prefer the header,
which keeps the token out of URLs and proxy logs. Never put the relay token in a web page. See [security](security.md).

### Refusals

The relay refuses the upgrade with a plain HTTP status before any WebSocket exists:

| Status | Meaning                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | A token is required and the one sent is missing, wrong or expired.                                                                                                                                                                       |
| 403    | The browser `Origin` header is not in `RELAY_ALLOWED_ORIGINS`.                                                                                                                                                                           |
| 429    | More than `RELAY_CONN_PER_MINUTE` (default 30) upgrade attempts from this IP in a minute.                                                                                                                                                |
| 503    | The relay is shutting down, or its usage file is unreadable while `USAGE_MONTHLY_MINUTES` is set, so no new session is taken until that is repaired (see [usage and billing](usage-and-billing.md#what-is-counted)). Retry with backoff. |

Requests to any path other than `/agent` and `/companion` are dropped without a response.

### Close codes

| Code | Who    | Meaning                                                                                                                                                                                                                                                                        |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1000 | either | Normal close.                                                                                                                                                                                                                                                                  |
| 1001 | relay  | The relay is shutting down. Reconnect with backoff.                                                                                                                                                                                                                            |
| 1008 | relay  | Policy: a logged-in user signed out, their session expired or the account was deleted, or a client sent a device registration without the relay token. Do not retry with the same credentials; fetch a new token first, and retry at most once. The web SDK does exactly that. |
| 1011 | relay  | The voice backend failed to start. An `error` event comes first. Reconnect with backoff.                                                                                                                                                                                       |
| 4001 | relay  | Final: the session is over and the client should not reconnect. Either idle (no client traffic for `RELAY_IDLE_TIMEOUT_MS`, default 10 minutes), or the relay ended the conversation and sent [`session.ended`](#sessionended) first.                                          |
| 4003 | relay  | Voice minutes used up: the account's monthly allowance is spent (see [usage and billing](usage-and-billing.md)). New connections are refused the same way until the month ends. Do not reconnect.                                                                              |

The relay pings every `RELAY_HEARTBEAT_MS` (default 30 s) and drops a client that does not answer. Any WebSocket library
answers pings on its own. A client that sends nothing at all (no events, no audio) is idle in the sense above, so a
text-only client that waits a long time between messages should expect 4001.

One message may not exceed `RELAY_MAX_PAYLOAD_BYTES` (default 384 KiB; the relay will not go below 320 KiB). A larger
message closes the connection.

## Session lifecycle

```text
client                                         relay
  |  connect /agent?token=...  ------------------>|
  |<------------------ connection {state:"relay"} |
  |  session.start {sampleRate:16000, channels:1} |
  |<---------------------------- session.started |
  |  audio.start  ------------------------------>|
  |  binary PCM16 16 kHz frames  ---------------->|
  |<----------------------- status {hearing}      |
  |<----------------------- transcript (partials) |
  |<----------------------- status {thinking}     |
  |<----------------------- tool.call / tool.activity
  |  tool.result  ------------------------------>|
  |<----------------------- status {speaking}     |
  |<----------------------- binary PCM16 24 kHz   |
  |<----------------------- transcript (final)    |
  |<----------------------- status {listening}    |
  |  audio.stop  ------------------------------->|
  |  close  ------------------------------------>|
```

1. Open the socket. The relay sends a `connection` event at once.
2. Send `session.start` as the first message. It must be the first and only one: a second `session.start` is an error.
   Every other event is rejected until the relay has started the voice backend.
3. Wait for `session.started`. It names the backend, its capabilities and (when present) the audio plan.
4. For voice, send `audio.start`, then stream microphone audio. For text only, skip audio entirely.
5. Handle events until you close the socket. `audio.stop` pauses the microphone without ending the session.

Errors that do not end the session arrive as `{ "type": "error", "message": "..." }`. A bad event produces an `error`
and is otherwise ignored. A client that receives `error` after `session.start` and then a close with 1011 should treat
the backend as unavailable.

### Audio

Audio travels as binary WebSocket messages, with no header.

| Direction       | Format                            | Notes                                                    |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| Client to relay | PCM16 little-endian, 16 kHz, mono | 20 ms frames (640 bytes). A frame may be at most 32 KiB. |
| Relay to client | PCM16 little-endian, 24 kHz, mono | Play in order, back to back. Chunk sizes vary.           |

Send audio only between `audio.start` and `audio.stop`. A binary frame outside that window is an error.

`session.start` must say `"sampleRate": 16000` and `"channels": 1`. Any other value is rejected. If your hardware
captures at another rate, resample before sending.

#### Barge-in

When the user starts speaking, the relay sends `status` with `state: "hearing"`. If the assistant is talking, stop
playback at once and drop any audio you have not yet played. The relay has already stopped generating. This is what
makes the conversation feel interruptible.

The `audio.bargeIn` field of `session.started` can be `"confirm"` for devices that told the relay they hear their own
speaker. Then verify with your own microphone before cutting playback. The full rules, including how a device
declares what its hardware already does in `session.start.audio`, are in [the audio contract](audio/contract.md).

#### Status values

`status` carries `state` and a human-readable `detail`. The states a UI should know:

| State       | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `ready`     | The session is up and waiting.                  |
| `listening` | Microphone is open and waiting.                 |
| `hearing`   | The user is speaking. Stop playback (barge-in). |
| `thinking`  | The user finished; the assistant is working.    |
| `speaking`  | The assistant is replying.                      |
| `degraded`  | The backend had a problem and is recovering.    |
| `closed`    | The backend session ended.                      |

Treat unknown states as informational.

## Events from client to relay

Every message is a JSON object with a `type` string. Unknown types are rejected with an `error`. Strings in the limits
below are measured in characters unless a field says bytes.

### session.start

First message. The fields that matter for an app or a website:

| Field              | Type              | Rules                                                                                          |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------- |
| `type`             | `"session.start"` |                                                                                                |
| `sampleRate`       | number            | Required. Must be `16000`.                                                                     |
| `channels`         | number            | Required. Must be `1`.                                                                         |
| `voiceGender`      | string            | `"female"` or `"male"`. Picks the backend's voice.                                             |
| `voicePersonality` | string            | `"concise"`, `"friendly"`, `"technical"` or `"rally"`.                                         |
| `voiceProvider`    | string            | A backend id such as `openai`. Honored only if the relay allows switching and has its keys.    |
| `language`         | string            | A language tag such as `en` or `zh-CN`. Used when it is one the assistant speaks.              |
| `equalizer`        | object            | Voice equaliser. Out-of-range values are clamped, junk is dropped. Honored only if adjustable. |
| `audio`            | object            | What the device's hardware already does. See the [audio contract](audio/contract.md).          |
| `tools`            | array             | Up to 32 client tools. See [Tools](#tools).                                                    |
| `context`          | string            | Up to 2000 characters of facts from your app. See [Context](#context).                         |
| `memory`           | object            | The last `session.memory` event, echoed back when you restart a session.                       |
| `protocol`         | integer           | The protocol version your client speaks. See [Versions](#versions).                            |
| `resume`           | string            | The `resume` of an earlier `session.started`, when reconnecting. See [Resuming](#resuming).    |

Fields for QA and telemetry, all optional strings of at most 40 to 160 bytes without control characters: `testerId`,
`testerRegion`, `testingCampaignId`, `testingTestCaseId`, `testingRunId`, `testingAssignmentId`, `appVersion`,
`gitCommit`, `deviceLabel`, `browserLanguage`, `networkType`, and `platform` (one of the values in the schema).

Fields that only apply to wearables are covered under [Wearable extensions](#wearable-extensions).

The relay ignores fields it does not know, so a client written for a newer relay still connects to an older one.

### Versions

The protocol has a version number, currently `1`. It goes up only for a change that is not backwards compatible. New
optional fields and new event types do not change it, because both sides ignore what they do not know.

- Send your version as `protocol` in `session.start`. It is optional; a client that omits it is treated as version 1.
- The relay answers with its own version as `protocol` in `session.started`. Relays older than this handshake omit it.
- Nothing is refused on a mismatch. When the client is ahead, the relay logs a warning for its operator. When the relay
  is ahead, the client should tell its developer; the web SDK fires a `warning` event with code `protocol_mismatch`.

Put your client's own name and version in `appVersion` (the web SDK sends `max-voice-agent@<version>`) so the relay's
logs say who connected.

### audio.start and audio.stop

```json
{ "type": "audio.start" }
{ "type": "audio.stop" }
```

No other fields.

### text.input

A typed turn. It behaves like a spoken, addressed turn (no wake word needed): the relay shows it as a final user
transcript and the assistant answers aloud.

```json
{ "type": "text.input", "text": "Where is my order A-1042?" }
```

`text` must be non-empty after trimming and at most 2000 characters. When the backend does not accept typed turns, the
relay answers with an `error` event. Doubao and the original helmet demo do not accept them; every other backend does.
`session.started.capabilities.textInput` tells you in advance; it is absent on relays older than typed input.

### image.input

A picture for the conversation's model: a screenshot, a photo.

```json
{ "type": "image.input", "image": "<base64>", "mimeType": "image/jpeg", "text": "What does this error mean?" }
```

| Field      | Rules                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `image`    | Required. Base64 without a `data:` prefix, at most 240,000 characters. The first bytes must be a real JPEG or PNG.       |
| `mimeType` | Required. `image/jpeg` or `image/png`, and the bytes must match it.                                                      |
| `text`     | Optional. The same rules as the text of `text.input`: trimmed, at most 2000 characters. Empty or blank counts as absent. |

The 240,000-character limit keeps the whole JSON message under the relay's 256 KiB limit for client messages, which the
WebRTC data channel shares. Scale a photo down first; the web SDK does that in `sendImage`, and the iOS and Android clients before they send one.

With `text`, it is a typed turn with the picture attached: the relay handles it exactly as it does `text.input` (it
interrupts a reply in progress, shows the words as the user's final transcript, and the assistant answers aloud).

Without `text`, the picture joins the conversation silently. Nothing is answered, nothing appears as a transcript, and
a reply in progress is not interrupted. The model sees the picture together with the user's next spoken or typed turn.
A picture counts as the user being present for the idle check-in.

Limits per connection (a reconnect starts a new count, even when it resumes the same conversation): at least one second between pictures (Gemini Live documents at most one frame per second) and at
most 50 pictures. A picture over either limit is refused with an `error` event and the session continues.

The relay answers with an `error` event, and does nothing else, when the backend cannot take pictures, and for an
invalid event (wrong media type, bad base64, bytes that do not match `mimeType`, too large). Which backends take
pictures is in [Voice backends](backends.md#pictures); `session.started.capabilities.imageInput` tells you in advance,
and it is absent on relays older than image input.

Pictures go to the model's vendor. The relay does not write picture bytes to conversation records, logs, traces, resume
state or memory; a conversation record or a resumed session only holds the text "[the user showed a picture]" where one
was shown.

### video.frame and video.stop

Live video: what the user's camera or a shared screen shows, a frame at a time, while the conversation goes on.

```json
{ "type": "video.frame", "image": "<base64>", "mimeType": "image/jpeg" }
```

```json
{ "type": "video.stop" }
```

A frame is a picture by the rules of `image.input` (`image` and `mimeType`, the same size limit and checks), without
`text`. Send one about every second while the video is on, and `video.stop` when it goes off.

A frame starts nothing: no reply, no transcript, no interruption, and it does not count as the user being present for
the idle check-in (a camera left on is not somebody talking). The relay keeps the newest frame only, and the model sees
it with the user's next spoken or typed turn: "what am I holding?" is answered about the frame of that moment. On Gemini
Live, which takes video itself, each frame is passed on as it arrives, at most one a second. How each backend takes
frames is in [Voice backends](backends.md#live-video).

Frames have no count limit and do not use up the 50 pictures of `image.input`. A frame that comes less than 500 ms
after the last one is dropped without an error; the next is as good. When no frame has come for 10 seconds the relay
takes the video to be over, as if `video.stop` had been sent.

`session.started.capabilities.videoInput` says in advance whether the session takes video: it is true wherever
`imageInput` is, and absent on relays older than live video. On a session that does not, the first frame is answered
with one `error` event ("This voice backend does not take video.") and later ones with nothing. An invalid frame is
answered with an `error` event like an invalid picture.

Frames go to the model's vendor. The relay does not write them to conversation records, logs, traces, resume state or
memory; a record only holds the lines "[the user turned on live video: …]" and "[the user turned the live video off]".

### tool.result

The answer to a `tool.call`. Send exactly one per call, within 15 seconds.

```json
{ "type": "tool.result", "callId": "call_8f2", "output": { "status": "shipped" } }
{ "type": "tool.result", "callId": "call_8f2", "error": "Order not found" }
```

| Field    | Rules                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| `callId` | Required. Non-empty, at most 128 characters. Copy it from the `tool.call`.                 |
| `output` | Any JSON value. A string is passed to the model as is; anything else is JSON-encoded.      |
| `error`  | A reason for the model. Trimmed and cut at 1000 characters. When set, `output` is ignored. |

### Diagnostics

| Event            | Fields                                                                                    | Purpose                                       |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| `testing.metric` | optional numbers: `droppedFrames`, `outgoingFps`, `jitterMs`, `clippingPct`, `silencePct` | Audio pipeline quality for QA reports.        |
| `turn.feedback`  | `turnId`, `speaker` (`rider` or `agent`), `text`, `reason`                                | A tester flags a transcript turn as wrong.    |
| `demo.guided`    | `enabled` (boolean)                                                                       | Start or stop the mock backend's guided demo. |

`testing.metric` values are bounded (for example `clippingPct` and `silencePct` 0 to 100). `turn.feedback` limits:
`turnId` 120, `text` 2000, `reason` 120 characters.

## Events from relay to client

| Event             | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `connection`      | Link state: `{ state, detail }`. `state` is `relay` right after connecting.                                              |
| `session.started` | The backend is ready: `{ provider, mode, capabilities, protocol?, audio? }`.                                             |
| `status`          | `{ state, detail }`. See [Status values](#status-values).                                                                |
| `transcript`      | What the user said or the assistant says. See [Transcripts](#transcripts).                                               |
| `tool.call`       | Run one of your client tools. See [Tools](#tools).                                                                       |
| `tool.activity`   | Progress of any tool call, for a UI.                                                                                     |
| `session.ended`   | The relay is ending the conversation: `{ reason }`. See [below](#sessionended).                                          |
| `agent.changed`   | The conversation moved to another agent: `{ agent }`. See [below](#agentchanged).                                        |
| `metric`          | `{ latencyMs, droppedFrames?, outgoingFps? }`. `latencyMs`: the end of the user's turn to the first sound of the answer. |
| `telemetry`       | `{ asrMs, thinkMs, firstAudioMs, totalMs }` timings for the last turn.                                                   |
| `error`           | `{ message }`. The session usually continues.                                                                            |

`session.started` fields:

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`     | The backend id actually used: `mock`, `openai`, and so on.                                                                                                                                                                                                                                                                                                               |
| `mode`         | `mock` or `live`.                                                                                                                                                                                                                                                                                                                                                        |
| `capabilities` | `serverVad`, `synthesizedAudio`, `transcriptEvents`, `bargeIn`, `voiceSelection`, `weatherContext`, `sessionMemory`, `emergencyMode`, `tools`, `textInput`, `imageInput`, `videoInput`. `tools` and `textInput` are absent on relays older than tool support; `imageInput` is absent on relays older than image input, and `videoInput` on relays older than live video. |
| `audio`        | The audio plan: `wakeGate`, `silenceFill`, `bargeIn`. See the audio contract.                                                                                                                                                                                                                                                                                            |
| `resume`       | An id to send back as `session.start.resume` when you reconnect, so the conversation carries on. Absent from relays older than resumption. See [Resuming](#resuming).                                                                                                                                                                                                    |

`synthesizedAudio: false` means the backend sends text only (the mock). The page should speak the text itself. See
[`useBrowserSpeech`](#usebrowserspeech).

Some events apply only to wearables (`weather`, `ride.context`, `session.memory`, `hazard.alert`, `device.command` and
more) and arrive only from a relay configured for such a device. A generic app can ignore them. They are listed in
[Wearable extensions](#wearable-extensions).

### Transcripts

```json
{
  "type": "transcript",
  "turnId": "b5c1...",
  "deliveryId": "0e9a...",
  "speaker": "agent",
  "text": "Your order shipped yesterday.",
  "final": true,
  "useBrowserSpeech": false
}
```

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `turnId`           | Identity of one logical turn. Every partial and final update of that turn shares it.             |
| `deliveryId`       | Identity of the matching speech delivery.                                                        |
| `speaker`          | `rider` for the user (a historical name, it applies to every app) or `agent` for the assistant.  |
| `text`             | The text so far for this turn. Partial updates are cumulative: each replaces the previous one.   |
| `final`            | `true` on the last update of the turn. May be absent on partials.                                |
| `useBrowserSpeech` | `true` when the relay sent text only and the client should speak it with its own text-to-speech. |

To render a transcript, keep a map keyed by `turnId` and replace the entry's text on every event. Do not append.
Use `deliveryId` to match a transcript with the audio of the same reply when you need to.

### useBrowserSpeech

Set on agent transcripts when the backend produced no audio: the mock demo, or a backend whose speech synthesis failed.
Speak `text` with the platform's speech engine (in a browser, `speechSynthesis`). When it is absent or `false`, the
reply arrives as binary audio.

## Tools

A tool is something the assistant can call in the middle of a conversation. There are three kinds; the first two live on
the relay and are described in [tools](tools.md). The third lives in your client.

### Declaring client tools

Send them in `session.start.tools`:

```json
{
  "type": "session.start",
  "sampleRate": 16000,
  "channels": 1,
  "tools": [
    {
      "name": "open_page",
      "description": "Open a page of the shop for the user.",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ]
}
```

| Field         | Rules                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `name`        | Matches `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`. Unique in the list.                             |
| `description` | Required, at most 1024 characters. The model reads it to decide when to call the tool.    |
| `parameters`  | A JSON Schema object (`type` must be `"object"` or absent), at most 8 KiB. Default: none. |
| `background`  | `true` for a tool the conversation does not wait for. See below. Default: `false`.        |

At most 32 tools. A malformed list rejects the whole `session.start` with an `error` naming the problem, so you see
your own bug. A tool whose name matches a relay tool is ignored: relay tools win.

### Calls

When the model uses a client tool the relay sends:

```json
{ "type": "tool.call", "callId": "call_8f2", "name": "open_page", "arguments": { "path": "/pricing" } }
```

Run it and answer with one `tool.result` carrying the same `callId`. If you do not answer within 15 seconds the call
fails with `"timeout"` and the model is told so. A late answer is ignored. A model may issue several calls in one turn,
so your handler can be called again before an earlier call has finished.

A tool declared with `"background": true` is for work that takes a while. The relay tells the model at once that the
work has started, the conversation carries on, and you have 120 seconds to send the `tool.result`. The assistant
reports it at the next quiet moment. See [background tools](tools.md#background-tools). A relay older than this
ignores the field and waits 15 seconds.

`tool.call` is sent only for tools you declared. Relay-side tools never reach the client as `tool.call`.

### Activity

The relay sends `tool.activity` for every call, relay-side or client-side, so a UI can say "Looking up your order...":

```json
{ "type": "tool.activity", "callId": "call_8f2", "name": "get_order_status", "where": "server", "state": "started" }
{ "type": "tool.activity", "callId": "call_8f2", "name": "get_order_status", "where": "server", "state": "succeeded", "durationMs": 412 }
```

`state` is `started`, `succeeded` or `failed`. A failure carries `error`.

Tool output reaching the model is capped at 16 KiB. Whether a backend supports tools at all is in
`session.started.capabilities.tools`.

### Context

`session.start.context` is free text from your app, at most 2000 characters, such as "The user is on the pricing page."
The relay puts it in the assistant's instructions, framed as information that cannot change the assistant's rules.
Because the client sends it, treat it as untrusted. Facts you need to trust (who the user is) should come from your
backend through a session token's `userId` and `context`. See [security](security.md).

### Resuming

A voice model's memory ends with its WebSocket. To carry a conversation across a dropped connection, keep the `resume`
value from `session.started` and send it as `session.start.resume` on the next connection. The relay then starts the
new session with the conversation so far, and with the agent it was with, and does not greet again.

```json
{
  "type": "session.started",
  "provider": "openai",
  "mode": "live",
  "capabilities": {},
  "resume": "rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s"
}
```

```json
{ "type": "session.start", "sampleRate": 16000, "channels": 1, "resume": "rsm_Zk3p0xT1q8mYVw2n5HcA9rUe7LdJbG4s" }
```

- The id is a string of at most 64 characters, issued by the relay. One that is malformed, unknown or expired is dropped,
  not rejected: the session starts fresh and `session.started.resume` carries a new id. A resumed session returns the id
  it was given.
- It only works for the same user (the signed-in account, or the `userId` of the session token) on the same deployment.
- Send it only on a reconnect. To start a new conversation, leave it out.
- The state is kept in the relay's memory for 10 minutes after the last turn, holds the last 40 turns of at most 600
  characters, and exists only for `app` assistants. It is lost when the relay restarts. Details and limits are in
  [running a conversation](conversations.md#carrying-a-conversation-across-a-dropped-connection).

### session.ended

The relay is ending the conversation. The last of the assistant's speech has been sent, so play it out, then expect the
close.

```json
{ "type": "session.ended", "reason": "idle" }
```

| `reason`       | Why                                                                      |
| -------------- | ------------------------------------------------------------------------ |
| `agent`        | The assistant ended a finished conversation (`conversation.endSession`). |
| `idle`         | The user stayed silent through every check-in.                           |
| `max_duration` | The conversation reached `conversation.maxDurationSeconds`.              |

Right after it the relay closes the WebSocket with close code **4001**, with the reason as the close reason. 4001 means
"do not reconnect", so a client must not resume or reconnect after it. A client that does not know the event still sees
the close code and does the right thing. See [running a conversation](conversations.md).

### agent.changed

The conversation moved to another of the assistant's agents (see
[several agents](conversations.md#several-agents-and-handing-over)).

```json
{ "type": "agent.changed", "agent": "billing" }
```

`agent` is the id from the assistant's `agents` list. It is sent each time the conversation hands over, and once at the
start of a resumed session that was not with the `main` agent. A session without `agents` never sends it.

## Wearable extensions

The kit began as a motorcycle-helmet assistant. These events serve wearable devices and are only meaningful when the
relay is configured for one. A website or app can leave them out and ignore them when received.

| Group      | Client to relay                                                                                      | Relay to client                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Ride       | `location.update` (`lat`, `lon`, `speedKmh`?); `session.start`: `rideMode`, `scenario`, `lat`, `lon` | `ride.context`, `weather`, `session.memory`                                           |
| Hazard     | `hazard.report` (a hazard the board already announced; never echoed back)                            | `hazard.alert` (`interrupt: true` means stop speech at once)                          |
| Crash      | `crash.alert`, `crash.cancel`                                                                        | `crash.ack`, `crash.simulate` (mock only)                                             |
| Navigation | `nav.request`, `nav.prompt`                                                                          | `nav.route`, `nav.error`                                                              |
| Vision     | `camera.frame`, `vision.frames` (base64 JPEG, at most 200,000 characters each)                       | none; the camera is driven by `device.command`                                        |
| Device     | `device.result` (`commandId`, `status`: `ok`, `failed`, `denied`, `unsupported`)                     | `device.command` (`commandId`, `action`, `args`, `tier`)                              |
| Companion  | none on `/agent`                                                                                     | `companion.pairing`, `companion.discovery`, `phone.location`, `phone.location.status` |

Notes:

- `device.command` asks the device to do something (take a photo, set the volume). Answer every command with exactly
  one `device.result`; silence past the relay's timeout counts as failure.
- A `deviceId` in `session.start` (registering an embedded board) is accepted only on a connection that used the relay
  token or on an open relay. Otherwise the relay closes with 1008.
- The phone companion link uses a separate `/companion` endpoint that needs a user login, not a session token.
- `crash.alert` carries optional `contactNumber` only when the user opted in. `crash.ack.status` is `notified`,
  `failed` or `unconfigured`. The default notifier only logs, so the ack says `unconfigured`.
- Field shapes and limits are in the schema file.

## Minimal Python client

A text-only client. It starts a session without audio, sends one typed message, prints the transcripts and answers a
`tool.call`. Install the library with `pip install websockets`.

```python
import asyncio
import json
import sys

import websockets  # pip install websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8787/agent"  # add ?token=... if needed
TEXT = sys.argv[2] if len(sys.argv) > 2 else "What time is it?"


def run_tool(name: str, arguments: dict) -> dict:
    if name == "get_time":
        return {"time": "12:00"}
    raise ValueError(f"unknown tool {name}")


async def main() -> None:
    async with websockets.connect(URL, max_size=1 << 20) as ws:
        await ws.send(json.dumps({
            "type": "session.start",
            "sampleRate": 16000,   # must be 16000, even for a text-only client
            "channels": 1,         # must be 1
            "language": "en",
            "tools": [{
                "name": "get_time",
                "description": "Return the current time.",
            }],
            "context": "The user is testing the Python client.",
        }))

        sent_text = False
        finals = {}  # turnId -> text, replaced on every update
        async for message in ws:
            if isinstance(message, bytes):
                continue  # synthesized speech; a text-only client ignores it
            event = json.loads(message)
            kind = event["type"]

            if kind == "session.started" and not sent_text:
                sent_text = True
                print("backend:", event["provider"], event["capabilities"])
                await ws.send(json.dumps({"type": "text.input", "text": TEXT}))

            elif kind == "transcript":
                finals[event["turnId"]] = event["text"]
                if event.get("final"):
                    print(f'{event["speaker"]}: {event["text"]}')
                    if event["speaker"] == "agent":
                        return

            elif kind == "tool.call":
                try:
                    result = {"type": "tool.result", "callId": event["callId"],
                              "output": run_tool(event["name"], event["arguments"])}
                except Exception as error:
                    result = {"type": "tool.result", "callId": event["callId"], "error": str(error)}
                await ws.send(json.dumps(result))

            elif kind == "error":
                print("error:", event["message"])


asyncio.run(main())
```

Save it as `client.py` and run `python3 client.py ws://localhost:8787/agent get_time`. With `VOICE_PROVIDER=mock`
and an `app` assistant (see the [web-embed example](../examples/web-embed/README.md)) the demo backend answers typed
messages and runs a tool when you type its name, so the second argument `get_time` makes the relay send you a
`tool.call`. With a real backend the model decides when to call the tool, so ask "What time is it?".
The original helmet demo (the default when no `assistant.config.json` exists) does not run tools and does not accept
typed messages.

The client above never opens the microphone, so it never sends `audio.start`. For a voice client, also send
`audio.start`, stream 20 ms frames of 16 kHz PCM16 as binary messages, play the 24 kHz PCM16 messages you receive, and
stop playback when you get `status` with `state: "hearing"`. A complete reference implementation with echo handling
and reconnect is [`examples/device-client/max_device.py`](../examples/device-client/max_device.py).
