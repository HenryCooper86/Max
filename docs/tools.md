# Tools

A tool is a function the assistant can call in the middle of a conversation: look up an order, check stock, book a
table, open a page. The model decides when to call one from its name, description and parameters. The relay runs it,
or asks your page to, and the model continues its answer with the result.

There are three kinds. A session can use all three at once. Two more sources, [remote MCP servers](#remote-mcp-servers) and
a [knowledge base](#knowledge-base), add tools to the same list from your configuration.

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

## Remote MCP servers

An [MCP](https://modelcontextprotocol.io) server publishes a set of tools over HTTP. List one in `assistant.config.json`
and the relay connects to it at startup, asks which tools it has, and offers each of them to the assistant as an
ordinary server tool. Calls are forwarded to the server. This gives the assistant a calendar, a CRM or a search service
without glue code.

```json
{
  "mcpServers": [
    {
      "name": "calendar",
      "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "Bearer ${CALENDAR_MCP_TOKEN}" },
      "allowedTools": ["list_events", "create_event"],
      "prefix": "cal",
      "timeoutMs": 10000
    }
  ]
}
```

| Key            | Type         | What it does                                                                                                                     |
| -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string       | Required. Letters, digits, `_` and `-`, starting with a letter, at most 32 characters. Used in logs and problems.                |
| `url`          | string       | Required. The server's MCP endpoint.                                                                                             |
| `headers`      | object       | Headers sent on every request, usually the credential.                                                                           |
| `allowedTools` | string array | The tools to offer, by the names the server gives them. Absent: all of the server's tools.                                       |
| `prefix`       | string       | Letters, digits and `_`, starting with a letter or `_`, at most 24 characters. The tool `list_events` becomes `cal_list_events`. |
| `timeoutMs`    | number       | How long each request may take. Default 15000, at most 60000.                                                                    |

How it works:

- **Streamable HTTP only.** The relay speaks the MCP Streamable HTTP transport (protocol revision 2025-06-18): every
  message is a POST to `url`, answered with a JSON body or an event stream. It does not run local `stdio` servers or
  speak the older SSE-only transport. Anything a server sends on its own, such as requests to the client, is ignored.
- **The URL rule is the webhook rule.** `url` must be `https:`. Plain `http:` is accepted only for hosts that never cross
  the internet: `localhost`, `.local` and `.internal` names, private IP ranges and single-label service names. Redirects
  are not followed.
- **`${NAME}` is filled from the relay's environment** in the URL and in header values, on every request, as for
  [webhook tools](#webhook-tools). A missing variable fails the request without sending it, so a blank credential is
  never sent. Keep keys in `.env`, out of the config file.
- **Limits.** At most 8 servers, 64 tools from each (the rest are skipped with a warning), and at most 10 pages of the
  server's tool list. A response over 1 MiB is refused. Each tool's name, description and parameters follow the
  [same rules as any tool](#defining-a-tool). A tool that breaks them, or whose name is already taken by an earlier tool
  (code tools come first, then webhook tools, then the knowledge base, then MCP), is skipped with a warning and the
  others still load.
- **Sessions.** The relay performs the MCP handshake and keeps the session id the server hands out. If the server forgets
  the session (it restarted: HTTP 404 or 400), the relay performs the handshake again once and retries the request.
- **The tool list is read once**, when the relay starts. A server that adds tools later needs a relay restart.
- **A server that is down does not stop the relay.** The others load, the assistant runs without that server's tools, and
  the relay logs "`calendar` MCP server is not available". The relay tries that server again after 15 seconds, then after
  a minute, then every five minutes, and offers its tools to new sessions as soon as it answers. A server that answers
  with no tools at all is not retried.

What the assistant is given back:

- The text of the result. Several text parts are joined with new lines.
- A part that is not text (an image, audio, a resource) is replaced by a placeholder such as `[image]`. The model never
  sees the content, so tell it in your `instructions` not to promise what it cannot see.
- A result with no text and a `structuredContent` object is given as that JSON.
- A result marked as an error, or a JSON-RPC error, fails the call with the server's message, and the assistant says so.
  Errors the relay raises name the server and at most an HTTP status, never a header or the URL, which may hold a key.
- As with every tool, the result is cut at 16 KiB.

A tool list comes from someone else's server and goes into the model's prompt. Offer only what you need with
`allowedTools`, use a server you trust, and give it the narrowest credential that does the job. A tool from a remote
server runs with that server's powers, not with the user's: decide who may do what in the server, not in the prompt.
To limit which agent may use a tool, see [`agents`](conversations.md#several-agents-and-handing-over); the names there
include the `prefix`.

## Knowledge base

Give the assistant your own documents (policies, prices, opening hours, product facts) and it searches them with a
`search_knowledge` tool and answers from what it finds, instead of guessing.

```json
{
  "knowledge": {
    "files": ["./knowledge", "./faq.md"],
    "text": "Opening hours: 9 to 6, Monday to Saturday. Closed on public holidays.",
    "maxResults": 4,
    "chunkChars": 900
  }
}
```

A string or a list of paths is a shorthand for `{ "files": … }`.

| Key          | Type                   | Default | What it does                                              |
| ------------ | ---------------------- | ------- | --------------------------------------------------------- |
| `files`      | string or string array | none    | Files and folders, relative to the config file's folder.  |
| `text`       | string                 | none    | Facts written straight into the config file, in Markdown. |
| `maxResults` | number, 1 to 8         | `4`     | Passages returned by one search.                          |
| `chunkChars` | number, 200 to 2000    | `900`   | The target size of a passage, in characters.              |

Give `files`, `text` or both. A value outside a range is clamped to it.

**What is read.** Files ending in `.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.json` or `.csv`. A folder is read
including its sub-folders down to four levels, skipping names that start with a dot, `node_modules` and symbolic links.
At most 500 files, 2 MiB each and 20 MiB together. A file that is too large, unreadable or of another type is skipped with
a line in the relay's startup log, and the rest load. The index is built in memory when the relay starts, so restart it
after changing a file. If nothing could be indexed, the assistant has no `search_knowledge` tool and the relay says so.

**How it is split.** Markdown and HTML are cut at headings, and each passage remembers its heading trail
(`Returns > Refunds`). Paragraphs are packed up to `chunkChars`, and a very long paragraph is split at sentence ends.
A JSON file that is a list of objects, and each row of a CSV file, becomes one passage of `key: value` lines (CSV uses the
header row for the keys). Other JSON is indexed as text.

**How it searches.** By default it is keyword search (BM25 ranking), not embeddings. Nothing is sent over the network,
it costs nothing per query and it behaves the same offline. Words are lower-cased, simple English endings are folded
(`returns`, `returned` and `returning` meet, as do `price` and `pricing`), common words are dropped from the query, and
a code such as `A-1042` is matched whole and in parts. Words in a heading count double. Chinese, Japanese and Korean text,
which has no spaces, is indexed by single characters and neighbouring pairs, so it works without a word list. Other
alphabetic scripts, such as Cyrillic, are split into words.

Because it matches words and not meaning, it does not know that "money back" means "refund". Write your documents with
the words your users use, and put alternatives in: "Refunds (money back)". A question that shares no word with the right
passage finds nothing, and the assistant is told to say it does not know. To search by meaning as well, turn on
[embeddings](#turning-on-embeddings).

**What the model sees.** `search_knowledge` takes a `query` string. It returns up to `maxResults` passages as
`{ "results": [{ "source": "faq.md", "heading": "Returns", "text": "…" }] }`, cut to 6000 characters in all, or an empty
list with a note to say it does not know. Its description tells the model to call it before answering any question about
the business's facts, and to answer only from what comes back. Passages are your own text, so keep anything secret
out of the folder: whatever a passage says can be said to any user.

### Turning on embeddings

Set `KNOWLEDGE_EMBEDDINGS_MODEL` to the name of an embeddings model and the relay searches by meaning as well as by
word. This is hybrid search: each question is ranked by BM25 and by vector similarity, and the two rankings are merged
(reciprocal rank fusion). "Money back" then finds a passage about refunds that shares no word with it, while a code such
as `A-1042` is still found by its characters. A semantic match needs a cosine similarity of at least 0.25. That
removes the plainly unrelated passages, but a question your knowledge base does not cover can still bring back a weakly
related passage where keyword search would find nothing, so keep the instruction to answer only from what is found.

| Variable                        | Default                     | What it does                                                                               |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `KNOWLEDGE_EMBEDDINGS_MODEL`    | off                         | The embeddings model, for example `text-embedding-3-small`. Embeddings are off without it. |
| `KNOWLEDGE_EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1` | An OpenAI-compatible endpoint. HTTPS, or plain HTTP to a local or private host.            |
| `KNOWLEDGE_EMBEDDINGS_API_KEY`  | `OPENAI_API_KEY`            | The key. `OPENAI_API_KEY` is used only for the default OpenAI URL, never for another host. |

Any server that answers `POST {base URL}/embeddings` in the OpenAI format works: a hosted API, or a local server such as
Ollama (`http://localhost:11434/v1`), which needs no key.

**How it behaves.**

- The relay embeds the passages in the background after it starts, so startup does not wait. Until the vectors are
  ready, and if embedding fails, search stays on keywords. A failure is a warning in the log, not an error.
- At most 5,000 passages are embedded. A larger knowledge base logs a warning and stays on keyword search.
- The vectors are held in memory and computed again at every start. A hosted embeddings API is billed for the whole
  knowledge base each time the relay starts.
- Each question adds one embeddings request. If it fails or takes longer than 2 seconds, that question is answered by
  keyword search.
- A bad URL or a missing key is listed with the other knowledge problems, and search stays on keywords.

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
