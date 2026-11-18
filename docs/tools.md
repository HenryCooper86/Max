# Tools

A tool is a function the assistant can call in the middle of a conversation: look up an order, check stock, book a
table, open a page. The model decides when to call one from its name, description and parameters. The relay runs it,
or asks your page to, and the model continues its answer with the result.

There are three kinds. A session can use all three at once.

| Kind        | Runs                       | Declared in                                | Use it for                                          |
| ----------- | -------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Code tool   | Inside the relay (Node.js) | a module named by `toolsModule`            | Logic you can write in TypeScript or JavaScript     |
| Webhook     | On any server you own      | `tools` in `assistant.config.json`         | Existing backends, other languages, private systems |
| Client tool | In the browser or app      | `tools` in the SDK (`session.start.tools`) | What only the client can do: navigate, show, fill   |

Backends with tool support: OpenAI Realtime, Gemini Live, Grok Voice, the pipeline backends and the keyless demo for
`"device": "app"` assistants. Doubao has no function calling, so its sessions run without tools.

## Defining a tool

Every tool has three parts the model reads:

- `name`: letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters. Use verbs:
  `get_order_status`, `book_table`.
- `description`: what it does and when to use it, at most 1024 characters.
- `parameters`: a JSON Schema object describing the arguments, at most 8 KiB. Omit it for a tool without arguments.

```json
{
  "name": "get_order_status",
  "description": "Look up the status and delivery estimate of an order by its order number, for example A-1042.",
  "parameters": {
    "type": "object",
    "properties": {
      "orderId": { "type": "string", "description": "The order number, such as A-1042." }
    },
    "required": ["orderId"]
  }
}
```

A tool returns any JSON value or text. The model receives it as the tool's result, capped at 16 KiB. To report a
failure, throw (code tools), answer with a non-2xx status (webhooks) or return `error` (client tools). The model is
told the tool failed and why, and says so instead of guessing.

Server tools win over client tools with the same name, and a declaration that is malformed is skipped with a warning
in the relay's log, so one broken tool never takes the others down.

## Code tools

Name a module in `assistant.config.json`, relative to that file:

```json
{ "toolsModule": "./agent-tools.ts" }
```

Its default export is a list of tools made with `defineTools`:

```ts
import { defineTool, defineTools } from "./server/tools/index";

export default defineTools([
  defineTool<{ orderId: string }>({
    name: "get_order_status",
    description: "Look up the status and delivery estimate of an order by its order number, for example A-1042.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    },
    timeoutMs: 8000, // default 15000
    async handler({ orderId }, context) {
      const response = await fetch(`https://api.example.com/orders/${encodeURIComponent(orderId)}`, {
        headers: { authorization: `Bearer ${process.env.ORDERS_API_KEY}` },
        signal: context.signal // aborted on timeout or when the session ends
      });
      if (response.status === 404) throw new Error(`There is no order ${orderId}.`);
      const order = await response.json();
      if (order.customerId !== context.userId) throw new Error("That order belongs to another customer.");
      return { status: order.status, estimatedDelivery: order.eta };
    }
  })
]);
```

The handler's second argument is the call's context:

| Field       | What it is                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------- |
| `callId`    | Unique id of this call                                                                       |
| `sessionId` | The relay session the call belongs to                                                        |
| `language`  | The language the session speaks, such as `en`                                                |
| `userId`    | The signed-in account, or the `userId` your backend put on the session token. Absent if none |
| `signal`    | An `AbortSignal`; pass it to `fetch` and other cancellable work                              |
| `log`       | `info` and `warn`, written to the relay's log with the tool's name                           |

`defineTool` and `defineTools` only add type checking. A module that exports a plain array of
`{ name, description, parameters, handler }` objects works too, and needs no import from this repository: useful when
the module is mounted into a container or lives in another repository.

The module is loaded when the relay starts; restart it after changing tools. Code tools run in the relay's process
with its permissions, so they are as trusted as the relay itself.

## Webhook tools

Declare the tool in `assistant.config.json` with a `webhook`:

```json
{
  "tools": [
    {
      "name": "get_order_status",
      "description": "Look up an order by its order number, for example A-1042.",
      "parameters": {
        "type": "object",
        "properties": { "orderId": { "type": "string" } },
        "required": ["orderId"]
      },
      "webhook": {
        "url": "https://api.example.com/voice/order-status",
        "headers": { "x-api-key": "${ORDERS_API_KEY}" },
        "secret": "${ORDERS_WEBHOOK_SECRET}",
        "timeoutMs": 8000
      }
    }
  ]
}
```

- `url` must be `https:`. Plain `http:` is accepted only for hosts that never cross the internet: `localhost`,
  `.local` and `.internal` names, private IP ranges and single-label service names on a Docker or Kubernetes network.
- `${NAME}` in the URL, a header value or the secret is replaced with the relay's environment variable `NAME` on every
  call. Secrets stay in `.env`, out of the config file. If a variable is missing, the call fails without being sent.
- `timeoutMs` defaults to 10 seconds, at most 60.

The relay sends:

```http
POST /voice/order-status HTTP/1.1
content-type: application/json
x-api-key: …
x-voice-agent-timestamp: 1763452800000
x-voice-agent-signature: sha256=5d41402abc4b2a76b9719d911017c592…

{"tool":"get_order_status","callId":"call_8f2…","arguments":{"orderId":"A-1042"},"session":{"id":"4b1e…","language":"en","userId":"user-17"}}
```

Answer with any 2xx status. A JSON body reaches the model as JSON, anything else as text. Any other status fails the
call. If the body is JSON with an `error` string, that string is the reason the assistant is given:

```json
{ "error": "There is no order A-9999. Ask the customer to check the number." }
```

Redirects are not followed, and responses over 256 KiB are refused.

### Verifying the signature

With `secret` set, every request is signed: `x-voice-agent-signature` is `sha256=` followed by the hex
HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the secret, and `x-voice-agent-timestamp` is the time in epoch
milliseconds. Check both, against the raw body before parsing it:

```js
// Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const timestamp = headers["x-voice-agent-timestamp"] ?? "";
  const signature = headers["x-voice-agent-signature"] ?? "";
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false; // refuse replays
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

```python
# Python
import hashlib, hmac, time

def verify(raw_body: bytes, headers, secret: str) -> bool:
    timestamp = headers.get("x-voice-agent-timestamp", "")
    signature = headers.get("x-voice-agent-signature", "")
    if not timestamp.isdigit() or abs(time.time() * 1000 - int(timestamp)) > 5 * 60_000:
        return False
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, "sha256=" + digest)
```

[`examples/web-embed/server.mjs`](../examples/web-embed/server.mjs) is a complete webhook server with no dependencies.

## Client tools

Client tools run where the user is: in the page or the app. The SDK declares them in `session.start`, and runs them
when the relay sends `tool.call`:

```js
const agent = new VoiceAgent({
  url: "https://voice.example.com",
  token: fetchToken,
  tools: [
    {
      name: "open_page",
      description: "Open a page of the website: pricing, docs or contact.",
      parameters: {
        type: "object",
        properties: { page: { type: "string", enum: ["pricing", "docs", "contact"] } },
        required: ["page"]
      },
      handler: ({ page }) => {
        router.push(`/${page}`);
        return { opened: page };
      }
    }
  ]
});
```

With the widget, set the element's `tools` property. A client tool must answer within 15 seconds or the call fails.
The page controls these tools completely, so never make one the only guard on something that matters (a payment, a
deletion): do that in a server tool, which can check `userId`.

Custom clients implement the same exchange: see `tool.call` and `tool.result` in the [protocol](protocol.md).

## Showing progress

Every call, wherever it runs, produces `tool.activity` events: `started`, then `succeeded` or `failed` with its
duration. The SDK emits them as `toolactivity`:

```js
agent.on("toolactivity", ({ name, state }) => {
  if (state === "started") spinner.show(`Using ${name}…`);
  else spinner.hide();
});
```

The relay's status line also reads "Ava is using get_order_status" while a tool runs.

## Trying tools without a model

With `VOICE_PROVIDER=mock` and `"device": "app"`, type a tool's name into the widget (with `text-input`), optionally
followed by JSON arguments:

```text
get_order_status {"orderId": "A-1042"}
```

The demo calls the tool exactly as a model would, through the same code path, and reads out the result. This is the
fastest way to develop a tool.

## Writing tools a model uses well

- **Describe when to use it, not only what it does.** "Look up an order by its number. Use when the customer asks
  where their order is or when it will arrive."
- **Keep parameters few and typed.** Use `enum` for fixed choices and `description` for formats ("ISO date, such as
  2026-11-18").
- **Return facts, not prose.** `{ "status": "shipped", "eta": "Friday" }` lets the model phrase the answer in the
  user's language and in its own voice.
- **Return small results.** Pick the fields the assistant needs. Large results are slower, cost more and are cut at
  16 KiB.
- **Make failures useful.** "No order A-9999; ask the customer to check the number" leads to a better reply than
  "404".
- **Be quick.** The user is waiting in silence. The assistant may say "let me check" first, but aim for under two
  seconds.

## Security

Treat every argument as untrusted input: a user can talk the model into calling a tool with anything. Validate
arguments in the tool, and decide what the caller may see or do from `userId` (which your backend controls through the
session token), never from what the model passes in. More in [security](security.md).
