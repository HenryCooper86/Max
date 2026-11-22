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

## Background tools

Some work takes longer than anyone should wait in silence: building a report, placing a booking, searching a slow
system. Mark such a tool with `"background": true` and the conversation does not wait for it:

```json
{
  "name": "make_sales_report",
  "description": "Builds the sales report for a quarter. It takes a while.",
  "parameters": { "type": "object", "properties": { "quarter": { "type": "string" } }, "required": ["quarter"] },
  "background": true,
  "webhook": { "url": "https://api.example.com/reports", "timeoutMs": 300000 }
}
```

In a code tool it is the same field: `defineTool({ name, description, background: true, timeoutMs: 300_000, handler })`.

A tool the page runs takes the same mark in its declaration, and in the web SDK it is one more field:

```ts
defineClientTool({
  name: "export_page",
  description: "Exports this page as a PDF. It takes a while.",
  background: true,
  handler: () => exportPdf()
});
```

For a tool of a [remote MCP server](#remote-mcp-servers), name it in that server's `backgroundTools`:

```json
{
  "mcpServers": [
    {
      "name": "reports",
      "url": "https://reports.example.com/mcp",
      "backgroundTools": ["make_sales_report"],
      "backgroundTimeoutMs": 300000
    }
  ]
}
```

What happens:

1. The assistant calls the tool. The relay answers the model at once that the work has started, and the assistant
   tells the user so.
2. The conversation carries on. The user can ask other things, and what they say does not cancel the work.
3. When your webhook, handler or MCP server returns, the relay gives the model the result, and the assistant tells the
   user at the next quiet moment: not over the user, and not in the middle of another answer.

A failure is reported the same way. Things to know:

- A background webhook may take up to 10 minutes (`timeoutMs`, default 2 minutes), and so may a background MCP tool
  (`backgroundTimeoutMs`, default 2 minutes). A code tool keeps the default of 15 seconds unless you set `timeoutMs`.
- A background tool in the page has two minutes. The web SDK gives up on the handler a little earlier, after 110
  seconds, so that its own answer is the one the model gets. A relay older than this feature ignores the mark and
  waits 15 seconds for the tool, as for any other.
- `backgroundTools` takes the names the MCP server gives its tools, before `prefix`. A name the server does not have,
  or one that `allowedTools` leaves out, is reported as a problem.
- One conversation can have four background tools running at once. A fifth call is refused, and the model is told why.
- The work ends when the conversation does. The handler's `signal` is aborted, and a webhook request is cancelled. If
  the work must finish whatever happens, have your webhook start it and return, and deliver the outcome another way.
- While a background tool runs, the assistant does not ask the user whether they are still there.
- The page sees the usual [`tool.activity`](#showing-progress) events: `started` at once, `succeeded` or `failed` when
  the work ends.
- A background tool in the page ends when the page goes: a reload or a closed tab loses the work, and the model is
  told that the app did not answer.

Tried with a local model (`qwen3:8b` through Ollama) and a webhook that takes six seconds: the assistant said the
report had started after 1.5 seconds, answered another question in the meantime, and read the result out when the
webhook returned. Not tried against OpenAI Realtime or Gemini Live servers, where the same relay code runs but the
model decides how it words things.

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

An [MCP](https://modelcontextprotocol.io) server publishes a set of tools, over HTTP or as a
[program the relay runs](#mcp-servers-the-relay-runs-itself). List one in `assistant.config.json`
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

| Key                   | Type         | What it does                                                                                                                     |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | string       | Required. Letters, digits, `_` and `-`, starting with a letter, at most 32 characters. Used in logs and problems.                |
| `url`                 | string       | Required. The server's MCP endpoint.                                                                                             |
| `headers`             | object       | Headers sent on every request, usually the credential.                                                                           |
| `allowedTools`        | string array | The tools to offer, by the names the server gives them. Absent: all of the server's tools.                                       |
| `prefix`              | string       | Letters, digits and `_`, starting with a letter or `_`, at most 24 characters. The tool `list_events` becomes `cal_list_events`. |
| `timeoutMs`           | number       | How long each request may take. Default 15000, at most 60000.                                                                    |
| `backgroundTools`     | string array | Tools the conversation does not wait for, by the names the server gives them. See [background tools](#background-tools).         |
| `backgroundTimeoutMs` | number       | How long a call of a background tool may take. Default 120000, at most 600000.                                                   |

How it works:

- **Streamable HTTP.** For a `url` the relay speaks the MCP Streamable HTTP transport (protocol revision 2025-06-18):
  every message is a POST to `url`, answered with a JSON body or an event stream. It does not speak the older
  SSE-only transport. Anything a server sends on its own, such as requests to the client, is ignored. A server that
  is a program on the relay's machine is named by a `command` instead: see
  [MCP servers the relay runs itself](#mcp-servers-the-relay-runs-itself).
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

### MCP servers the relay runs itself

Many MCP servers are not services but programs: you start one and talk to it over its standard input and output
(the `stdio` transport). Give an entry a `command` in place of a `url` and the relay starts the program when it
starts, keeps it running, and stops it when it stops.

```json
{
  "mcpServers": [
    {
      "name": "files",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"],
      "env": { "API_KEY": "${FILES_API_KEY}" },
      "allowedTools": ["read_text_file", "list_directory"],
      "prefix": "files"
    }
  ]
}
```

| Key       | Type         | What it does                                                                                                  |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `command` | string       | The program to start: a path, or a name found on `PATH`. In place of `url`; an entry has one or the other.    |
| `args`    | string array | Its arguments, up to 64. They are passed as they are: there is no shell, so no quoting, `~`, `$VAR` or pipes. |
| `env`     | object       | Variables for the program, up to 32. `${NAME}` in a value is filled from the relay's environment.             |
| `cwd`     | string       | The directory to start it in. Without it: the relay's own.                                                    |

`name`, `allowedTools`, `prefix`, `timeoutMs`, `backgroundTools` and `backgroundTimeoutMs` work as above; `headers`
belong to a `url`. The limits on tools, what the assistant is given back and the retry of a server that is not
available are the same.

- **Only the config file names a command.** Nothing that arrives over the network can add or change one: Admin →
  Studio and Admin → Flow carry `mcpServers` over as they are, and a client cannot send any. Whoever can write the
  config file can run a program as the relay's user, which was already so through `toolsModule`.
- **The program does not get the relay's environment.** The relay's environment holds its model keys. The program
  gets `PATH`, `HOME`, the user's name, the locale, the time zone and the temporary directory (on Windows, the
  equivalents), and what you list under `env`. A `${NAME}` the relay does not have keeps the program from being
  started at all, so it never runs with a blank credential.
- **It is a program with the relay's rights.** It can read and write what the relay's user can. Give it only the
  directories and keys it needs, list `allowedTools`, and consider [rules for what tools
  return](conversations.md#guardrails) when it reads what others wrote.
- **If the program stops**, the call that was under way fails (what it had done by then is not known, so it is not
  sent again) and the next call starts the program again, at most once every three seconds. A program that cannot be
  started at all is retried like a server that is down.
- **What the program writes to its standard error** is its log and appears in the relay's log as `mcp files: …`.
  So does a line on its standard output that is not a message.
- A message is one line of at most 1 MiB; a program that sends a longer one is stopped. Requests the program makes
  of the relay are refused, except `ping`. A call that times out or is cancelled is reported to the program
  (`notifications/cancelled`).
- When the Studio saves a config the tools are loaded again: the relay starts the program anew and then stops the
  old one, so for a moment two are running.
- Tested with a server of our own that speaks the protocol, through a conversation with a local model: listing
  tools, calls, a program that was killed and started again, and the relay stopping with its program. Not run
  against the published servers; `npx` in the example downloads and runs a package, so read what you install.

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
The 20 MiB limit decides how many passages you can reach: at the default `chunkChars` of 900 it is about 22,000 passages,
and at 200 it is about 100,000. A CSV file gives one passage per row, so it can give more.

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

| Variable                        | Default                             | What it does                                                                                         |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `KNOWLEDGE_EMBEDDINGS_MODEL`    | off                                 | The embeddings model, for example `text-embedding-3-small`. Embeddings are off without it.           |
| `KNOWLEDGE_EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1`         | An OpenAI-compatible endpoint. HTTPS, or plain HTTP to a local or private host.                      |
| `KNOWLEDGE_EMBEDDINGS_API_KEY`  | `OPENAI_API_KEY`                    | The key. `OPENAI_API_KEY` is used only for the default OpenAI URL, never for another host.           |
| `KNOWLEDGE_EMBEDDINGS_CACHE`    | `<studio dir>/knowledge-embeddings` | A directory for the embeddings cache, or `off`. The studio dir is `STUDIO_DIR`, else `~/.max-relay`. |
| `KNOWLEDGE_MAX_PASSAGES`        | `100000`                            | The most passages that get embeddings. Above it, the whole knowledge base stays on keyword search.   |

Any server that answers `POST {base URL}/embeddings` in the OpenAI format works: a hosted API, or a local server such as
Ollama (`http://localhost:11434/v1`), which needs no key.

**How it behaves.**

- The relay embeds the passages in the background after it starts, so startup does not wait. Until the vectors are
  ready, and if embedding fails, search stays on keywords. A failure is a warning in the log, not an error.
- Passages go to the endpoint in batches of 64, two requests at a time. A batch that fails with a timeout, a network
  error, a 429 or a 5xx, a reply that is not JSON, or a reply with the wrong number of vectors is tried again after 1, 2
  and 4 seconds. If a 429 or 503 carries a `Retry-After` of a number of seconds, the relay waits that long instead, at most
  30 seconds. After four tries the relay gives up and logs a warning that keyword search stays on. With the cache on and
  saving working, what was already embedded is kept, and the next start resumes. Without the cache, it is lost. Any other
  error, such as a 401, is not retried.
  The log shows a line at the start, one for each tenth, and one at the end.
- At most `KNOWLEDGE_MAX_PASSAGES` passages are embedded, 100,000 by default. A larger knowledge base logs a warning
  and nothing is embedded: the whole knowledge base stays on keyword search, not just the passages over the limit.
- Each question adds one embeddings request. If it fails or takes longer than 2 seconds, that question is answered by
  keyword search. Questions are not cached.
- A bad URL or a missing key is listed with the other knowledge problems, and search stays on keywords.

### The embeddings cache

The relay keeps the vectors on disk, so a restart does not embed again what has not changed. Each entry is a hash of the
endpoint URL, the model name and the passage text, with its vector. Change the model or the URL and nothing matches, so
everything is embedded again. Edit one file and only its changed or new passages are embedded.

- The cache is one file, `vectors.bin`, in `KNOWLEDGE_EMBEDDINGS_CACHE` (default `knowledge-embeddings` in the studio
  directory). Set the variable to `off` to keep nothing on disk. The relay creates the directory with mode 0700 if
  it is missing (an existing directory keeps its mode), and writes the files with mode 0600.
- It holds hashes and vectors, not passage text, the URL, the model name or the key. A vector is still derived from
  your text, so treat the file as private.
- The vectors are stored as 32-bit floats: about 148 MiB for 100,000 passages at 384 dimensions, and about 587 MiB at 1536. Sizes below are in MiB (1 MiB is 1,048,576 bytes).
- While embedding runs, the relay saves what it has done in extra `part-*.bin` files, so a start that is stopped
  resumes where it was. When embedding finishes, it writes one `vectors.bin` with exactly the current passages and
  removes the parts. Entries for passages that no longer exist are dropped then.
- Files are written to a temporary name and renamed into place. A cache file that is missing, truncated, damaged or
  of an unexpected size is ignored with a line in the log, and the passages are embedded again. A cache that cannot be
  written is logged once and the relay carries on without it.
- If the model returns vectors of a different size than the cached ones, the relay embeds everything again and replaces
  the cache. When every passage was found in the cache, it notices this at the first question, which that question
  answers by keyword search.
- Give each relay its own cache directory. When a relay finishes embedding it removes the part files it read or wrote
  and rewrites `vectors.bin` with only its own passages. Two relays with different knowledge bases that share one
  directory will each drop the other's entries, and embed them again at the next start. A cache file that is not a
  regular file (a link, a FIFO), is over 2 GiB, or is the 1,001st or later part file is ignored with a line in the log.
- It does not check that a vector in a well-formed file is right. To start over, delete the directory.

### Size and speed

Search keeps the vectors in one block of memory and compares each question with all of them. It does not build a vector
index, so the cost grows in step with the number of passages and the vector size. These were measured on an Apple M5 Max
laptop, with Node.js, 100,000 synthetic passages of about 80 words and random vectors, in one process, with a local
cache directory:

| Measurement                                                | 384 dimensions | 1536 dimensions |
| ---------------------------------------------------------- | -------------- | --------------- |
| Hybrid question, median / 95th percentile of 100 questions | 21 / 23 ms     | 75 / 90 ms      |
| Cache file                                                 | 148 MiB        | 587 MiB         |
| Writing the cache                                          | 71 ms          | 206 ms          |
| Reading the cache, restart with nothing to embed           | 48 ms          | 93 ms           |
| Whole start with nothing to embed (read and assemble)      | about 190 ms   | about 260 ms    |
| Memory, index and vectors loaded                           | about 790 MiB  | about 1,220 MiB |

Building the keyword index took 2.6 seconds, and a keyword question took 0.03 ms at the median and under 0.4 ms at the
95th percentile. The hybrid times do not include the question's own embeddings request, which depends on the endpoint.
The keyword index alone takes about 640 MiB of memory at this size. Loading a cache of 1536-dimension vectors briefly
holds the file and the vectors in memory together.

Not measured: embedding 100,000 passages through a real endpoint (so the time of a first start and its cost at a
hosted API are unknown), real documents instead of synthetic text, other machines or Linux, many questions at once, and
passage counts above 100,000. The relay was not run for these numbers. They came from the search and cache code
called directly.

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
