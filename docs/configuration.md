# Configuration

Two places configure the relay:

- **`assistant.config.json`**: who the assistant is, what it does and how it looks. It is safe to keep in version
  control. `npm run setup` writes it interactively, and admins can edit most of it at Admin → Studio.
- **Environment variables** (`.env`): secrets, the voice backend, and how the relay runs. Start from `.env.example`,
  which documents every variable.

## Where the config file is read from

The first of these that exists wins:

1. The file named by `ASSISTANT_CONFIG` (set `ASSISTANT_CONFIG=off` to ignore every config file).
2. The file the Studio saved: `$STUDIO_DIR/assistant.config.json` (default `~/.max-relay/`). It lives
   outside the app directory so a deploy does not erase it.
3. `assistant.config.json` in the directory the relay was started from.

With none of them, the relay runs the built-in reference assistant, Max (a motorcycle-helmet assistant). A file that
exists but is not valid JSON stops the relay at startup instead of quietly running a different assistant. Relative
paths inside the file (`logo`, `toolsModule`) are resolved against the file's own directory.

## `assistant.config.json`

Every key is optional.

### Identity and behaviour

| Key               | Type                   | Default                                 | What it does                                                                                                                                            |
| ----------------- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | string (≤ 24)          | `"Max"`                                 | The assistant's name. It is also its wake word, when the wake word is on.                                                                               |
| `device`          | string                 | `"motorcycle-helmet"`                   | Where the assistant lives. `"app"` is a software assistant for a website, app, kiosk or phone line. The wearables are listed [below](#devices).         |
| `instructions`    | string (≤ 8000)        | none                                    | Your instructions, added after the generated persona: product knowledge, house rules, tone, what not to do. Kept when `persona` is set.                 |
| `greeting`        | string (≤ 300)         | none                                    | Spoken once, when the microphone first opens in a session.                                                                                              |
| `persona`         | string (≤ 6000)        | generated                               | Replaces the generated persona entirely. Most assistants only need `instructions`.                                                                      |
| `developer`       | string or `null`       | none for a renamed assistant            | Who the assistant says built it. `null` or absent: it names no company and never names the underlying model.                                            |
| `identityNotes`   | string (≤ 400)         | none                                    | One or two more facts it may state about itself.                                                                                                        |
| `tagline`         | string (≤ 80)          | none                                    | A short line the apps show under the name.                                                                                                              |
| `languages`       | string array (≤ 8)     | `["en"]` for `app`; else `["zh", "en"]` | Languages it speaks, most preferred first. Prompts are written in Chinese when the first is `zh`, otherwise in English.                                 |
| `strictLanguages` | boolean                | `false` (stock Max: `true`)             | `true`: refuse other languages. `false`: prefer the listed ones but follow the user.                                                                    |
| `wakeWord`        | boolean                | `false` for `app`, else `true`          | `true`: answer only speech that says the assistant's name (then a short follow-up window). `AGENT_WAKE_WORD=off` turns it off for every assistant.      |
| `wake`            | object                 | from `name`                             | `names`: other names or common mishearings it answers to; `label`: the name shown in hints; `falseFriends`: words that contain the name but are not it. |
| `deviceLabel`     | string or `{ zh, en }` | from `device`                           | How the device is named in prompts, such as "smart ring".                                                                                               |
| `wearer`          | string or `{ zh, en }` | from `device`                           | What the person is called in prompts: "user", "rider", "guest".                                                                                         |

### Tools

| Key           | Type   | What it does                                                                                                |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `toolsModule` | string | A TypeScript or JavaScript module whose default export is a list of code tools. Relative to this file.      |
| `tools`       | array  | Webhook tools: `name`, `description`, `parameters` and `webhook` (`url`, `headers`, `secret`, `timeoutMs`). |

Both are described in the [tools guide](tools.md). The Studio keeps them when it saves, but does not edit them: a
module path is code on the server's disk, so it is set by whoever deploys the relay.

Two more keys add tools from other places:

| Key          | Type                    | What it does                                                                                                                                                                                                            |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpServers` | array (≤ 8)             | Remote MCP servers whose tools the assistant may use: `name`, `url`, `headers`, `allowedTools`, `prefix`, `timeoutMs`, `backgroundTools`, `backgroundTimeoutMs`. See [remote MCP servers](tools.md#remote-mcp-servers). |
| `knowledge`  | string, array or object | Documents the assistant searches with `search_knowledge`: `files`, `text`, `maxResults`, `chunkChars`. See [knowledge base](tools.md#knowledge-base).                                                                   |

### Conversation, agents and records

These keys shape how a conversation runs and what happens to it afterwards. They apply to the relay's own assistant, not
to Max Cloud projects. Each is explained in [running a conversation](conversations.md).

| Key              | Type                     | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`   | object                   | `idleReminderSeconds`, `idleReminders`, `maxIdleReminders`, `maxDurationSeconds`, `farewell`, `endSession` and `rememberUsers`: checking in on a silent user, a time limit, letting the assistant end the conversation, and remembering a user between conversations. See [checking in](conversations.md#checking-in-a-time-limit-and-ending-the-conversation). |
| `agents`         | array (≤ 12)             | Specialist agents the conversation can be handed to, each with `id`, `description`, `instructions` and an optional `tools` list. See [several agents](conversations.md#several-agents-and-handing-over).                                                                                                                                                        |
| `analysis`       | `true` or object         | Summary, sentiment, success criteria and extracted `fields` for each finished conversation. Runs only when `CONVERSATION_WEBHOOK_URL` or `CONVERSATION_LOG_FILE` is set. See [analysis](conversations.md#analysis).                                                                                                                                             |
| `privacy.redact` | `true`, `"all"` or array | Removes personal data from records that leave the relay. Kinds: `email`, `card`, `ssn`, `ip`, `phone`. See [redacting](conversations.md#redacting-personal-data).                                                                                                                                                                                               |
| `guardrails`     | object                   | What the assistant must not say and users must not do, checked by the relay: `blockedTerms`, `rules`, `userRules`, `say`, `endConversation`, `hold`. See [guardrails](conversations.md#guardrails).                                                                                                                                                             |
| `version`        | string                   | A label of your own for this state of the config, up to 64 characters. Every conversation record carries it. See [versions and A/B tests](conversations.md#versions-and-ab-tests).                                                                                                                                                                              |
| `variants`       | list                     | Two to eight versions of the assistant to compare: each an `id`, a `weight` and the keys it replaces. See [versions and A/B tests](conversations.md#versions-and-ab-tests).                                                                                                                                                                                     |

A bad entry in any of these is skipped or ignored with a line in the relay's startup log, and the rest of the file still
applies.

Admin → Studio edits only the identity, look and sound keys. When it saves, it copies `tools`, `toolsModule`,
`conversation`, `agents`, `analysis`, `privacy`, `guardrails`, `variants`, `version`, `knowledge` and `mcpServers` into its own file from the config the
relay is running (relative `knowledge` paths become absolute), so a save never drops them. The Studio's file then wins
over `./assistant.config.json`: change these keys there afterwards, or keep your config in a file named by
`ASSISTANT_CONFIG`, which wins over the Studio's.

### Look and sound

These shape the relay's own web app and the native apps. The SDK widget takes its colour from its `accent` attribute
instead.

| Key                 | Type    | What it does                                                                                                                                                                             |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template`          | string  | Design template: `visor`, `daylight`, `beacon`, `ember` or `holo`. Defaults to the device's.                                                                                             |
| `theme`             | object  | Token overrides on top of the template, such as `{ "radius-card": "20px" }`. Values must be colours, lengths or numbers.                                                                 |
| `templateSwitching` | boolean | `false` pins the template so viewers cannot pick their own.                                                                                                                              |
| `accentColor`       | string  | Brand colour, `#RRGGBB`.                                                                                                                                                                 |
| `logo`              | string  | A square `.svg` or `.png` (≤ 512 KiB). `npm run brand` turns it into the favicon and app icons. Without one, stock Max shows its hummingbird and a configured device shows its own mark. |
| `logoBackground`    | string  | Colour behind the logo where a platform needs one, `#RRGGBB`.                                                                                                                            |
| `visualizer`        | string  | How the live voice is drawn: `wave`, `bars`, `mirror`, `dots` or `ring`.                                                                                                                 |
| `voice.equalizer`   | object  | Shapes the assistant's voice for every client: a `preset` (such as `flat`, `clarity`, `warm`, `open-ear`, `telephone`) and/or ten `bands` in dB (−12 to 12) and `preamp`.                |

### Devices

`device` picks the defaults and the device-specific conduct of the generated persona.

| `device`            | For                                 | Notes                                                                         |
| ------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `app`               | Websites, apps, kiosks, phone lines | No wake word, riding context, built-in device actions or weather. Tools only. |
| `motorcycle-helmet` | The reference assistant             | Navigation, weather, hazard alerts, device actions                            |
| `bicycle-helmet`    | Cycling                             | Even shorter answers                                                          |
| `sunglasses`        | Open-ear audio glasses              | Asks before reading private things aloud                                      |
| `smart-glasses`     | Glasses with camera or display      |                                                                               |
| `assistive-glasses` | Blind and low-vision wearers        | Clock-direction positions, never "as you can see"                             |
| `ar-headset`        | AR glasses                          | Does not repeat what the display shows                                        |
| `vr-headset`        | VR headsets                         | Remembers the wearer cannot see the room                                      |
| `wearable`          | Any other wearable                  |                                                                               |

`web`, `website`, `software`, `kiosk` and `phone` are accepted as aliases of `app`. Adding a device is adding an entry
to `server/device-presets.ts`.

### A complete example

```json
{
  "name": "Ava",
  "device": "app",
  "developer": "Acme Outdoor",
  "languages": ["en", "es"],
  "greeting": "Hi, I'm Ava from Acme Outdoor. Ask me about an order, or what's in stock.",
  "instructions": "You are the voice assistant of the Acme Outdoor web shop. Help shoppers find products, check orders and navigate the site. Prices are in US dollars. Never promise delivery dates a tool did not give you.",
  "toolsModule": "./agent-tools.ts",
  "tools": [
    {
      "name": "get_order_status",
      "description": "Look up an order by its order number, for example A-1042.",
      "parameters": {
        "type": "object",
        "properties": { "orderId": { "type": "string" } },
        "required": ["orderId"]
      },
      "webhook": { "url": "https://api.acme.example/voice/order-status", "secret": "${ORDER_WEBHOOK_SECRET}" }
    }
  ],
  "accentColor": "#0B6BFF",
  "voice": { "equalizer": { "preset": "clarity" } }
}
```

## Environment variables

The most used ones. `.env.example` documents all of them, including each backend's models and voices.

### Voice backend

| Variable                                                               | Default | What it does                                                                                                            |
| ---------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `VOICE_PROVIDER`                                                       | `mock`  | The default backend: `mock`, `openai`, `gemini`, `grok`, `doubao`, `pipeline`, `local`, `local-realtime`, `max-speech`. |
| `VOICE_PROVIDER_SWITCHING`                                             | `on`    | `off` pins every session to the default. Otherwise a client may choose any backend that is set up.                      |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DOUBAO_API_KEY`, … |         | Each backend's credentials. See [voice backends](backends.md).                                                          |
| `PIPELINE_LLM_IMAGES`                                                  | `off`   | `on` lets users show the assistant pictures on the `pipeline` backend. Set it only for a chat model that can see them.  |
| `LOCAL_LLM_IMAGES`                                                     | `off`   | The same for the `local` and `max-speech` backends, which share `LOCAL_LLM_*`. See [pictures](backends.md#pictures).    |

### Security and access

| Variable                | Default | What it does                                                                                               |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `RELAY_AUTH_TOKEN`      | none    | The relay's secret. Once set, `/agent` needs it, a [session token](security.md#session-tokens) or a login. |
| `RELAY_ALLOWED_ORIGINS` | any     | Comma-separated origins allowed to open `/agent` from a browser, such as `https://www.example.com`.        |
| `RELAY_CONN_PER_MINUTE` | `30`    | `/agent` connection attempts per minute per client address.                                                |
| `RELAY_TRUST_PROXY`     | `off`   | `on` behind a reverse proxy, so rate limits see the real client address (`RELAY_TRUSTED_PROXY_HOPS` hops). |
| `AUTH_REGISTRATION`     | `on`    | Whether people may create accounts on the relay's own web app. The first account is the admin.             |

Behind Caddy, nginx or any other proxy, `RELAY_TRUST_PROXY=on` is required: with it off, every visitor shares the proxy's
address and one of them can use up the login and connection limits for everyone. See
[deployment](deployment.md#reverse-proxy-with-tls).

### Monitoring and logs

| Variable        | Default | What it does                                                                                                      |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN` | none    | Turns on `GET /metrics` (Prometheus text format) for `Authorization: Bearer <token>`. Unset: the endpoint is 404. |
| `LOG_FORMAT`    | `text`  | `json` writes one JSON object per line: `time`, `level`, `scope`, `message` and the event's fields.               |
| `LOG_LEVEL`     | `info`  | `debug`, `info`, `warn` or `error`.                                                                               |

`METRICS_TOKEN` is its own secret, separate from `RELAY_AUTH_TOKEN`, so a monitoring system can read counters without
being able to open voice sessions. Use a long random value (`openssl rand -hex 32`). What `/metrics` exports is listed in
[deployment](deployment.md#metrics).

Code in the relay can add its own numbers to `/metrics` with `registerMetricsSource(() => ({ ... }))` from
`server/prometheus.ts`. Each key becomes a metric name (camelCase is snake-cased and `max_` is prefixed). A name ending
in `_total` is exposed as a counter, anything else as a gauge.

### Conversation records and analysis

All of these are off until set. See [after the conversation](conversations.md#after-the-conversation).

| Variable                           | Default  | What it does                                                                                                                                                       |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONVERSATION_WEBHOOK_URL`         | off      | POSTed a signed `conversation.ended` record when each conversation ends. HTTPS, or plain HTTP to a local or private host.                                          |
| `CONVERSATION_WEBHOOK_SECRET`      | none     | Signs those requests, exactly like [tool webhooks](tools.md#verifying-the-signature).                                                                              |
| `CONVERSATION_LOG_FILE`            | off      | A file the same record is appended to, one JSON object per line.                                                                                                   |
| `CONVERSATION_RECORDING`           | off      | `phone` records the audio of phone calls, `on` of every conversation. See [recording the audio](conversations.md#recording-the-audio).                             |
| `CONVERSATION_RECORDING_DIR`       | none     | Where the recordings go, one WAV file for each conversation. Required for recording.                                                                               |
| `CONVERSATION_RECORDING_KEEP_DAYS` | for ever | Delete recordings older than this many days (1 to 3650).                                                                                                           |
| `ANALYSIS_LLM_BASE_URL`            | none     | An OpenAI-compatible endpoint for the `analysis` key. Without it, the pipeline's chat model or a local one is used.                                                |
| `ANALYSIS_LLM_API_KEY`             | none     | That endpoint's key.                                                                                                                                               |
| `ANALYSIS_LLM_MODEL`               | none     | The model for the analysis. Falls back to `PIPELINE_LLM_MODEL`, then `gpt-4o-mini` (or `LOCAL_LLM_MODEL`, then `qwen3:8b`, for a local model).                     |
| `GUARDRAILS_LLM_BASE_URL`          | none     | An OpenAI-compatible endpoint that judges `guardrails.rules` and `userRules`. Without it, the analysis model above. See [guardrails](conversations.md#guardrails). |
| `GUARDRAILS_LLM_API_KEY`           | none     | That endpoint's key.                                                                                                                                               |
| `GUARDRAILS_LLM_MODEL`             | none     | The model that judges. Alone, it changes only the model name.                                                                                                      |

### Knowledge base

See [turning on embeddings](tools.md#turning-on-embeddings). Off until `KNOWLEDGE_EMBEDDINGS_MODEL` is set.

| Variable                        | Default                             | What it does                                                                                  |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `KNOWLEDGE_EMBEDDINGS_MODEL`    | off                                 | An embeddings model. Turns on hybrid (keyword and meaning) search of the knowledge base.      |
| `KNOWLEDGE_EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1`         | An OpenAI-compatible `/embeddings` endpoint. HTTPS, or plain HTTP to a local or private host. |
| `KNOWLEDGE_EMBEDDINGS_API_KEY`  | `OPENAI_API_KEY`                    | The key. `OPENAI_API_KEY` is used only with the default OpenAI URL.                           |
| `KNOWLEDGE_EMBEDDINGS_CACHE`    | `<studio dir>/knowledge-embeddings` | A directory where vectors are cached across restarts, or `off`.                               |
| `KNOWLEDGE_MAX_PASSAGES`        | `100000`                            | The most passages that get embeddings. Above it the whole knowledge base stays on keywords.   |

### Tracing

Conversations are exported as OpenTelemetry traces (OTLP over HTTP with JSON) when an endpoint is set. See
[tracing](conversations.md#tracing).

| Variable                             | Default     | What it does                                                               |
| ------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | none        | The collector's base URL; `/v1/traces` is added.                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none        | The full traces URL. Wins over the one above.                              |
| `OTEL_EXPORTER_OTLP_HEADERS`         | none        | Headers on every export, as `name=value,name2=value2`, values URL-encoded. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`  | none        | The same, for traces only. Wins when it is not empty.                      |
| `OTEL_SERVICE_NAME`                  | `max-relay` | The service name on the spans.                                             |
| `OTEL_SDK_DISABLED`                  | off         | `true` turns tracing off.                                                  |
| `MAX_TRACE_CONTENT`                  | off         | `on` adds what was said to the spans (redacted per `privacy.redact`).      |

### Phone calls

Set `TWILIO_AUTH_TOKEN` to turn phone calls on through Twilio, or `TELNYX_WEBHOOK_SECRET` and `TELNYX_PUBLIC_KEY` for
Telnyx. Both carriers can be set.
See [phone calls](telephony.md).

| Variable                     | Default | What it does                                                                                                                     |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_AUTH_TOKEN`          | none    | Your Twilio auth token. Turns telephony on and checks Twilio's webhook signatures.                                               |
| `TWILIO_ACCOUNT_SID`         | none    | Needed to transfer calls and place outbound calls.                                                                               |
| `TWILIO_PHONE_NUMBER`        | none    | The number outbound calls come from, in E.164 form.                                                                              |
| `TELEPHONY_PUBLIC_URL`       | derived | The relay's public address as Twilio reaches it. Set it behind a proxy or a tunnel.                                              |
| `TELEPHONY_TRANSFER_NUMBERS` | none    | Where the assistant may transfer a call: `support=+14155550100,sales=sip:sales@example.com`.                                     |
| `TELEPHONY_MAX_CALLS`        | `20`    | Simultaneous calls, 1 to 1000, on each carrier.                                                                                  |
| `CAMPAIGNS_FILE`             | none    | Where [call campaigns](telephony.md#calling-a-list-of-numbers) are kept between restarts. Without it they are lost at a restart. |
| `TELNYX_WEBHOOK_SECRET`      | none    | The secret in the voice URL you give Telnyx. With the public key, turns Telnyx calls on.                                         |
| `TELNYX_PUBLIC_KEY`          | none    | Your Telnyx account's public key. Required: it checks Telnyx's signature on every media stream.                                  |
| `TELNYX_API_KEY`             | none    | With `TELNYX_ACCOUNT_SID`: needed to transfer calls and place outbound calls.                                                    |
| `TELNYX_ACCOUNT_SID`         | none    | Your Telnyx account id.                                                                                                          |
| `TELNYX_APPLICATION_SID`     | none    | The TeXML application outbound calls are placed through.                                                                         |
| `TELNYX_PHONE_NUMBER`        | none    | The Telnyx number outbound calls come from, in E.164 form.                                                                       |
| `TELNYX_UNSIGNED_STREAMS`    | off     | `allow` runs Telnyx without the public key. See [phone calls](telephony.md#how-the-relay-knows-it-is-telnyx) first.              |

### Noise suppression

A browser cleans up its own microphone. A phone call from a street, or a device with a bare microphone, does not, and
a fan or traffic can make a model think the user is speaking. With `NOISE_SUPPRESSION=phone` or `on`, the relay runs
[RNNoise](https://jmvalin.ca/demo/rnnoise/), a small neural noise suppressor, over the microphone audio before any
backend hears it. It works the same for every backend.

- It costs about 0.2 ms of CPU for each 10 ms of audio, and adds 20 ms of delay.
- Steady noise (fans, hum, hiss, road noise) is removed almost entirely. A second person talking is not noise to it.
- Web clients already have the browser's own suppression, so `phone` is the usual choice. Use `on` for devices.
- OpenAI Realtime has its own setting as well, `OPENAI_NOISE_REDUCTION`: see [voice backends](backends.md#openai).

In the relay's tests it is run on a recorded voice in fan noise: the voice comes through within 3 dB of its level and
the noise between words drops by more than 20 dB.

### WebRTC

Set `WEBRTC=on` to let web clients send audio over WebRTC instead of the WebSocket. See [WebRTC transport](webrtc.md).

| Variable              | Default | What it does                                                                                      |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `WEBRTC`              | off     | `on` turns the transport on.                                                                      |
| `WEBRTC_PUBLIC_IP`    | none    | The relay's public IP addresses, comma-separated. Needed behind NAT.                              |
| `WEBRTC_UDP_PORTS`    | any     | The UDP port range to use, such as `50000-50100`. Open it in the firewall.                        |
| `WEBRTC_ICE_SERVERS`  | none    | STUN and TURN servers for the relay, as a JSON list. The relay contacts none unless you set this. |
| `WEBRTC_MAX_SESSIONS` | `100`   | Simultaneous WebRTC sessions, 1 to 5000, and never more than the port range holds.                |

### Behaviour

| Variable                                    | Default        | What it does                                                                              |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `ASSISTANT_CONFIG`                          | none           | Path of the config file, or `off`.                                                        |
| `STUDIO_DIR`                                | `~/.max-relay` | Where the Studio keeps its config, logo and saved backend keys.                           |
| `AGENT_WAKE_WORD`                           | `on`           | `off` turns the wake word off for every assistant.                                        |
| `NOISE_SUPPRESSION`                         | `off`          | `phone` cleans the audio of phone calls, `on` of every session. See below.                |
| `VOICE_EQUALIZER_ADJUSTABLE`                | `on`           | `off` stops users changing the voice equaliser.                                           |
| `RELAY_IDLE_TIMEOUT_MS`                     | `600000`       | Closes a session with no client traffic after this long (close code 4001).                |
| `RELAY_HEARTBEAT_MS`                        | `30000`        | How often the relay pings clients to find dead connections.                               |
| `PORT`                                      | `8787`         | The relay's port.                                                                         |
| `USAGE_MONTHLY_MINUTES`                     | off            | Voice minutes each user may use per month. See [usage and billing](usage-and-billing.md). |
| `USAGE_WEBHOOK_URL`, `USAGE_WEBHOOK_SECRET` | off            | Where each finished session's usage is POSTed, and its signing secret.                    |
