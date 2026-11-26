# Running Max Cloud

Max Cloud turns a relay into a hosted service: developers sign up at `/console`, create a project, paste their own
model key, and put a voice agent in their product without running a server. They pay ¥0.15 per minute from a prepaid
balance, after 1,000 free minutes a month. This guide is for whoever operates the relay.

What a customer gets, and what stays private:

- Each project runs on **its own model key** (OpenAI Realtime, Gemini Live or Grok Voice), **its own persona** (name,
  instructions, greeting) and **no tools of yours**. Project sessions are never recorded in the relay's QA evidence.
- Model keys are encrypted at rest (AES-256-GCM, bound to their project) and never shown again after they are saved.
  Passwords are hashed with scrypt; console logins and project keys are stored only as hashes.
- Customers see only their own projects, usage and payments.

## Turn it on

Add to the relay's `.env` and restart:

```bash
# 32 random bytes. Encrypts customers' model keys and webhook secrets: back it up with the data folder.
# If it is lost, saved keys cannot be read and customers must enter them again. To change it, see
# "Rotating CLOUD_SECRET_KEY" below.
CLOUD_SECRET_KEY=   # openssl rand -base64 32
# The public address of this relay, for payment notifications.
CLOUD_PUBLIC_URL=https://max.example.com
```

Without `CLOUD_SECRET_KEY` every `/cloud` address answers "Max Cloud is not configured" and the console says so.

Data lives in `cloud.sqlite` in the relay's data folder (`STUDIO_DIR`, default `~/.max-relay`), next to the relay's
other data. Each change is written to disk before the relay goes on, so a top-up that has been credited stays credited
through a crash of the operating system or a power failure. Back the data up together with `CLOUD_SECRET_KEY`, and
take the database's copy with the command in [Backup and restore](#backup-and-restore): the file is in use while the
relay runs, and one copied by hand can be caught half written. A customer's balance is kept on the customer's row
(`balance_fen`) and moved by every ledger entry in the same transaction, so the relay never sums the ledger to know a
balance; a database from an earlier release is filled from its ledger when it is first opened. With Max Cloud on,
`/ready` reads the database and writes one row to it at most once a minute, and answers `503` with
`cloud-storage-unavailable` when it cannot be opened, read or written: with that, signups, sessions and payments all
fail.

## Invitations

Signup is by invitation, like the testing platform's accounts. In the app, **Admin → Accounts → Max Cloud
invitations**: add an optional note (who it is for), generate the link, and send it. Each link
(`https://<relay>/console?invite=cinv_…`) creates one account and expires after 7 days; unused links can be revoked
there. Logging in needs no invitation. To let anyone sign up instead, set `CLOUD_SIGNUP=open`.

## Account security and recovery

The console's **Account** area lets a signed-in customer change their password (current password plus a new one, the
same rule as sign-up) and **sign out everywhere**. A password change ends every other session of the customer, so a
stolen token dies with the password while the device that made the change stays signed in; signing out everywhere ends
every session, this one included. Both also end any outstanding password-reset link for the customer. Passwords are
scrypt-hashed and sessions are stored only as SHA-256 hashes, so none of that data helps whoever reads the database. A
login that read a customer just before a change or reset committed cannot mint a session that survives the revoke:
the session is written only while the password it was checked against is still the stored one, and a wrong current
password is throttled like a login attempt (per address, and across addresses with the login backoff).

The relay sends no email, and none is added, so a forgotten password cannot be emailed back. To help a customer who
cannot log in, make a one-use link and hand it over a channel you trust:

```bash
npm run cloud:reset-password -- dev@example.com
```

Run it on the relay host, in the app directory, where the relay's data lives (the same `STUDIO_DIR`, default
`~/.max-relay`). It prints `https://<relay>/console/reset?token=mcr_…` — at `CLOUD_PUBLIC_URL` when that is set, else
`TELEPHONY_PUBLIC_URL`, else `http://localhost:<PORT>` with a note to replace that address with the one your customers
reach the relay at. The relay can keep running: it reads the link from the database when the customer opens it.

The link works once, for 60 minutes, and replaces any earlier link for the same customer. Its token is stored only as
a hash, never itself. The page it opens sets a new password (the sign-up rule again); on success every session of the
customer ends and the link is used up. An unknown, used, replaced or expired link gets one and the same refusal, which
says nothing about which it was, and password changes and resets are rate-limited like the other `/cloud` credential
routes. Treat the link as the account's keys: give it only to the person it is for, over a channel that is already
theirs.

## Studio activation metrics

In **Admin → Overview → Studio activation**, operators can see how many projects created in the last 30 days
have reached their first successful website conversation, as a count and a percentage. The rolling cohort includes
all customer projects on the relay, even if later deleted. The median uses only projects that reached the milestone
and measures elapsed time from creation. With no new projects, the rate is undefined. With no successes, the median
is undefined. These figures use the installation milestone described below and survive transcript expiry.

## The Studio

Each project opens in a Studio in the console, built so someone new to voice agents gets from nothing to an agent on
their website in a few minutes, without writing a backend:

- **Templates.** A new agent starts from a template: website guide, customer support, appointment booking, restaurant
  orders, sales qualifier, language practice, or blank. A template fills the name, instructions, greeting and an
  outline of the knowledge to add, and suggests tools.
- **Agent.** Name, language, voice model and model key (with a link to get one), a voice picked from the backend's
  voices, instructions with a "help me write it" form, and the greeting.
- **Knowledge.** Up to 20,000 characters of facts (hours, prices, policies, FAQs), pasted or imported from a text file.
  The agent answers from them and says it does not know otherwise.
- **Tools.** No-code webhook tools: a name, when to use it, an https address and its parameters. Max POSTs each call,
  signed with the project's signing secret (`whsec_…`, shown and rotated in the tab), exactly as the relay's
  [webhook tools](tools.md#webhook-tools). "Send test request" calls it with sample values. Addresses must be public
  https: the relay resolves each host and refuses private, loopback and link-local addresses, connects to the address
  it checked, follows no redirects and gives a tool 10 seconds.
- **Flow.** Most agents are one agent, and the tab can stay empty. To split a conversation between several agents
  with a job each (orders, refunds, a person), draw it: steps with their own instructions and tools, and arrows that
  say when one hands over to another. It is the relay's [flow builder](conversations.md#flows) and the
  same [agents and handoffs](conversations.md#several-agents-and-handing-over), with the project's tools as the
  only tools: values asked of the user, a fixed sentence, a tool called by rule and a branch on its answer all work
  as they do there. The project's instructions and knowledge are what every step starts from. Choose **Apply to draft** on the canvas before testing or saving. Studio validates the flow with the tools
  in that draft, so a step cannot automatically call a tool that was removed.
- **Test.** Before adding a model key, select the visitor’s question to explore a scripted sample for the project's template.
  The support sample shows an order lookup, a simulated result, and the agent's reply. Samples run locally, use no minutes,
  and leave the onboarding checklist and draft test status unchanged. Add a model key to start a real voice or text session. Starting with unsaved edits saves the draft first.
  The test runs the selected revision and its actual tools, including webhook calls that may change data at the
  destination. Test minutes count toward the project's balance and live spending limit. Studio revision tests
  skip conversation history, memory, post-call analysis, conversation webhooks, and trace export.
- **Install.** The one-line embed (below), the widget's label, colour and side, and copyable code for a backend in
  plain JavaScript, React, Next.js, Express or Flask.
  The Studio installation checklist completes when the relay observes a visitor get an answer through the widget or browser SDK.
  It keeps the first verified time on the project even when transcript storage is off. Studio tests are tracked separately.
- **Conversations.** What was said in each session (final transcript lines and tool outcomes, never audio), kept 30
  days and deleted with the project. Each answer shows how long the visitor waited for it to begin, each
  conversation the median of those times, and the tab the median over the conversations listed: the first thing to
  look at when an agent feels slow. New projects keep them and say so; projects made before the Studio do not until
  their owner turns it on, and it can be turned off per project.
  A project can also have each conversation sent to its own server when it ends: an https address in the same tab.
  Max POSTs a `conversation.ended` record with the transcript, the same record and headers as the relay's own
  [conversation webhook](conversations.md#the-conversation-webhook) plus `project.id` and `source` (`embed`, `api`
  or `test`), signed with the project's signing secret, to a public https address by the rules of a tool call. A
  delivery that fails is tried three more times, after 1, 5 and 25 seconds. "Send test request" sends one sample
  record marked `"test": true`, and the tab shows how the last delivery went (kept in memory, so it is empty after
  the relay restarts). A server that is down holds each delivery for about a minute: past 20 waiting for one
  project, or 200 for all, a conversation is not sent, and the tab says so. The signing secret is on the Tools tab. Nothing is sent for a session in which nothing was said. Sending does not depend on keeping
  transcripts: a project can do either, both or neither.
  A project can have each conversation analysed when it ends ("Analyse each conversation when it ends", in the same
  tab): a summary, how the visitor felt, a pass or fail against a rule the owner writes, and up to 24 fields to find
  in what was said (text, a number, yes or no, or one of a few choices). It is the relay's own
  [conversation analysis](conversations.md#analysis), with the same checks on what the model answers. The result is
  shown with the conversation, its pass or fail and mood are marks in the list, and the record sent to the project's
  server carries it as `analysis`, or `analysisError` with the reason when there is none. That record is sent once,
  after the analysis, so it arrives up to half a minute later than it would without one. A conversation is analysed
  only when the visitor said something and the result has somewhere to go (kept transcripts or a server address).
  See [who pays for an analysis](#who-pays-for-an-analysis).
  A project can also have its conversations traced to its own collector: see [Traces](#traces). Over the API that is
  `studio.traces` (`{ "endpoint", "content" }`, left as it is by a `PATCH` whose `studio` has no `traces`) and the
  write-only `tracesHeaders`; the project says `hasTracesHeaders`, and `POST /cloud/api/projects/:id/traces-test`
  sends the test.

### Diagnosing a website installation

In **Install → Installation diagnostics**, start a conversation on the published site, then choose **Refresh diagnostics**.
Max shows the most recent recorded widget request or browser session event and what to check next. For example, a
rejected origin calls for checking the live list of allowed origins, while an issued token followed by no connection
calls for checking the browser connection to the relay. The first successful website conversation has its own timestamp.
A later unsuccessful attempt can update the diagnostic while the installation milestone stays complete.

The owner sees one event kind and its time. Studio previews and backend-only sessions are excluded. A snippet that
never contacts Max, or one pointing at an unknown project ID, produces no project-specific observation.

### Replaying a failed conversation turn

Open a conversation in Studio, choose **Create test from this turn**, and review the visitor message in the Test tab.
For an agent reply or tool failure, Studio starts with the preceding visitor message. Edit it to remove identifying
details or add context the draft will need. The failed reply and tool error text stay in the original conversation.

Enter a phrase the corrected answer should contain and, for any project tools the draft needs, enter their simulated
JSON responses. For example, a case about a late order might use `{"check_order":{"status":"shipped","eta":"Friday"}}`
and expect the word `Friday`. Save the case, save your draft changes, and run the case against the displayed draft revision.

The replay sends the edited message to the draft's configured provider. Project tool calls receive only the supplied
responses. A missing response fails the case. Studio compares the final answer with the expected phrase, ignoring
case, and shows the actual answer, tool calls, and revision. Replay uses account minutes and the project's monthly
limit. The separate live provider test still gates publishing.

Saved cases belong to the project and remain available after source conversations expire. Edit or delete them in
the Test tab. Deleting the project removes its cases.

Beside **Publish**, **Run all** replays every saved case sequentially against the displayed draft. The button shows the
case count, and replays use account minutes. Keep the project open while the suite runs. **Stop replays** cancels the
active request and skips the remaining cases. Completed results survive refreshing Studio. Expand a case to compare
the expected phrase with the actual answer, check for a missing simulated response, or read a provider error.

Studio keeps the latest completed result for each saved case. Editing the case clears its old answer. Saving a new
draft marks earlier results as needing another run. The results are advisory. Publishing still requires a successful
interactive provider test of the exact draft.

### Testing, publishing, and restoring a revision

Saving a draft leaves the website and backend on the current live revision. Studio shows the live and draft IDs
and a comparison of the changed settings. Model keys and trace headers are masked. A draft becomes eligible to
publish when its test reaches provider readiness. Editing and saving it again creates a new revision that needs
its own test. **Publish** switches new live conversations to the exact tested revision.

**Restore previous revision** reactivates the preceding live configuration under a fresh revision ID. It also
discards the current draft. Studio asks for confirmation and refuses stale publish or restore requests. The
project keeps one saved draft and one rollback revision. Billing limits, project access keys, signing keys, and
the website installation checklist stay with the project. Removing the model key in Settings takes effect
immediately and clears the saved draft and rollback revision.

Authenticated Studio clients read `GET /cloud/api/projects/:id/release`, save with `PUT .../draft` and start a
test with `POST .../test-session`. A draft save includes `baseRevision`, `draftRevision` (null for the first
draft), and `patch`. A test takes the draft's `revision`, or `expectedLiveRevision` to preview the current live
configuration. Publishing sends both `baseRevision` and the tested `revision` to `POST .../publish`. Restoring
sends the current `baseRevision`, the previous `revision` and the displayed `draftRevision` to `POST .../restore`.
A material configuration change through the existing live project PATCH or flow PUT advances the live revision
and invalidates the open draft. Reload Studio to see the new state after a conflict.

### Who pays for an analysis

By default the analysis is one chat request to the project's own vendor with the project's own model key: a few
thousand tokens per conversation, on the customer's bill, and the console says so where it is turned on. Nothing is
taken from the prepaid balance for it.

| Project backend | Endpoint                                                  | Model              | To use another                |
| --------------- | --------------------------------------------------------- | ------------------ | ----------------------------- |
| OpenAI          | `https://api.openai.com/v1`                               | `gpt-4o-mini`      | `CLOUD_ANALYSIS_MODEL_OPENAI` |
| Gemini          | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | `CLOUD_ANALYSIS_MODEL_GEMINI` |
| Grok            | `https://api.x.ai/v1`                                     | `grok-4.3`         | `CLOUD_ANALYSIS_MODEL_GROK`   |

To run every project's analysis on one model of your own instead, set `CLOUD_ANALYSIS_LLM_BASE_URL` (any
OpenAI-compatible chat endpoint, like `http://127.0.0.1:11434/v1` for Ollama), `CLOUD_ANALYSIS_LLM_MODEL` and, when
the endpoint wants one, `CLOUD_ANALYSIS_LLM_API_KEY`. That endpoint is never sent a customer's key, and it is then
you who pays and you who are sent the transcripts; the console tells the customer so in place of "on your bill", and
a project's own key is not read for it.

At most 24 analyses run at once, and at most 4 of one project, so a busy project does not take every place; a
conversation that ends past that is kept and sent without one, with the reason. An analysis that fails (a key the
vendor refuses, an answer with nothing that was asked for) is not tried again later: the reason is kept with the
conversation, without the vendor's own words.

When the relay is stopped, analyses under way get two more seconds. A conversation whose analysis is not done by
then is kept and sent to the project's server without one, with `analysisError` "not analysed: the relay was
stopping".

This was run end to end with a local model through `CLOUD_ANALYSIS_LLM_BASE_URL` (`qwen3:8b` on Ollama: about seven
seconds for a six-line conversation and four fields). The three vendor endpoints and model names are from the
vendors' documentation and were not called.

### Traces

A project can name its own OpenTelemetry collector (Langfuse, Honeycomb, Grafana Tempo, Datadog: anything that takes
OTLP/HTTP), and each of its conversations is exported there as one trace. It is set in the Conversations tab, next to
the conversation webhook: the collector's full traces address (for Langfuse,
`https://cloud.langfuse.com/api/public/otel/v1/traces`), its request headers, and whether what was said goes with it.

- **What is sent.** One trace per conversation, written when the conversation ends: a `voice.session` span (the
  session id, the voice backend, how it ended, and counts of turns, tool calls, interruptions and errors), a
  `voice.turn` span for each turn with how long the speech recognition, the thinking and the first sound took, and a
  `voice.tool` span for each tool call with its name, how long it took and whether it worked. The project's name is
  the `service.name` and the agent's name. Tool arguments and results are never sent. A failed tool call carries
  its error message, and an error the relay reported is an event on its span, with or without the setting below; a
  turn's span also says how many characters each side said, but not what.
- **What was said.** Off unless the owner turns on "Include what was said": then each turn's span also carries what
  the visitor and the agent said, cut at 2,000 characters each. The console says that transcripts go to that
  collector. Nothing else about the visitor is sent.
- **Where.** The address has to be https to a public host, by the same rules as a tool call: no user name or
  password, the standard port, private addresses refused when the name is looked up, and no redirects followed.
- **The headers.** They usually carry the collector's API key, so they are a stored secret of their own: written as
  `name=value,name2=value2` with URL-encoded values (the form of `OTEL_EXPORTER_OTLP_HEADERS`), at most 2,000
  characters and 10 headers, and not `host`, `content-length`, `content-type`, `transfer-encoding` or `connection`.
  They are encrypted with `CLOUD_SECRET_KEY` like a model key (and move with it in
  [a rotation](#rotating-cloud_secret_key)), are not part of the Studio settings, and are never shown again or
  returned by any request: the project only says `hasTracesHeaders`. Saving them without `CLOUD_SECRET_KEY` set
  fails as saving a model key does. They belong to the collector they were given for: when the address is changed
  to another host, or emptied, the saved headers are removed, and the new collector's are entered with it (in the
  same save, over the API). Headers that change how a request is made, or that would have the relay speak for
  somebody else, are refused as well (`upgrade`, `expect`, `te`, `trailer`, `keep-alive`, `cookie`, `forwarded`,
  and any `proxy-` or `x-forwarded-` header). If they cannot be decrypted, the project's conversations are not traced, and the
  relay logs one warning.
- **Send test trace.** Sends one small sample trace (a session with one turn, marked `max.test` in its attributes) to
  the saved address with the saved headers, once and without a retry, and says in words how it went: that the
  collector answered HTTP 401 and did not accept the headers, for example, or that the host could not be found.
- **When the collector is down.** Spans are sent when a conversation ends, in batches, with a request timeout of 10
  seconds. A request that fails with a network error, a 429 or a 5xx answer is tried once more after a second; then
  the traces of that batch are dropped, and the relay logs it. A conversation does not wait for any of this and is
  not affected by it. When the relay is stopped, it gives traces still being sent three seconds.

The relay operator's own tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`, see [Tracing](conversations.md#tracing)) does not include
projects' conversations: they are their customers', and go only to the collector their owner named.

## How customers connect

### The one-line embed (no backend)

In **Install**, turn on "Let the websites below use this agent directly", list the websites (`https://shop.example.com`,
plus `http://localhost:5173` while developing), test and publish, then paste:

```html
<script src="https://<relay>/sdk/voice-agent.iife.js" data-relay="https://<relay>" data-project="pub_…"></script>
```

The widget asks `POST /v1/public-session-tokens {"project":"pub_…"}` for a two-minute token. The relay gives one only
when the browser's `Origin` is on the project's list, and the token opens a voice session only from that same origin.
Like any public chat widget, anyone visiting a listed site can use it, and a script outside a browser can claim any
`Origin` it likes, so it is limited: 10 tokens a minute per visitor address, 120 a minute per project, at most 3 of the
customer's 5 simultaneous sessions (so their own backend and tests always have room) and at most 2 from one visitor
address, 15 minutes per conversation, the project's monthly minutes limit if the owner set one, and their balance as
always. Each embed token opens one session; the widget asks for a new one whenever it reconnects. Embed tokens can only
push out other embed tokens. A project's public id is not a secret; its project key is.

**Monthly minutes limit.** In the Studio's **Settings**, an owner can limit how many minutes a project may use per
calendar month (UTC), counting every session of the project: the embed, their backend and the Test tab. Once it is
reached, token requests are refused (`403`), new sessions are refused and open ones closed with code `4003` ("This Max
Cloud agent has used its minutes for this month."), until the next month or until the owner raises the limit. It is
off unless set; we suggest it to anyone who turns the public embed on.

### With their own backend

1. Open the invitation link, create an account, and create a project. The project key (`mpk_…`) is shown once.
2. Choose a backend, paste a model key, configure the assistant in Studio, test it, and publish the draft.
3. From their own backend, mint a short-lived session token with the project key:

   ```bash
   curl -X POST https://<relay>/v1/session-tokens \
     -H "Authorization: Bearer mpk_…" -H "content-type: application/json" \
     -d '{"userId":"their-user-42"}'
   ```

4. Give the token to the page, exactly as in [getting started](getting-started.md): the widget's `token-url`, or the
   SDK's `token` function.

Limits that keep one account from affecting everyone else:

- **Balance.** A session starts only when the customer has at least 5 seconds left, counting every session they have
  open, and all their sessions are checked every 5 seconds. When the time is used up they are closed with code `4003`
  ("Your Max Cloud balance is used up. Top up in the console."). A balance can go negative by at most one check
  interval (5 seconds) per open session. While the database is down (a full disk, a locked or corrupted file), new
  sessions are refused with code `1013`, and a running session, a Studio test included, is ended the same way once its
  checks have failed one after the other for 30 seconds ("Max Cloud could not check this conversation's balance for 30
  seconds, so it has ended it."): nobody talks on money that cannot be checked, and the most a customer can go past
  what they had, outage included, is 30 seconds plus one check interval per open session. What is billed, and when,
  is in [usage and billing](usage-and-billing.md#max-cloud-billing).
- **5 simultaneous sessions** per customer; a sixth is refused with code `1013`.
- **Session tokens:** at most 120 minted per minute per project, at most 200 live per project, and 1,000 characters of
  `context`. Cloud tokens are kept apart from the relay's own, so no customer can push them out.
- **Keys:** rotating a project key or deleting the project closes its sessions within 5 seconds, and tokens minted
  with the old key stop working.
- A project without a model key is refused with code `1008`.

Sessions are checkpointed every 5 seconds while they run, so a crash or restart cannot lose their charge: once the relay
process that ran a session has not checkpointed it for a minute, the relay (the restarted one, or any other sharing the
data folder) books it up to its last checkpoint. A relay never books a session another running relay is still
checkpointing, so two relays on one data folder, or a rolling restart, are safe. If a session is booked this way while
its relay was only stalled, the rest is booked when it closes, as a second ledger entry whose reference ends in
`:rest:1`. A booking that fails (a full disk, a locked database) is kept and retried every 15 seconds; bookings are
idempotent, so nothing is charged twice.

The billed clock runs only while the voice backend is connected: it starts when the backend is ready and stops while
the relay reconnects to it, whatever the client does meanwhile.

## Backup and restore

`cloud.sqlite` is a SQLite database in write-ahead-log mode. While the relay runs, its newest writes are in
`cloud.sqlite-wal` beside it, and are moved into `cloud.sqlite` only from time to time. So do not copy the files by
hand: a copy taken mid-write may not open, and one that leaves out the `-wal` file, or copies it a moment later than
the database, silently lacks the latest top-ups and bookings. Take the copy with the backup command instead, on the
relay host, in the app directory:

```bash
npm run cloud:backup -- /backups/max-cloud-2026-11-25.sqlite
```

- The relay keeps running. The copy is made with SQLite's `VACUUM INTO`, so it is the whole database as it was at one
  moment: customers, projects, the ledger, top-up orders and kept conversations.
- The target file must not exist, and its folder must: an existing backup is never overwritten.
- The copy is one file, readable by its owner only, like the database. It holds everything the database holds, so keep
  it as private as `CLOUD_SECRET_KEY`, and keep that key (the one in use when the copy was taken) with it: without the
  key, the saved model keys, webhook secrets and trace headers cannot be read.
- Run it as often as you want backups, for example every night from cron with the date in the file name, and keep
  the copies somewhere other than the relay host.
- A file ending in `.partial-<number>` beside the target is a copy that was cut short (the disk filled up, or the
  command was killed). Nothing was put at the target's name: delete that file and run the command again.

### Restoring a backup

1. Stop the relay.
2. Move `cloud.sqlite` out of the data folder, and `cloud.sqlite-wal` and `cloud.sqlite-shm` too if they are there.
   Keep them until the restore has been checked: they hold everything that changed since the backup.
3. Copy the backup file into the data folder and name it `cloud.sqlite`. Leave no `cloud.sqlite-wal` or
   `cloud.sqlite-shm` beside it: they belong to the database that was there before, and applied to another file they
   can corrupt it.
4. Make sure `CLOUD_SECRET_KEY` is the key the backup was made with, or that that key is set as
   `CLOUD_SECRET_KEY_PREVIOUS`.

Top-ups paid after the backup was taken are not in the restored ledger. Let the relay settle them itself, and add by
hand only what it cannot know:

1. Start the relay. Do not add anything with `npm run cloud:credit` yet.
2. Wait for the sweep to have asked the provider about every order the backup still knows. It asks about each order
   that is still pending in its first sweeps, and about each order the backup shows as closed as unpaid and that
   expired within the last day, within a quarter of an hour of the start. One sweep asks about twenty orders, so give
   it longer if several hundred are waiting. To tell that it is through: a quarter of an hour has passed since the
   start, and this shows no order whose payment window has closed but is still pending (the path is the data folder's,
   `STUDIO_DIR`):

   ```bash
   sqlite3 ~/.max-relay/cloud.sqlite \
     "SELECT id FROM orders WHERE status = 'pending' AND expires_at <= CAST(strftime('%s','now') AS INTEGER) * 1000"
   ```

   Orders still within their payment window stay pending: their customers may yet pay, and the sweep goes on asking
   about them every minute, crediting each one the provider reports paid.

3. Compare the provider's own records with what the relay knows and has credited:

   ```bash
   sqlite3 ~/.max-relay/cloud.sqlite "SELECT o.id, o.status, l.kind FROM orders o LEFT JOIN ledger l ON l.ref = o.id"
   ```

   A payment the provider shows whose order is missing from that output was created after the backup. Add its
   balance with `npm run cloud:credit` (see [Today: manual top-ups](#today-manual-top-ups)), using the order's id as
   the reference. Never add one that has an order row this way: the sweep credits it as a top-up, and the customer
   would be paid twice.

An order the backup shows as closed as unpaid, and that had expired more than a day before the relay was started
again, is not asked about. If the provider's records show that it was paid, settle it by hand with
`npm run cloud:settle` (see [Settling one order by hand](#settling-one-order-by-hand)). Never `npm run cloud:credit`
for it: the relay has a record of that order, and the customer would be paid twice.

## Rotating CLOUD_SECRET_KEY

Customers' model keys, webhook secrets and trace headers are encrypted with `CLOUD_SECRET_KEY`, and each one records which key it was
written with. To change the key (it leaked, someone who knew it left, or as routine):

1. Generate a new key: `openssl rand -base64 32`.
2. In the relay's `.env`, set `CLOUD_SECRET_KEY` to the new key and `CLOUD_SECRET_KEY_PREVIOUS` to the old one, and
   restart. New and changed secrets are written with the new key; existing ones still decrypt with the old one, so
   nobody notices.
3. On the relay host, in the app directory, with the same environment:

   ```bash
   npm run cloud:reencrypt -- --check   # how many secrets use each key
   npm run cloud:reencrypt              # rewrite them all under the new key
   ```

   It is safe while the relay runs and safe to repeat. It says when every secret uses the new key.

4. Remove `CLOUD_SECRET_KEY_PREVIOUS` and restart. Destroy the old key.

Deleting a project erases everything its deletion need not keep, in the same transaction: its transcripts and saved
revisions, and on its row its project key, model key, webhook secret, trace headers, assistant name, instructions,
greeting, Studio settings, public embed id, monthly minutes limit and revision. A deleted project keeps only what the
activation metrics and past usage need: its id, its owner, its name, its backend, when it was created and deleted,
and when it first answered a website conversation. So there are no secrets of deleted projects to re-encrypt. A
project deleted by an earlier release has the same things erased the next time the database is opened.

If the relay starts with a `CLOUD_SECRET_KEY` that decrypts none of the stored secrets, across more than one project
(it was changed by mistake, or lost), it logs an error saying so and `/ready` answers `503` with the issue
`cloud-secret-key-mismatch`, so a deploy with the wrong key does not take traffic. Put the old key back, or set it as
`CLOUD_SECRET_KEY_PREVIOUS`. A `CLOUD_SECRET_KEY_PREVIOUS` that is not a valid key is reported as
`cloud-secret-key-previous-invalid`. Unreadable secrets among readable ones, or in a single project, do not fail
`/ready`: they are logged with their project ids, listed as the warning `cloud-secrets-unreadable` in `/ready`, and
counted in the `max_cloud_secrets_unreadable` metric. Those customers must enter their model key again. If the old key
is truly lost, every customer must.

## Getting paid

### Today: manual top-ups

Until online payment is set up, the console's **Top up** button tells customers to email you (the address is
`CONTACT_EMAIL` in `src/lib/pricing.ts`, also shown in the site's footer and on the login page).
When a customer has paid you some other way, add the balance:

```bash
npm run cloud:credit -- dev@example.com 200 INV-2026-0007
```

The amount is in yuan (`49.50` works; a negative amount removes balance). The reference (an invoice or receipt number)
makes it safe to run twice. Run it on the relay host, in the app directory; the relay sees the change at once.

It is for payments that came another way, with no order in the relay. For a top-up order the relay has a record of,
use `npm run cloud:settle` instead ([below](#settling-one-order-by-hand)): crediting such an order here adds a second
payment, and the customer is paid twice.

### Later: WeChat Pay and Alipay

Both need a merchant account, which needs a business licence (for example an individual business licence,
个体工商户). Once you have them, set the variables below and restart: the console's Top up button then offers a QR code
for each configured provider, and balances are credited automatically and exactly once per payment.

**WeChat Pay** (API v3, Native payment)

1. In the merchant platform, activate **Native支付** and bind your AppID to the merchant number.
2. Under 账户中心 → API安全: set the 32-character APIv3 key, apply for the merchant API certificate, and download the
   **WeChat Pay public key** and its ID (`PUB_KEY_ID_…`).
3. Set:

   ```bash
   WECHATPAY_MCHID=
   WECHATPAY_APPID=
   WECHATPAY_CERT_SERIAL=          # serial number of the merchant API certificate
   WECHATPAY_PRIVATE_KEY=          # apiclient_key.pem: the PEM text or a path to the file
   WECHATPAY_API_V3_KEY=
   WECHATPAY_PUBLIC_KEY=           # the WeChat Pay public key: PEM text or a path
   WECHATPAY_PUBLIC_KEY_ID=        # PUB_KEY_ID_…
   ```

4. Notifications arrive at `https://<CLOUD_PUBLIC_URL>/cloud/pay/wechat/notify`; it must be reachable over HTTPS.

**Alipay** (订单码支付, `alipay.trade.precreate`)

1. Create an app in the Alipay open platform with public-key signing (RSA2): upload the app public key and copy the
   **Alipay** public key (not your app's). Put the app online and bind it to your merchant account.
2. Sign up for **订单码支付** (or the older 当面付; then also set `ALIPAY_PRODUCT_CODE=FACE_TO_FACE_PAYMENT`).
3. Set:

   ```bash
   ALIPAY_APP_ID=
   ALIPAY_PRIVATE_KEY=             # the app private key: PEM, a path, or the bare base64 Alipay's tool exports
   ALIPAY_PUBLIC_KEY=              # the Alipay public key
   # ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do   # the sandbox, for testing
   ```

4. Notifications arrive at `https://<CLOUD_PUBLIC_URL>/cloud/pay/alipay/notify`. If the app has an IP allowlist, add
   the relay's outbound address.

Every notification's signature is verified, the paid amount must match the order, and an order is credited once
however often the provider repeats the notification. A payment confirmed just after its order expired is still
credited, so a customer is never charged without receiving balance.

A notification is at most 16 KB, and one address may send at most 600 a minute: each is verified on the relay's own
process, so a flood of forged notifications cannot crowd out live audio. Whatever is refused — a bad signature, a wrong
amount, or either limit — is answered exactly as a failed notification is, which both providers treat as "send it
again": WeChat Pay repeats a notification it has not been answered 200 or 204 at the intervals 15 s/15 s/30 s/3 m/
10 m/20 m/30 m/30 m/30 m/60 m/3 h/3 h/3 h/6 h/6 h, up to 15 times, and Alipay repeats one it has not been answered
`success` eight times over about 25 hours. A notification refused for any reason is still no lost payment: the sweep
and the customer's own polling credit the order through the query API.

Behind a reverse proxy, that limit needs `RELAY_TRUST_PROXY=on` ([configuration](configuration.md#security-and-access)):
with it off, every notification comes from the proxy's address and they all share one bucket of 600 a minute. One
refused for that is sent again by the provider, and the sweep credits the order meanwhile, so credit is delayed, never
lost.

A notification that never arrives is not a lost payment. The relay also asks each provider every minute about the
orders that are still unpaid, credits what the provider confirms, and closes an expired order that was not paid. It
goes on asking about a closed order for 24 hours after it expired: the answer that got it closed may have failed (the
provider was down) or not have caught up with a payment made at the last second, and a payment the provider confirms
in that time is still credited. A closed order is asked about again at most every 15 minutes, and when more are due
than one sweep can ask, the ones asked about longest ago go first. So a payment whose notification was lost is credited
by the next sweep or two, as long as at most twenty orders are waiting: one sweep asks about twenty pending orders
a minute, the closest to expiring first, and with more waiting the rest follow in the sweeps after. The console's own
polling and this sweep share one limit on the provider's API: at most one query per order every 3 seconds.

### Settling one order by hand

The sweep stops asking about an order a day after it expired. If the provider's records then show that it was paid
after all, settle it with its id from those records:

```bash
npm run cloud:settle -- mc20261125093000abcdef0123456789
```

It asks that order's provider whether it was paid, whatever the order's age, and credits it to the customer as the
provider's own notification would have been. So it is safe to run twice, and a notification that arrives later changes
nothing. It refuses an id the relay has no order for, and an order whose provider is not configured on the relay, so
run it with the relay's environment. Never settle an order with `npm run cloud:credit`: the relay has a record of
that order, and the customer would be paid twice.

### Testing payments without a merchant account

In development (never with `NODE_ENV=production`), `CLOUD_PAYMENTS_TEST=on` adds a **Test payment** method: its QR code
links to a page with a "Mark as paid" button, so the whole top-up flow can be tried with no money involved.

### Before taking real money

The signatures, notifications and order queries are tested with locally signed messages in each provider's format,
not a live merchant account. Before the first customer pays, make one real payment per provider with your own account
and check each step:

1. Top up the smallest pack in the console and pay it with a real WeChat or Alipay wallet.
2. The order turns paid within seconds (the notification) and the balance grows by exactly the pack.
3. The relay log has a `top-up credited` line and no `paid order refused` line for it, and the provider's merchant
   records show the same order id and amount.
4. Create another order, stop the relay, pay it, and start the relay again: the order is credited within two minutes,
   exactly once, by the provider's repeated notification or the relay's own sweep, whichever comes first.
5. Let one more order expire unpaid: the provider shows it closed, and nothing is credited.
6. Refund the test payments from the merchant platform. The relay does not handle refunds, so a refund made there
   leaves the balance as it was: remove the credit with `npm run cloud:credit -- <email> -<amount> <refund id>`.

With Alipay, steps 1 to 5 can be rehearsed first on the sandbox gateway (`ALIPAY_GATEWAY` above) with a sandbox
buyer account. WeChat Pay has no sandbox for API v3, so its first check is a real payment.

## Prices

¥0.15 per minute, billed by the second, after 60,000 free seconds per customer per calendar month (UTC). Packs are
¥50, ¥200 and ¥1,000. The values live in `server/cloud/billing.ts`; the public copy in `src/lib/pricing.ts`.
