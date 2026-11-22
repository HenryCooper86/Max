# Phone calls

Let people phone the assistant, and let the assistant phone them. A call reaches the assistant exactly as a web session
does, so every backend, tool and [conversation setting](conversations.md) that works on a web page works on the
phone, with nothing phone-specific to build.

## What you need

- A Twilio account and a phone number that can take voice calls. [Telnyx](#telnyx) works too; the steps below are
  for Twilio, and the Telnyx section says what differs.
- The relay reachable from the internet over HTTPS and WSS, with a certificate Twilio accepts. See
  [deployment](deployment.md) for TLS.
- A [voice backend](backends.md) that supports tools. Hanging up and transferring are tools, so Doubao, which has no
  function calling, cannot do them.

The relay talks to Twilio over Media Streams: Twilio answers the call and streams the audio to the relay over a
WebSocket. There is no SIP trunk (see [limits](#limits)).

## Set it up

1. Set the environment variables below and restart the relay. Telephony is off until `TWILIO_AUTH_TOKEN` is set.
2. In the Twilio console, open your number, and under "A call comes in" choose Webhook, `HTTP POST`, and enter
   `https://<your-relay>/telephony/twilio/voice`.
3. Call the number.

```bash
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TELEPHONY_PUBLIC_URL=https://voice.example.com
```

| Variable                     | Default | What it does                                                                                                                                 |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_AUTH_TOKEN`          | none    | Required. Your account's auth token. It turns telephony on and checks that webhooks really come from Twilio.                                 |
| `TWILIO_ACCOUNT_SID`         | none    | Needed to transfer calls and to place outbound calls (both use Twilio's REST API), not to answer them.                                       |
| `TWILIO_PHONE_NUMBER`        | none    | The Twilio number outbound calls come from, in E.164 form such as `+14155550100`. It is also the caller ID of a transfer.                    |
| `TELEPHONY_PUBLIC_URL`       | derived | The relay's public address as Twilio reaches it, such as `https://voice.example.com`. When unset, the relay uses the address of the request. |
| `TELEPHONY_TRANSFER_NUMBERS` | none    | Where the assistant may transfer a call: `support=+14155550100,sales=sip:sales@example.com`. See [transferring](#transferring-to-a-person).  |
| `TELEPHONY_MAX_CALLS`        | `20`    | Calls at the same time, 1 to 1000. Further calls are answered with a busy signal.                                                            |

Problems with these variables (a number that is not in E.164 form, a transfer list without `TWILIO_ACCOUNT_SID`) are
logged at startup, and the part that is wrong is left off.

Set `TELEPHONY_PUBLIC_URL` behind a reverse proxy or a tunnel. Twilio signs the exact URL it requested, and the relay
checks the signature against its own idea of that URL, taken from `TELEPHONY_PUBLIC_URL`, or else from the request's
`Host` and `X-Forwarded-Proto` headers. If the two differ, the relay refuses the call with HTTP 403 and logs
"rejected a telephony webhook: bad signature".

### How a call flows

```text
caller ── PSTN ── Twilio ──POST /telephony/twilio/voice──▶ relay (TwiML: connect a stream)
                     └─────WS  /telephony/twilio/stream──▶ relay (μ-law 8 kHz both ways)
```

1. Twilio asks the relay what to do with the call. The relay checks Twilio's signature and answers with TwiML that
   connects the call to a bidirectional stream.
2. Twilio opens the stream WebSocket to the relay. The relay checks the ticket it put in the TwiML, starts the
   assistant's session for the call, and tells it the caller's number.
3. Audio flows both ways until someone hangs up.

### Security

- **Twilio's signature.** The voice webhook checks `X-Twilio-Signature`, an HMAC of the full URL and the form fields
  keyed with your auth token. A request without a valid signature gets 403 and no call is set up.
- **A one-time ticket.** Twilio's stream WebSocket carries no credentials, so the voice webhook mints a random ticket and
  puts it in the TwiML as a stream parameter. A stream must present a ticket that is less than 60 seconds old, that has
  not been used before and that belongs to its own call, within 3 seconds of connecting. Otherwise the relay closes
  it. Only calls that Twilio itself signed can open a stream.
- **A webhook cannot be replayed.** Twilio's signature has no timestamp, so a copied request stays valid. A call holds
  one ticket at a time, and once its stream has connected the relay answers that call's webhook with a hang-up for the
  next 24 hours.
- **A call limit.** `TELEPHONY_MAX_CALLS` caps simultaneous calls, so a flood of calls cannot run up your model bill
  without bound. Beyond it, the relay answers `<Reject reason="busy"/>`.
- **Stream connections are rationed until they show a ticket.** The relay accepts a stream connection only while a
  call is waiting for one, and holds at most 8 unproven connections per client address and 64 in all. Calls in
  progress do not count against these, so idle connections cannot keep real calls out. Behind a reverse proxy, set
  `RELAY_TRUST_PROXY=on` (see [deployment](deployment.md)) so the address is the client's and not the proxy's. Without
  it the relay cannot tell clients apart, and only the total of 64 applies.
- **Caller ID is not identity.** The assistant is told the caller's number only when it is a plain phone number, and
  is told that caller ID can be faked. Do not let a tool act on an account because of the number alone.
- **Calls are not QA evidence.** A caller is a member of the public, so nothing they say is kept in the relay's QA
  evidence archive.
- **Transfer destinations are yours.** The model chooses a name from your list and never supplies a number.
- **Outbound calls are owner-only** (see [below](#outbound-calls)).

## What the caller experiences

- **They can interrupt.** When the caller speaks over the assistant, the relay tells Twilio to drop the audio it still
  holds, so the assistant stops at once.
- **Keypad digits arrive as typed turns.** The relay collects the digits a caller presses and sends them to the
  assistant as a typed turn, `(keypad) 1234`. A sequence ends at `#` (not included), after 2 seconds without a key, or
  at 32 digits. `*` and `A` to `D` are passed through as typed. The assistant is told what `(keypad)` means.
- **The assistant can hang up.** On a phone call the assistant always has the `end_session` tool, whatever
  `conversation.endSession` says, and is told to use it when the caller says goodbye or the business is done. After a
  short goodbye the relay lets Twilio finish playing the audio (waiting at most 6 seconds) and closes the stream, which
  ends the call.
- **Prompts for a phone.** The assistant is told that the caller sees nothing and only hears it, to keep sentences short
  and to read numbers and addresses back to confirm them. It is also told that input starting with `(system)` is a
  notice from the phone system, not something the caller said.
- **It knows who is calling.** For an incoming call it is told the caller's number and the number that was dialled. The
  caller's number is information from Twilio, but it can be spoofed, so do not treat it as proof of identity.
- **A hang up from the caller** ends the session, with the reason `caller` in the record.

The other [conversation settings](conversations.md) apply too: `idleReminderSeconds` makes the assistant ask "Are you
still there?" on a silent line, `maxDurationSeconds` caps the length of a call, and `agents` can hand a call to a
specialist.

## Transferring to a person

List the places a call may go, and the assistant gets a `transfer_call` tool:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+14155550100
TELEPHONY_TRANSFER_NUMBERS=support=+14155550123,sales=sip:sales@example.com
```

Each entry is `name=destination`. The name is letters, digits, `_` and `-`, starting with a letter, at most 32
characters. The destination is a phone number in E.164 form or a `sip:` URI. The tool's `destination` argument is one of
the names, so the model can only pick from your list. Tell the assistant when to use it in your `instructions`: "Transfer
to support when the caller asks for a person or reports a fault."

When the assistant calls the tool, it tells the caller in one short sentence that it is transferring them. After it has
finished speaking (or after 12 seconds, if it never does), the relay redirects the call to the destination through
Twilio's REST API. That needs `TWILIO_ACCOUNT_SID`: without it `transfer_call` is not offered at all. If Twilio refuses
the transfer, the assistant is told, apologises and carries on. On success the assistant leaves the call and the
conversation record ends with the reason `transfer`.

## Outbound calls

`POST /v1/calls` makes the assistant phone someone. It needs `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER` and the relay's
token (on Telnyx: `TELNYX_API_KEY`, `TELNYX_ACCOUNT_SID`, `TELNYX_APPLICATION_SID` and `TELNYX_PHONE_NUMBER`). It is never open: without `RELAY_AUTH_TOKEN` set the relay answers 401 ("Set RELAY_AUTH_TOKEN before placing
calls"), because otherwise anyone who found the URL could dial numbers on your Twilio account. Call it only from your
own backend.

```bash
curl -X POST https://voice.example.com/v1/calls \
  -H "Authorization: Bearer $RELAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+14155550142",
    "context": "You are calling Sam Lee to confirm a delivery window for order A-1042 on Friday between 9 and 12.",
    "userId": "cus_8f2",
    "voicemailMessage": "Hello Sam, this is Acme Outdoor about your order. Please call us back on 415 555 0100."
  }'
```

```json
{ "ok": true, "callSid": "CA0123456789abcdef0123456789abcdef" }
```

| Field              | Required | What it is                                                                                                                                         |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `to`               | yes      | The number to call, in E.164 form.                                                                                                                 |
| `context`          | no       | Up to 2000 characters about what the call is for. The assistant treats it as facts from you, so put your own text here and never text from a user. |
| `userId`           | no       | Up to 128 characters. The user the call is counted under for [usage](usage-and-billing.md), and the `userId` your tools see.                       |
| `voicemailMessage` | no       | Up to 500 characters, spoken if a machine answers. Twilio only.                                                                                    |
| `carrier`          | no       | `twilio` or `telnyx`. Only matters with both set up: Twilio places the call unless you name Telnyx.                                                |

The assistant is told that it placed the call, that the person did not expect it, and to say who it is and why it is
calling, followed by your `context`.

The response means that Twilio accepted the call, not that anyone answered. Errors are `{ "ok": false, "error": "…" }`:

| Status | When                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| `400`  | `to` is not in E.164 form, or another field is too long or not text.                                            |
| `401`  | The relay token is missing or wrong, or `RELAY_AUTH_TOKEN` is not set.                                          |
| `429`  | `TELEPHONY_MAX_CALLS` calls are already in progress.                                                            |
| `502`  | Twilio refused the call, or could not be reached.                                                               |
| `503`  | Telephony is not configured (`TWILIO_AUTH_TOKEN`), or `TWILIO_ACCOUNT_SID` or `TWILIO_PHONE_NUMBER` is missing. |

**Answering machines.** The relay asks Twilio to detect who picked up. When it reports a machine, the relay says
`voicemailMessage` (if you gave one) in Twilio's own text-to-speech voice and hangs up, without starting the assistant,
so no model time is spent. A fax machine is hung up on without a message. Detection is Twilio's and not perfect: an
answering machine can be taken for a person, and a person for a machine. The relay keeps the plan for an outbound
call for 5 minutes, so Twilio has to fetch the call's instructions within that time.

## Audio

Phone networks carry G.711 μ-law at 8 kHz. The relay converts it both ways: the caller's audio is decoded and
resampled to the 16 kHz PCM that the relay's [protocol](protocol.md#audio) takes in, and the assistant's 24 kHz audio
is resampled to 8 kHz and encoded in 20 ms μ-law frames. Only the caller's own track is used. Phone audio is
narrow-band, so the assistant sounds different than on a web page: test with real calls.

Callers phone from streets, cars and kitchens. Set `NOISE_SUPPRESSION=phone` to have the relay take steady background
noise out of the caller's audio before the model hears it, which stops a fan or traffic from being taken for speech.
See [noise suppression](configuration.md#noise-suppression).

## Usage, records and traces

- **Usage.** A call counts like any session in [usage and billing](usage-and-billing.md): its minutes and tool calls
  are booked to the `userId` of an outbound call, or to the user `phone` for inbound calls and for outbound calls
  without one. The usage webhook fires when the call ends. With `USAGE_MONTHLY_MINUTES` set, a call is refused at the
  start once that user has used the allowance, and all inbound calls share the one `phone` allowance.
- **Conversation record.** The [conversation webhook](conversations.md#the-conversation-webhook), analysis, log file and
  redaction apply to calls. The record has `session.channel` set to `"phone"` and a `session.phone` block:

  ```json
  "phone": { "direction": "inbound", "from": "+14155550142", "to": "+14155550100", "callSid": "CA0123…" }
  ```

  `direction` is `inbound` or `outbound`. On an outbound call `to` is the person and `from` is your number. `from` and
  `to` are left out when Twilio does not send one, and both read `[phone]` when
  [`privacy.redact`](conversations.md#redacting-personal-data) includes `phone`. `session.endReason` is `caller` when the
  caller hung up, `transfer` when the call was transferred, and `agent`, `idle` or `max_duration` when the relay ended
  it.

- **Traces.** Spans have `voice.channel` set to `phone`. See [tracing](conversations.md#tracing).

## Telnyx

Telnyx works as a second carrier, through TeXML (its dialect of TwiML) and its media streaming. What the caller
experiences, transfers, keypad input, usage and records are the same as above. This section covers what differs.

> This carrier was written to Telnyx's documentation and tested against a stand-in that speaks the documented
> messages. It has not been run on a real Telnyx call yet. Try it on a test number before you rely on it.

### Set it up

1. Make up a secret of at least 16 letters and digits, for example with `openssl rand -hex 24`, and set it as
   `TELNYX_WEBHOOK_SECRET`.
2. Copy your account's public key from the Telnyx portal into `TELNYX_PUBLIC_KEY`. Telnyx calls are off until both
   are set.
3. In the portal, create a TeXML application and set its voice URL to
   `https://<your-relay>/telephony/telnyx/voice?key=<your secret>`. Either method, GET or POST, works. Assign your
   number to the application.
4. Restart the relay and call the number.

```bash
TELNYX_WEBHOOK_SECRET=3f1c…your-own-secret
TELNYX_PUBLIC_KEY=your-account-public-key
TELEPHONY_PUBLIC_URL=https://voice.example.com
```

| Variable                  | Default | What it does                                                                                                       |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `TELNYX_WEBHOOK_SECRET`   | none    | Required. The secret in the voice URL you give Telnyx. At least 16 characters: letters, digits, `-` and `_`.       |
| `TELNYX_PUBLIC_KEY`       | none    | Required. Your account's public key (base64, hex or PEM). The relay checks Telnyx's signature on every stream.     |
| `TELNYX_API_KEY`          | none    | Needed, with `TELNYX_ACCOUNT_SID`, to transfer calls and to place outbound calls.                                  |
| `TELNYX_ACCOUNT_SID`      | none    | Your account id, as it appears in TeXML REST paths.                                                                |
| `TELNYX_APPLICATION_SID`  | none    | The TeXML application outbound calls are placed through.                                                           |
| `TELNYX_PHONE_NUMBER`     | none    | The Telnyx number outbound calls come from, in E.164 form. It is also the caller ID of a transfer.                 |
| `TELNYX_UNSIGNED_STREAMS` | off     | `allow` runs Telnyx without `TELNYX_PUBLIC_KEY`. Read [the next section](#how-the-relay-knows-it-is-telnyx) first. |

`TELEPHONY_PUBLIC_URL`, `TELEPHONY_TRANSFER_NUMBERS` and `TELEPHONY_MAX_CALLS` apply to Telnyx as they do to Twilio.
Twilio and Telnyx can be set up at the same time. Each then has `TELEPHONY_MAX_CALLS` lines of its own.

### How the relay knows it is Telnyx

```text
caller ── PSTN ── Telnyx ──GET or POST /telephony/telnyx/voice?key=…──▶ relay (TeXML: connect a stream)
                     └─────WS  /telephony/telnyx/stream?ticket=…──────▶ relay (μ-law 8 kHz both ways)
```

Two things together, because neither is enough alone:

- **The secret in the voice URL.** Telnyx's documentation does not say how the request for a call's instructions is
  signed, so the relay does not depend on a signature there. A request without the right `key` gets 403 and no call
  is set up. The answer to a request with the right key holds a one-time ticket for the call's stream.
- **Telnyx's signature on the stream.** Telnyx signs each media stream's request with your account's key (Ed25519,
  over the time and the stream's URL, ticket included). A stream that is unsigned, signed for another URL or more than
  five minutes old gets 403, before it counts against anything. A key the relay cannot use, including one of the few
  values that would accept any signature, turns Telnyx off, so a mistake cannot quietly switch the check off.

Behind a reverse proxy or a tunnel, set `TELEPHONY_PUBLIC_URL`: the signature is checked against the stream URL the
relay gave Telnyx, and the relay must know its own public address to rebuild it.

**If the secret leaks.** Treat the voice URL like a password: keep it out of proxy access logs and screenshots.
Someone who has it, but not your Telnyx account, can ask the relay for tickets. They cannot open a stream with one,
because they cannot sign it, so they cannot talk to the assistant, use its tools or place calls. What they can do is
get in the way: a flood of requests pushes real calls' tickets out (the relay holds a fixed number), so Telnyx calls
fail to connect while it lasts. If that happens, or you think the secret is out, set a new one and update the URL in
the portal.

**Without the public key.** `TELNYX_UNSIGNED_STREAMS=allow` lets Telnyx run with the secret and the ticket only. The
secret is then all that stands between a stranger and the assistant: whoever has it can open sessions without placing
a call, with any caller number they like in the assistant's context, use every tool a caller can, run up model costs
up to `TELEPHONY_MAX_CALLS` at a time, and keep stream connections open that Twilio calls on the same relay also need.
Use it only to find out why signed streams are being refused, and not on a relay the public can reach.

### What is different from Twilio

- **Outbound calls need `TELEPHONY_PUBLIC_URL`.** The URL Telnyx fetches an outbound call's instructions from holds
  the secret, so the relay builds it only from the address you configured, never from the address a request to
  `POST /v1/calls` came in on. Without it the relay answers 503.
- **No answering-machine detection.** Telnyx reports who answered to a separate callback, which the relay does not
  take yet. `POST /v1/calls` with a `voicemailMessage` is refused with 400 on Telnyx, and an outbound call that
  reaches a machine starts the assistant, which talks to the recording.
- **`callSid` may be empty** in the answer to `POST /v1/calls`: Telnyx's documented response does not name the call.
  The id appears in the conversation record once the call connects.
- **Audio frames can arrive out of order.** Telnyx does not promise their order, so the relay puts them back in
  order, waiting for at most three later frames (60 ms at 20 ms a frame) before it gives a missing one up.
- **Only μ-law at 8 kHz.** The relay asks Telnyx for it, and refuses a stream that announces anything else.

## Testing on your own machine

Twilio has to reach the relay, so run a tunnel to your local relay and give Twilio and the relay the tunnel's address.
Any tunnel that gives you an HTTPS address works.

```bash
# 1. Start a tunnel to the relay's port, and note the https address it prints.
# 2. Tell the relay its public address, so Twilio's signature is checked against the right URL.
TWILIO_AUTH_TOKEN=your-twilio-auth-token \
TELEPHONY_PUBLIC_URL=https://your-tunnel.example.com \
npm run dev:server
# 3. Set the number's "A call comes in" webhook to https://your-tunnel.example.com/telephony/twilio/voice
```

A free tunnel's address usually changes every time you start it, so update both places each time. The keyless demo
(`VOICE_PROVIDER=mock`) is enough to test the plumbing, but use a real backend to test what the assistant says.

## Limits

- **Twilio and Telnyx only.** There is no direct SIP trunk and no other carrier yet. A SIP destination is supported
  only as somewhere to transfer a call to. Telnyx has not been run on a real call: see [Telnyx](#telnyx).
- **Calls are not recorded unless you ask.** With `CONVERSATION_RECORDING=phone` the relay writes each call's audio
  to a file: see [recording the audio](conversations.md#recording-the-audio), and check what the law and your callers'
  consent require where you operate. Otherwise audio is never stored, and the
  [conversation log](conversations.md#the-log-file) has the text only.
- **A line the backend cannot voice is not spoken.** The relay's own lines (the greeting, a check-in, the farewell) are
  voiced by the backend. When it cannot voice one at that moment, for example because its connection to the voice
  model has just dropped, the relay sends the line as text for the client to speak itself. A web client does that with
  the browser's speech synthesis. A phone call has no such client, so the line is skipped and the call carries on (or
  ends) as planned. The assistant's own replies are not affected.
- **Calls are not resumable.** If a call drops, the caller phones again and starts a new conversation. The
  [resume](conversations.md#carrying-a-conversation-across-a-dropped-connection) feature is for web and app clients.
- **No screen.** A phone call has no page, so client tools do not exist on it and a tool cannot show anything to the
  caller. Use code tools and webhook tools.
