# Getting started

This guide takes you from a fresh clone to a voice agent inside your own web app, then to a production setup. It
takes about fifteen minutes. You need Node.js 22.13 or newer. An API key for a voice model is optional until step 4.

## 1. Install

```bash
git clone https://github.com/HenryCooper86/Max.git && cd Max
npm install
npm run build:sdk   # builds the browser SDK the relay serves at /sdk/
```

## 2. Create your assistant

An assistant is one JSON file. Create `assistant.config.json` in the repository root:

```json
{
  "name": "Ava",
  "device": "app",
  "developer": "Your Company",
  "languages": ["en"],
  "greeting": "Hi, I'm Ava. What can I help you with?",
  "instructions": "You are the voice assistant of the Your Company website. Answer questions about our plans and help visitors find the right page. Keep answers to two or three sentences."
}
```

If you have used the relay's Admin → Studio before, the config it saved (in `~/.max-relay/`) takes
precedence over this file; pass `ASSISTANT_CONFIG=assistant.config.json` to be sure which one runs.

`"device": "app"` makes it a software assistant: it answers without a wake word and has no wearable behaviour (no
riding context, torch or navigation). `instructions` is where your product knowledge and house rules go. Every key is
described in the [configuration reference](configuration.md). Prefer a wizard? Run `npm run setup`.

## 3. Run the relay with the keyless demo

```bash
VOICE_PROVIDER=mock npx tsx server/index.ts
```

The relay listens on <http://localhost:8787>. Check it:

```bash
curl -s http://localhost:8787/health | head -c 300
```

The demo backend needs no account. It hears when you speak (but cannot understand speech), answers typed messages and
runs your tools for real. That is enough to build and test the whole integration before choosing a model. The relay keeps its own data (accounts,
Studio settings, session history for the QA screens) in `~/.max-relay/`; set `STUDIO_DIR` and `HOME` to keep
it elsewhere.

## 4. Use a real voice model

Copy the environment template and pick a backend:

```bash
cp .env.example .env
```

Then set, for example:

```bash
VOICE_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Other choices are Gemini Live (`gemini` + `GEMINI_API_KEY`), Grok Voice (`grok` + `XAI_API_KEY`), a cascaded pipeline
that works with almost any chat model (`pipeline`), or models on your own hardware (`local`). See
[voice backends](backends.md). Restart the relay after editing `.env`.

## 5. Put the agent on a page

Any page can load the widget from the relay. Save this as `test.html` in a new, empty folder outside this checkout and
open it through a local web server, because browsers only allow the microphone on `http://localhost` or HTTPS. For
example, run `npx serve -l tcp://127.0.0.1:3000` in that folder and open <http://localhost:3000/test.html>. A static
server publishes every file in the folder it serves, including `.env` files, and by default `serve` listens on every
network interface, so never point it at the checkout:

```html
<!doctype html>
<html lang="en">
  <body>
    <h1>My product</h1>
    <script src="http://localhost:8787/sdk/voice-agent.iife.js"></script>
    <voice-agent relay="http://localhost:8787" language="en" text-input></voice-agent>
  </body>
</html>
```

Press the microphone button and talk, or with the demo backend type into the text box. That is the whole integration
while the relay is open. Before you put it on the
internet, close the relay (step 7).

To build your own interface instead of the widget, use `VoiceAgent` or the React hook from the
[SDK reference](../sdk/README.md).

## 6. Give it a tool

Tools let the agent read your data and act. Create `agent-tools.ts` in the root of this checkout, next to your config.
The relay loads it from the path in `toolsModule` (resolved against the config file), and `defineTool` comes from
`server/tools/index.ts` in the checkout, so the import below is relative to the file's own location. If you keep the file
elsewhere, adjust that path. The helpers only add type checking: a module that default-exports a plain array of tools
needs no import at all.

```ts
import { defineTool, defineTools } from "./server/tools/index";

export default defineTools([
  defineTool<{ plan: string }>({
    name: "get_plan_price",
    description: "Get the monthly price of a subscription plan: starter, team or enterprise.",
    parameters: {
      type: "object",
      properties: { plan: { type: "string", enum: ["starter", "team", "enterprise"] } },
      required: ["plan"]
    },
    handler({ plan }) {
      const prices = { starter: 0, team: 29, enterprise: "custom" };
      return { plan, monthlyPriceUsd: prices[plan as keyof typeof prices] };
    }
  })
]);
```

Point the config at it and restart the relay:

```json
{ "toolsModule": "./agent-tools.ts" }
```

The relay logs `tools ready {"tools":["get_plan_price"]}`. Ask "How much is the team plan?" With the demo backend,
type `get_plan_price {"plan": "team"}` instead. Your tools can also live on your own backend as webhooks, or in the
page itself. See the [tools guide](tools.md).

## 7. Lock it down for production

An open relay lets anyone who finds its URL spend your model quota. Before you deploy:

1. **Set a relay secret** in the relay's `.env`:

   ```bash
   RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
   ```

2. **Mint session tokens from your backend.** Browsers never see the secret. They get a token that expires in minutes
   and opens voice sessions only:

   ```js
   // Your backend (Express shown; any language works)
   app.post("/api/voice-token", requireLogin, async (req, res) => {
     const response = await fetch("https://voice.example.com/v1/session-tokens", {
       method: "POST",
       headers: { authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}`, "content-type": "application/json" },
       body: JSON.stringify({ ttlSeconds: 600, userId: req.user.id, context: `Customer plan: ${req.user.plan}` })
     });
     res.status(response.status).json(await response.json()); // { token, expiresAt }
   });
   ```

   `userId` reaches your tools, so they can check what this user may see. `context` reaches the assistant, and the
   browser cannot change it.

3. **Point the widget at your endpoint** with `token-url="/api/voice-token"`, or pass `token: async () => …` to
   `VoiceAgent`. A new token is fetched before every connect and reconnect.

4. **Allow only your sites:** `RELAY_ALLOWED_ORIGINS=https://www.example.com,https://app.example.com`.

5. **Serve it over HTTPS** behind a reverse proxy that passes WebSocket upgrades. The [deployment guide](deployment.md)
   has Docker, Caddy and nginx recipes, and [security](security.md) explains each control.

## Where next

- [The web shop example](../examples/web-embed/): a backend that mints tokens, a signed webhook tool, a code tool and a
  client tool, all working together.
- [Protocol](protocol.md): connect a native app, a game engine or a device in any language.
- [Hardware and audio](audio/README.md): run the agent on your own microphone and speaker.
