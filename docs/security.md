# Security

This page explains what the relay protects, what it leaves to you, and how to run it safely on the internet. To report
a vulnerability, see [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

The relay sits between untrusted clients (browsers, apps, devices) and expensive, privileged services (voice model
APIs, your own backend through tools). The risks, in the order that usually matters:

| Risk                                                     | Control                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Someone steals your model API key.                       | Keys stay on the relay. Clients never receive them.                                                                 |
| Someone finds the relay URL and runs up your bill.       | `RELAY_AUTH_TOKEN`, short-lived session tokens, origin allowlist, rate limits, idle close.                          |
| A web page leaks a long-lived secret.                    | Pages use session tokens, never the relay token.                                                                    |
| A page or user makes the assistant do something harmful. | Tools are an allowlist you write. Authorise inside the tool, by user. See [tool authors](#advice-for-tool-authors). |
| A forged request reaches your tool endpoint.             | HMAC-signed webhooks with a timestamp.                                                                              |
| Text from the page steers the assistant.                 | Client `context` is framed as information, not instructions.                                                        |
| A tool returns a huge or hostile payload.                | Output capped at 16 KiB; webhook response capped at 256 KiB; redirects refused.                                     |
| Someone reads QA transcripts or accounts.                | Testing and admin routes need the relay token or an admin login.                                                    |

Out of scope: the relay does not moderate what a model says, and it cannot stop a determined user with a valid token
from using the session it grants. Keep tokens short-lived and rate limits on.

## Keys never leave the relay

Voice backend keys (`OPENAI_API_KEY`, `DOUBAO_API_KEY` and the rest) are read from the relay's environment. No event
or HTTP response carries them. Clients only say which backend they would like (`voiceProvider`), and the relay
refuses any backend it has no key for.

Keys entered in the relay's Studio admin screen are stored in `voice-backends.json` in the data directory
(`STUDIO_DIR`) with file mode 600.

Do not commit `.env`. It is in `.gitignore` and `.dockerignore`.

## Who may connect

`/agent` accepts a connection when any of these is true:

1. The relay is open: `RELAY_AUTH_TOKEN` is empty and no user account exists.
2. The URL carries `?token=` with the relay token.
3. The URL carries a live session token (`vst_...`).
4. The URL carries the login token of a signed-in user.

Always set `RELAY_AUTH_TOKEN` on a relay that is reachable from the internet. Generate it with
`openssl rand -hex 32`. The relay compares tokens in constant time.

`/ready` reports `access-control-not-configured` when `NODE_ENV=production` and neither a relay token nor
accounts exist. See [deployment](deployment.md#health-and-readiness).

### The relay token

The relay token is the operator's master key. It opens voice sessions, mints session tokens, reads QA data and can
register devices. Use it only from your own backend, scripts and trusted devices. Never put it in a web page, a mobile
app bundle or a public repository. Query strings often reach proxy and CDN logs, so prefer session tokens for anything
that leaves your control.

### Session tokens

Session tokens let a browser on any site use the relay without holding the secret.

**Mint flow**

1. The user opens your page. Your backend authenticates them in your own way.
2. Your backend calls the relay with the relay token:

   ```bash
   curl -s -X POST http://localhost:8787/v1/session-tokens \
     -H "Authorization: Bearer $RELAY_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"ttlSeconds": 600, "userId": "user-17", "context": "Signed-in shopper: Sam, gold tier."}'
   ```

   ```json
   { "token": "vst_...", "expiresAt": 1763440000000 }
   ```

3. Your backend returns the token to the page. The page connects to `/agent?token=vst_...`.

**Rules**

| Field        | Rule                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `ttlSeconds` | A whole number from 30 to 3600. Default 600. The token works for reconnects until it expires. |
| `userId`     | Optional. A non-empty string of at most 128 characters.                                       |
| `context`    | Optional. At most 4000 characters.                                                            |

**What a token grants.** Voice sessions on `/agent` until it expires. Nothing else: not the admin routes, not the QA
data, not device registration, not the phone companion link, and not minting more tokens.

**What a token carries.** `userId` and `context` are stamped on every session the token opens. The client cannot change
them. `userId` reaches your tools, in webhook payloads (`session.userId`) and code-tool handlers (`ctx.userId`). The token's
`context` is added to the assistant's instructions as session information from your backend, ahead of any context the
client sends. Authorise users by this `userId`, not by anything the page says.

**Lifetime.** Tokens live in the relay's memory. A restart revokes every token, which is the safe direction to fail in.
Make your backend fetch a fresh token when a connect is refused with 401. The SDK's token callback does this on each
connect and reconnect. The relay keeps at most 50,000 live tokens and drops the oldest first.

**Who may mint.** The relay token. On a relay with no protection at all (no relay token, no accounts) anyone may mint,
which grants nothing the open relay does not already give. The endpoint has no CORS headers on purpose: call it from a
server, not from a browser.

### Origin allowlist

`RELAY_ALLOWED_ORIGINS` is a comma-separated list such as `https://shop.example.com,https://app.example.com`. A browser
whose `Origin` is not on the list gets 403. It stops other websites from using a token they scraped from your page.

It guards browsers only. Native apps and server clients send no `Origin` header and pass this check, so the token
remains the control for them. Never treat the origin as authentication.

### Rate limits

| Setting                    | Default | What it limits                                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `RELAY_CONN_PER_MINUTE`    | 30      | `/agent` upgrade attempts per client IP, in a sliding 60 s window. 429 beyond. `0` turns it off. |
| `AUTH_ATTEMPTS_PER_MINUTE` | 10      | Login and registration attempts per client IP.                                                   |
| `RELAY_IDLE_TIMEOUT_MS`    | 600000  | Closes sessions with no client traffic (code 4001).                                              |
| `RELAY_HEARTBEAT_MS`       | 30000   | Drops dead connections.                                                                          |
| `RELAY_MAX_PAYLOAD_BYTES`  | 393216  | Largest single WebSocket message.                                                                |

Behind a reverse proxy, set `RELAY_TRUST_PROXY=on` and `RELAY_TRUSTED_PROXY_HOPS` to the number of proxies. Otherwise every
client shares the proxy's address and the per-IP limit becomes a global one. Set it only when a proxy you control
overwrites `X-Forwarded-For`: with the setting on and no proxy, a client can forge its own address.

The relay has no limit on the number of concurrent sessions or on spend. Set spending limits with your model vendor.

### Accounts

The relay has its own optional user accounts for its web app and QA tooling. The first registered account becomes the
admin, and from then on authentication is on. Set `AUTH_REGISTRATION=off` once your team has signed up so strangers
cannot register. Login sessions last `AUTH_SESSION_DAYS` (default 30). The `/testing` and `/auth/admin` routes need the
relay token or a login, and clearing data needs an admin. Accounts are stored in `accounts.json` in the data directory.

If you only embed the SDK, you do not need accounts: use the relay token and session tokens.

## Tools and webhooks

### Relay-side limits

- Tool names must match `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`. A client may declare at most 32 tools, each with a description
  of at most 1024 characters and a parameter schema of at most 8 KiB.
- A relay-side tool wins over a client tool with the same name, so a page cannot shadow your server tools.
- Output returned to the model is capped at 16 KiB. Webhook responses larger than 256 KiB fail the call.
- Every call ends with exactly one result for the model, whatever happens: error, hang, closed session. A client tool must
  answer within 15 seconds.

### Webhook URL rules

A webhook receives what the user asked for, so the relay sends it over HTTPS:

- `https://` URLs are always allowed.
- Plain `http://` is allowed only where traffic does not cross the internet: `localhost` and loopback addresses,
  names ending in `.local`, `.localhost` or `.internal`, private ranges (`10.x`, `192.168.x`, `172.16-31.x`, `fc00::/7`),
  and single-label hostnames such as `http://orders:8080`, the form Docker and Kubernetes services use.
- A tool with any other URL is dropped at startup with the reason in the log.
- The relay refuses HTTP redirects, so a webhook cannot bounce a request somewhere unexpected.

The relay does not block webhooks that point at private addresses; the owner writes the config. Do not build webhook URLs
from user input.

### Secrets in config: `${ENV}`

`${NAME}` in a webhook URL, header value or `secret` is replaced with the relay's environment variable at call time. Keep
credentials in `.env`, not in `assistant.config.json`:

```json
{
  "webhook": {
    "url": "https://api.example.com/voice/order-status",
    "headers": { "Authorization": "Bearer ${ORDER_API_KEY}" },
    "secret": "${TOOL_WEBHOOK_SECRET}"
  }
}
```

If a referenced variable is missing the call fails closed with an error that names it, instead of sending a blank
credential.

### Signed requests

When `webhook.secret` is set, every request carries two headers:

```text
x-voice-agent-timestamp: 1763440000123
x-voice-agent-signature: sha256=<hex>
```

The signature is `hex(HMAC_SHA256(secret, timestamp + "." + body))`, where `timestamp` is the header value (epoch
milliseconds, as a string) and `body` is the raw request body exactly as received. Verify before you parse the body:

1. Reject if either header is missing.
2. Reject if the timestamp is more than a few minutes from your clock (replay protection).
3. Recompute the HMAC over `timestamp + "." + rawBody` and compare in constant time.

**Node**

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyVoiceAgentRequest(headers, rawBody, secret, maxAgeMs = 5 * 60_000) {
  const timestamp = String(headers["x-voice-agent-timestamp"] ?? "");
  const signature = String(headers["x-voice-agent-signature"] ?? "");
  if (!timestamp || !signature) return false;
  if (!Number.isFinite(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > maxAgeMs) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`rawBody` must be the string or bytes you read from the socket. If your framework parses JSON first, capture the raw
body (for Express, `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`).

**Python**

```python
import hashlib
import hmac
import time


def verify_voice_agent_request(headers, raw_body: bytes, secret: str, max_age_s: int = 300) -> bool:
    timestamp = headers.get("x-voice-agent-timestamp", "")
    signature = headers.get("x-voice-agent-signature", "")
    if not timestamp or not signature:
        return False
    try:
        if abs(time.time() * 1000 - float(timestamp)) > max_age_s * 1000:
            return False
    except ValueError:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

A working receiver is in [`examples/web-embed/server.mjs`](../examples/web-embed/server.mjs).

Without a `secret`, requests are unsigned and anyone who can reach your endpoint can call it. Always set one for a
public endpoint.

## Untrusted client context

`session.start.context` comes from the client, so a user can edit it. The relay adds it to the assistant's instructions
under a heading that tells the model it is information and not instructions, and that it cannot change the rules. That
reduces risk; it does not remove it, because no prompt is a security boundary.

So:

- Put only convenience facts in client `context` ("the user is on the pricing page").
- Put facts you rely on in the session token's `userId` and `context`, which your backend sets and the client cannot
  change.
- Never put secrets in either. The model can repeat them aloud.

## Advice for tool authors

The model decides when to call a tool and with what arguments. A user can influence the model by speaking, by typing,
and through any text the model reads, including tool results. Treat every tool call as input from an untrusted caller.

- **Validate arguments on the server.** Check types, formats and ranges again in your tool, whatever the schema says.
  The model may send anything.
- **Authorise by `userId`.** Use the `userId` from the session token (`session.userId` in the webhook body, `ctx.userId`
  in code tools) and check the user may see or change that resource. Never trust a user id the model passes as an
  argument.
- **Keep tools narrow.** Prefer `get_order_status(orderId)` to `run_sql(query)` or `http_get(url)`. Do not give the
  model a general capability you would not give an anonymous visitor.
- **Confirm before side effects.** For anything that spends money, deletes data or sends messages, have the tool return
  what it would do and require an explicit confirmation turn, or require a confirmation token from your own UI.
- **Rate limit and log.** Log each call with the `callId`, user and arguments. Limit how often one user can trigger it.
- **Return only what the user may hear.** Tool output goes to the model, which may read it aloud. Leave out internal ids,
  other users' data and secrets.
- **Treat returned text as data.** If a tool returns text written by a third party (a product review, an email), it can
  contain instructions aimed at the model. Strip or summarise it, and do not let such a tool's output trigger a
  sensitive tool without a user confirmation.
- **Fail with a message.** Return `{ "error": "..." }` with a non-2xx status for a webhook, or throw in a code tool.
  The assistant then says the tool failed instead of inventing an answer.

Client tools run in the user's page, so they can be called with any arguments and their results can be forged by the
user. Use them for things only the client can do (navigating, filling a form), never for access control.

## Other defences

- The relay sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, a restrictive Content Security Policy, a
  `Referrer-Policy` of `no-referrer`, and in production `Strict-Transport-Security`.
- JSON request bodies are limited to 32 KB. Slow-client timeouts are set on the HTTP server.
- Per-message WebSocket compression is off.
- A custom logo is served under a policy that lets an SVG draw and nothing else.
- Logs do not contain speech recognition text. Debug logging records lengths and wake decisions only.

The relay does store session transcripts and per-user memory for QA and continuity in its data directory (see
[deployment](deployment.md#data-directory)). Tell your users, and set retention to match your policy.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Follow the private process in [SECURITY.md](../SECURITY.md).
