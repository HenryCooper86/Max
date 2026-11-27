# Usage and billing

The relay counts how many voice minutes each of your users spends. Use it to see where your model budget goes, to give
each user a monthly allowance, or to bill your own customers. It needs no billing provider. Three settings cover it:

| Setting                 | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `GET /v1/usage`         | Minutes, sessions and tool calls per user for a month. Always on.     |
| `USAGE_MONTHLY_MINUTES` | A monthly allowance per user. Off unless set.                         |
| `USAGE_WEBHOOK_URL`     | Each finished session, POSTed to your billing system. Off unless set. |

## What is counted

- **Minutes** are the time a voice connection is open, by the second. A 90-second session is 1.5 minutes.
- **The user** is whoever the session belongs to: the `userId` your backend put on the
  [session token](security.md#session-tokens), or the signed-in account of the relay's own app. Sessions with neither
  are counted as `anonymous`.
- **Months** are calendar months in UTC, such as `2026-11`. A session is booked to the month it ended in.
- **Tool calls** are counted per session too, for reporting.

Totals are kept in `usage.json` in the relay's data directory (`STUDIO_DIR`), for the last 24 months.

If that file is there but cannot be read, or is not a usage file (a disk that filled up in the middle of a write can
leave one behind), the relay does not carry on as if it were the first run: that would give everybody their monthly
allowance again. It moves the file aside as `usage.json.corrupt-<time>`, logs an error and answers `503` at `/ready`
with `usage-storage-unavailable`. It goes on doing so across restarts for as long as a `usage.json.corrupt-*` file sits
beside `usage.json`, and while one does, the relay saves nothing:

- Totals start from what the relay can read, which is nothing until a good file is put back. `GET /v1/usage` and
  `USAGE_MONTHLY_MINUTES` do not see anything counted before the relay last started.
- What is counted meanwhile stays in memory and is not added to the ledger. Each finished session is still POSTed to
  `USAGE_WEBHOOK_URL`, so a billing system fed by the webhook misses nothing.

With `USAGE_MONTHLY_MINUTES` set, no new voice session is taken meanwhile, because the allowance would otherwise start
again from zero at every restart. Every `/agent` upgrade is refused with HTTP 503, Max Cloud project sessions included
(see [refusals](protocol.md#refusals)), and a phone call is refused once its audio reaches the relay. Sessions already
running go on. Without it the meter only reports: sessions and calls go on being admitted, and the minutes counted
meanwhile are not added to the ledger.

To recover, deal with the kept copy and start the relay again: put a good `usage.json` back (a backup, or the kept copy
once repaired) and delete or move the kept copy away, or just delete it to start the ledger again from empty. A good
file put back earlier is read, but not written to, until the kept copy is gone.

If the damaged file cannot be moved aside, it stays as it is: nothing is written to it, and the relay stays unready
until it is repaired and started again.

So the one thing to get right is the user. Mint session tokens with your own customer or account id:

```js
// Your backend
const response = await fetch("https://voice.example.com/v1/session-tokens", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ userId: customer.id, ttlSeconds: 600 })
});
```

## See usage

```bash
curl -H "Authorization: Bearer $RELAY_AUTH_TOKEN" "https://voice.example.com/v1/usage?month=2026-11"
```

```json
{
  "month": "2026-11",
  "limitMinutes": 500,
  "totals": { "sessions": 42, "minutes": 318.5, "seconds": 19110, "toolCalls": 57 },
  "users": [{ "userId": "cus_8f2", "sessions": 12, "minutes": 140.25, "seconds": 8415, "toolCalls": 30 }]
}
```

`month` defaults to the current month. Add `userId=cus_8f2` for one user. The endpoint needs the relay token.
On Max Cloud the same address answers a project key (`mpk_…`) with that project's usage per user: see
[Usage per end user on Max Cloud](#usage-per-end-user-on-max-cloud).

## Set a monthly allowance

```bash
USAGE_MONTHLY_MINUTES=500
```

Each user may then use 500 voice minutes a month, counting the session in progress. When they run out, the relay sends
an `error` event ("This account has used all of its voice minutes for this month.") and closes the connection with code
`4003`. New connections are refused the same way until the month ends. A
session in progress is checked every 15 seconds, so it can run up to 15 seconds past the allowance. The web SDK treats `4003` as final and does not
reconnect. Sessions without a user are never limited, so give every session a `userId` if you rely on the allowance.

For different allowances per plan, run the check in your own backend before minting a token: read the user's minutes
from `GET /v1/usage?userId=…`, and refuse to mint when they are over their plan.

## Send usage to your billing system

```bash
USAGE_WEBHOOK_URL=https://billing.example.com/voice-usage
USAGE_WEBHOOK_SECRET=a-long-random-string
```

When each voice session ends, the relay POSTs:

```json
{
  "type": "session.usage",
  "sessionId": "8c1d…",
  "userId": "cus_8f2",
  "startedAt": 1763452800000,
  "endedAt": 1763452890000,
  "seconds": 90,
  "minutes": 1.5,
  "toolCalls": 2
}
```

With a secret set, the request is signed exactly like [webhook tools](tools.md#verifying-the-signature):
`x-voice-agent-signature` is `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`, and
`x-voice-agent-timestamp` is the time in epoch milliseconds. Answer with any 2xx status. A failed delivery is retried
twice, then logged; `GET /v1/usage` is the record to reconcile against. The URL must be HTTPS, or plain HTTP to a local
or private host.

### Example: Stripe metered billing

Create a [billing meter](https://docs.stripe.com/billing/subscriptions/usage-based) named `voice_seconds` in Stripe
(meter values are whole numbers, so meter seconds and set the price per second: $0.02 a minute is $0.000333 a second),
put that metered price on your customers' subscriptions, and forward each session:

```js
import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.post("/voice-usage", express.raw({ type: "application/json" }), async (req, res) => {
  if (!verify(req.body.toString("utf8"), req.headers, process.env.USAGE_WEBHOOK_SECRET)) return res.sendStatus(401);
  const usage = JSON.parse(req.body.toString("utf8"));
  if (!usage.userId) return res.sendStatus(204); // anonymous sessions are not billed
  await stripe.billing.meterEvents.create({
    event_name: "voice_seconds",
    identifier: usage.sessionId, // Stripe ignores a repeated delivery of the same session
    timestamp: Math.floor(usage.endedAt / 1000),
    payload: { stripe_customer_id: usage.userId, value: String(Math.ceil(usage.seconds)) }
  });
  res.sendStatus(204);
});
```

`verify` is the function from the [tools guide](tools.md#verifying-the-signature). This assumes your session tokens
carry the Stripe customer id as `userId`; otherwise look it up from your own id first. Paddle, Lago, Orb or your own
database work the same way: the webhook gives you one line per session.

## Pricing your product

The relay meters minutes; what you charge is up to you. Your cost per minute is mostly your model provider's realtime
audio price plus a little hosting. Check your provider's current price list, add your margin, and consider a free
allowance so people can try your product before they pay.

## Max Cloud billing

A relay running [Max Cloud](cloud.md) bills its customers' projects from their prepaid balance by different rules from
the metering above, because there money changes hands:

- **The clock starts when the agent can talk.** A Max Cloud session is billed from the moment the project's voice model
  (OpenAI Realtime, Gemini Live or Grok Voice) has accepted the session, not from when the socket connected. The time
  spent opening the socket, sending `session.start` and waiting for the model is free.
- **Upstream outages are not billed.** If the model drops mid-session, the clock stops while the relay reconnects to it
  and starts again once it is back. A session whose model never connects, or which ends because the model stayed down,
  is booked at 0 seconds.
- **The clock stops when the connection closes**, whoever closes it.
- Each session is booked once, rounded up to the whole second, against the month's free seconds first and then the
  balance at ¥0.15 a minute (rounded up to the whole fen).
- **Months** are calendar months in UTC. A session that crosses midnight at a month's end is booked whole to the month
  it **ended** in: its seconds count against that month's free allowance and appear in that month's usage, and none in
  the month it started in. A session booked early, in several entries (next point), is the exception: all of its
  entries belong to the month of the first.
- **A session booked early is still one charge.** A session the relay booked up to a checkpoint because it looked
  abandoned (see below), and that was in fact still running, has the rest booked when it closes, as a second ledger
  entry whose reference ends in `:rest:1`. Nothing is rounded a second time: the session costs what its paid seconds
  cost at ¥0.15 a minute, rounded up to the whole fen once, and the second entry charges only what the first left of
  that unpaid. Both entries belong to the month of the first, and the rest takes its free seconds from that month's
  allowance.
- **Running sessions are checked every 5 seconds.** A session starts only when the customer has at least 5 seconds
  left, and is closed with code `4003` when their balance, the project's monthly minutes limit or the per-user limit
  of the user the session names runs out, so a customer can go at most 5 seconds per open session past what they had.
- **A crash loses at most 5 seconds.** Sessions are checkpointed every 5 seconds; a session cut off by a crash or a
  killed relay is booked up to its last checkpoint once the relay that ran it has been silent for a minute.
- **A store outage ends sessions after 30 seconds.** While the database cannot be read or written, the 5-second check
  cannot see a balance, so new sessions are refused (code `1013`) and a running session, a Studio test included, is
  closed the same way once its checks have failed one after the other for 30 seconds, with "Max Cloud could not check
  this conversation's balance for 30 seconds, so it has ended it." It is charged in full once the database is back.
  The most a customer can go past what they had, even through an outage, is 30 seconds plus one check interval per
  open session.
- **Nothing is lost when the database refuses a write.** A session whose booking fails (a full disk, a locked
  database) is kept and booked by a later retry, every 15 seconds, exactly once.

The relay-wide meter above still counts a Max Cloud session's whole connection time under `project:<id>`; it is not
what the customer pays.

### Usage per end user on Max Cloud

Max Cloud also meters per end user, so a customer can cap and bill the people who talk to their agent:

- **The user is the `userId` on the session token** their backend mints with the project key. Each session's billed
  seconds are counted for that user, per project and per UTC calendar month, in the same transaction as its charge; a
  session without a `userId` (the website embed, the Studio's tests) is counted as `anonymous`.
- **Per-user monthly minutes limit** (the Studio's **Settings**) caps each user of the project. At the limit, the token
  mint for that user is refused (`403`), their new sessions are refused, and their open ones are closed with code
  `4003` ("This user has used their minutes for this month.") at the next 5-second check; the next month starts it
  again. Sessions without a `userId` are never held by it, so mint tokens with a `userId` when using it. A `userId` of
  `anonymous` is refused at the mint.
- **The report**: `GET /v1/usage?month=2026-11` with the project key, the same shape as above without `toolCalls`,
  with `users` paged by `limit` and `offset` and `userCount` saying how many users there are; and the project's
  **Usage** tab in the console. See [Max Cloud](cloud.md#usage-per-user).
- **Per conversation**: the conversation webhook the project's server receives carries the user as `session.userId`.

The rows are kept for every month until the project is deleted. Counting began with the release that brought it:
sessions booked before it are in the ledger and in no user's row, so in the month of the upgrade the report and the
per-user limit see less than the ledger holds.
