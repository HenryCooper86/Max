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
