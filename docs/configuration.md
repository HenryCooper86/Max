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

### Security and access

| Variable                | Default | What it does                                                                                               |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `RELAY_AUTH_TOKEN`      | none    | The relay's secret. Once set, `/agent` needs it, a [session token](security.md#session-tokens) or a login. |
| `RELAY_ALLOWED_ORIGINS` | any     | Comma-separated origins allowed to open `/agent` from a browser, such as `https://www.example.com`.        |
| `RELAY_CONN_PER_MINUTE` | `30`    | `/agent` connection attempts per minute per client address.                                                |
| `RELAY_TRUST_PROXY`     | `off`   | `on` behind a reverse proxy, so rate limits see the real client address (`RELAY_TRUSTED_PROXY_HOPS` hops). |
| `AUTH_REGISTRATION`     | `on`    | Whether people may create accounts on the relay's own web app. The first account is the admin.             |

### Behaviour

| Variable                                    | Default        | What it does                                                                              |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `ASSISTANT_CONFIG`                          | none           | Path of the config file, or `off`.                                                        |
| `STUDIO_DIR`                                | `~/.max-relay` | Where the Studio keeps its config, logo and saved backend keys.                           |
| `AGENT_WAKE_WORD`                           | `on`           | `off` turns the wake word off for every assistant.                                        |
| `VOICE_EQUALIZER_ADJUSTABLE`                | `on`           | `off` stops users changing the voice equaliser.                                           |
| `RELAY_IDLE_TIMEOUT_MS`                     | `600000`       | Closes a session with no client traffic after this long (close code 4001).                |
| `RELAY_HEARTBEAT_MS`                        | `30000`        | How often the relay pings clients to find dead connections.                               |
| `PORT`                                      | `8787`         | The relay's port.                                                                         |
| `USAGE_MONTHLY_MINUTES`                     | off            | Voice minutes each user may use per month. See [usage and billing](usage-and-billing.md). |
| `USAGE_WEBHOOK_URL`, `USAGE_WEBHOOK_SECRET` | off            | Where each finished session's usage is POSTed, and its signing secret.                    |
