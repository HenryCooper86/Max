# Deployment

How to run the relay in production. The relay is one Node.js process. It serves the WebSocket (`/agent`), a small HTTP
API, the browser SDK (`/sdk/*`) and the built web app, all on one port (8787 by default).

You need Node 22.13 or newer (the relay uses `node:sqlite`), or Docker.

## Build

```bash
npm ci
npm run build
```

`npm run build` runs three steps: `tsc` (type check), `vite build` (the web app into `dist/`) and `npm run build:sdk`
(the browser SDK into `dist/sdk/`). It needs the dev dependencies, so build where you can run `npm ci` in full.

If you only need the SDK, `npm run build:sdk` is enough. The relay checks for `dist/sdk` on each request, so you can
build the SDK without restarting it.

## Run

The server is TypeScript run through `tsx`, which is a normal dependency. There is no compile step for the server.

```bash
NODE_ENV=production node --import tsx server/index.ts
```

The existing test deployment (`deploy-lightsail.command`) copies the built tree to an AWS Lightsail host, runs
`npm ci --omit=dev`, and restarts a pm2 process named `max` that runs `tsx server/index.ts` on port 8787. Both ways
run the same file. Set `NODE_ENV=production` so the relay sends HSTS and reports configuration problems at `/ready`.

The relay reads `.env` from the working directory (through `dotenv`) and from the environment. Set `PORT` to change the
port. It shuts down cleanly on `SIGTERM` and `SIGINT`: it closes sessions with code 1001 and flushes its files.

## Docker

The repository has a multi-stage `Dockerfile`: one stage builds, one installs production dependencies, and the final
image runs as the unprivileged `node` user.

```bash
docker build -t voice-agent-kit .
docker run -d --name relay -p 8787:8787 --env-file .env -v relay-data:/data voice-agent-kit
curl http://localhost:8787/health
```

With Compose:

```bash
cp .env.example .env     # edit it
docker compose up -d --build
docker compose logs -f relay
```

Notes:

- `docker run --env-file` does not strip quotes the way `.env` loaders do. Write values without quotes.
- The image sets `HOME=/data` and `STUDIO_DIR=/data/.max-relay`. Mount a volume at `/data` or you lose
  accounts, history and Studio settings when the container is replaced.
- To use your own assistant identity, mount the file and point at it:

  ```bash
  docker run -d -p 8787:8787 --env-file .env -v relay-data:/data \
    -v "$PWD/assistant.config.json:/app/assistant.config.json:ro" voice-agent-kit
  ```

  A `toolsModule` or `logo` path in that file is resolved relative to the config file, so mount those files beside it
  inside the container too.

- With `WEBRTC=on`, also publish the UDP range and set `WEBRTC_PUBLIC_IP`: see
  [WebRTC transport](webrtc.md#what-the-network-needs). The audio goes to those ports directly, not through your
  reverse proxy.
- The image has a `HEALTHCHECK` on `/health`.
- To reach model servers on your host from the container (Ollama, for example), use `host.docker.internal` or a
  Compose network, not `localhost`.
- For a local-model stack, see [local-models.md](local-models.md) and `docker-compose.local-voice.yml`.

## Reverse proxy with TLS

Browsers need a secure origin for the microphone, and a token in a URL needs TLS. Put a proxy in front that terminates
TLS and forwards WebSocket upgrades.

> **Behind a proxy you must set `RELAY_TRUST_PROXY=on`.** It is off by default, and with it off every client has the
> proxy's address. The per-IP limits on `/agent` connections, logins and sign-ups, and the public embed then become one
> limit shared by everyone: a single visitor, or one script, can lock every user out for a minute at a time.

```dotenv
RELAY_TRUST_PROXY=on
RELAY_TRUSTED_PROXY_HOPS=1
```

With this on, the rate limits read the real client address from `X-Forwarded-For`, counting `RELAY_TRUSTED_PROXY_HOPS`
entries from the right: 1 for Caddy alone, 2 for a CDN in front of Caddy. Turn it on only when the relay is reachable
through the proxy alone: firewall port 8787 so only the proxy reaches it (with Docker, publish it as
`-p 127.0.0.1:8787:8787`). With the setting on and the relay reachable directly, a client can send its own
`X-Forwarded-For` and pick its address. That is why it is not on by default.

The relay helps you notice. At startup it warns when a live backend or Max Cloud runs with the setting off. The first
time a request arrives carrying `X-Forwarded-For` or `Forwarded` while it is off, it logs a warning starting with
`!!!`, and `/ready` lists `proxy-headers-untrusted` under `warnings` from then on (without turning `503`, so a load
balancer does not take the relay out of service over it).

### Caddy

Caddy gets a certificate and handles WebSocket upgrades on its own.

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Keep idle sockets open at least as long as the relay's own timeouts.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

Query strings carry tokens, so do not write them to access logs. Prefer logging `$uri` rather than `$request_uri` or
`$request`, and keep session tokens short-lived.

## Environment checklist

Before going live:

| Check                      | Setting                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| A real backend and its key | `VOICE_PROVIDER` and its API key (see [backends](backends.md)). `mock` is for development.             |
| Access control             | `RELAY_AUTH_TOKEN` set to a long random value: `openssl rand -hex 32`.                                 |
| Browser origins            | `RELAY_ALLOWED_ORIGINS` set to your site origins, if browsers connect.                                 |
| Proxy awareness            | `RELAY_TRUST_PROXY=on` behind a proxy, with `RELAY_TRUSTED_PROXY_HOPS` set to the hop count. Required. |
| Production mode            | `NODE_ENV=production`.                                                                                 |
| Rate limits                | `RELAY_CONN_PER_MINUTE` suits your traffic (default 30 per IP per minute).                             |
| Account sign-up            | `AUTH_REGISTRATION=off` if you use accounts and the team has registered.                               |
| Backend switching          | `VOICE_PROVIDER_SWITCHING=off` if clients must not choose a backend.                                   |
| Webhook secrets            | `TOOL_WEBHOOK_SECRET` (or your name) set, and referenced as `${TOOL_WEBHOOK_SECRET}`.                  |
| Assistant identity         | `ASSISTANT_CONFIG` points at your `assistant.config.json`, or run `npm run setup`.                     |
| Data directory             | A persistent volume or disk for `STUDIO_DIR` / `HOME`. See below.                                      |
| Spend limit                | A budget alert or hard limit with your model vendor.                                                   |
| Monitoring                 | `METRICS_TOKEN` set if you scrape `/metrics`; `LOG_FORMAT=json` if a log collector parses the lines.   |

All variables are described in `.env.example`. The values for sessions are in [security](security.md#rate-limits).
Note that `RELAY_MAX_PAYLOAD_BYTES` is clamped to 320 KiB–1 MiB; the default is 384 KiB.

## Health and readiness

| Endpoint       | Use it for | Answer                                                                         |
| -------------- | ---------- | ------------------------------------------------------------------------------ |
| `GET /health`  | Liveness   | `200` with JSON: provider, assistant, voice backends, uptime, build, counters. |
| `GET /ready`   | Readiness  | `200` when ready, `503` with a list of issues.                                 |
| `GET /metrics` | Monitoring | Prometheus text format. Only with `METRICS_TOKEN` set; `404` otherwise.        |

`/health` answers `200` whenever the process is up. Point load balancers and container health checks at it.

`/ready` is for deploy gates and dashboards. Its `issues` can contain:

| Issue                             | Meaning                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `provider-credentials-missing`    | A live `VOICE_PROVIDER` is set but its key is missing.                          |
| `access-control-not-configured`   | Production mode with no `RELAY_AUTH_TOKEN` and no accounts: anyone can connect. |
| `open-registration-enabled`       | Production, accounts exist, no relay token, and registration is still on.       |
| `accounts-storage-unavailable`    | The accounts file cannot be written.                                            |
| `user-memory-storage-unavailable` | The per-user memory file cannot be written.                                     |
| `shutting-down`                   | The relay received a stop signal and is draining.                               |

`/ready` also returns `warnings`: problems an operator should fix that do not make the relay unready, so they never turn
the answer into `503`.

| Warning                    | Meaning                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `proxy-headers-untrusted`  | A request arrived through a proxy (`X-Forwarded-For` or `Forwarded`) while `RELAY_TRUST_PROXY` is off.                         |
| `cloud-secrets-unreadable` | Max Cloud holds a stored model key or webhook secret that no configured `CLOUD_SECRET_KEY` can read. See [cloud.md](cloud.md). |

Both endpoints send `Cache-Control: no-store`. A relay with `VOICE_PROVIDER=mock` and `NODE_ENV=production` and no token
reports `access-control-not-configured` and `503`: that is the check working.

### Metrics

Set `METRICS_TOKEN` to a long random value (`openssl rand -hex 32`) and scrape `GET /metrics` with it as a bearer token.
Without the token the endpoint answers `404`; with a wrong one, `401`. A Prometheus job:

```yaml
scrape_configs:
  - job_name: max-relay
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ["relay.example.com"]
```

It exports the relay's counters (`max_relay_sessions_total`, `max_relay_rejected_upgrades_total`,
`max_relay_upstream_failures_total`, audio bytes, Max Speech outcomes and more), gauges for open voice sessions and open
`/agent` and `/companion` sockets, the number of account names under login backoff, `max_relay_process_uptime_seconds`
and `max_relay_build_info`. Counters start from zero when the process starts, which Prometheus' `rate()` handles.

With Max Cloud on, it also exports the billing counters. Alert on the second one: it means finished sessions could not
be written to the ledger (they are kept and retried, but something is wrong with the database or its disk).

| Counter                                        | Counts                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `max_cloud_sessions_booked_total`              | Finished sessions written to the ledger.                              |
| `max_cloud_booking_failures_total`             | Failed attempts to write one; the session is kept and retried.        |
| `max_cloud_bookings_retried_total`             | Sessions booked by a retry after a failed first attempt.              |
| `max_cloud_sessions_recovered_total`           | Sessions left by a stopped relay, booked up to their last checkpoint. |
| `max_cloud_topups_credited_total`              | Paid top-ups credited to a balance.                                   |
| `max_cloud_topups_refused_total`               | Verified payments that could not be credited.                         |
| `max_cloud_sessions_killed_key_rotation_total` | Sessions closed because the project key was rotated or deleted.       |
| `max_cloud_spend_cap_refusals_total`           | Tokens or sessions refused, or closed, by a project's monthly limit.  |
| `max_cloud_secrets_unreadable`                 | Stored secrets no configured key can read (a gauge; 0 is healthy).    |

## Scaling

**The relay is single-instance by design: run one process per data directory.** Two processes sharing a data directory,
or two replicas behind one address, give wrong answers rather than more capacity:

- **State in process memory.** Minted session tokens, live voice sessions, the per-customer session caps of Max Cloud,
  the per-IP rate limits and the per-account login backoff exist only inside the process. A second process has its own
  copies, so a token minted on one is refused by the other, and every cap and limit doubles.
- **Whole-file rewrites.** `accounts.json`, `companion-bindings.json`, `user-memory.json`, the usage file, the Studio
  files and the session history archive are each loaded into memory and rewritten in full on every change (write a
  temporary file, then rename). Two processes writing the same file do not merge: the last writer wins, and the other's
  change (a new account, a logout, a pairing, a booked minute) is silently lost.
- **The exception.** Max Cloud's SQLite database is the only store that is safe for concurrent access. Even so, run one
  relay against it: the caps and limits above live in memory.

A single small process handles many sessions, because audio is relayed, not processed. When you need more:

- **Vertical first.** Give the process more CPU and memory. The `pipeline` and `local` backends do the most work in
  the relay, because they detect speech and resample audio there.
- **One relay per region.** Run an independent relay near each group of users, each with its own token and its own
  data directory. They share nothing: each has its own accounts and its own limits.
- **Several relays behind one address** works only if each has its own data directory and you route by a stable key.
  Mint a session token against the relay that will serve the session, because tokens exist only on the relay that
  issued them: route sticky (by the token, the user or a cookie), or have your backend return both the token and the
  relay URL it came from. A connect that lands on another relay gets 401, so your backend must be able to mint again.
  Accounts and Max Cloud do not work this way; run them on one relay.

The relay restarts quickly and revokes all minted session tokens when it does. Login sessions survive a restart. Active
voice sessions drop with close code 1001, and the SDK reconnects with a fresh token.

## Logs

The relay writes plain-text log lines to standard output and standard error, one event per line, with a timestamp,
a level and a source such as `relay` or `sess:8021ea69`. With `LOG_FORMAT=json` each line is instead one JSON object
with `time`, `level`, `scope`, `message` and the event's own fields at the top level (a field that would clash with
those four is renamed `field_<name>`). Collect them with your platform:

```bash
docker compose logs -f relay          # Docker Compose
pm2 logs max                          # the pm2 deployment
journalctl -u voice-relay -f          # a systemd unit
```

`LOG_LEVEL` is `debug`, `info`, `warn` or `error` (default `info`). Speech-recognition text is never logged. Debug
level adds lengths and wake-word decisions. At start, the relay logs its effective configuration, including
warnings such as tools that were dropped and why.

## Data directory

The relay keeps state in one directory, `~/.max-relay` by default (the name is historical). Set `STUDIO_DIR`
to move the Studio's files, and `HOME` (or the per-file variables below) to move the rest. In Docker both are under
`/data`.

| File                      | Contents                                                                               | Override                                           |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `accounts.json`           | Users and login sessions (passwords and session tokens hashed).                        | `ACCOUNTS_FILE` (`off` keeps it in memory)         |
| `user-memory.json`        | Per-user conversation memory.                                                          | `USER_MEMORY_FILE` (`off` disables it)             |
| `testing.sqlite`          | QA evidence, runs, reviews, policies and audit log.                                    | `TESTING_DATABASE` (`off` for ephemeral runs)      |
| `sessions.jsonl`          | Append-only archive of completed sessions, with transcripts.                           | `TESTING_HISTORY_DIR` (`off` disables it)          |
| `companion-bindings.json` | Phone pairing for the wearable companion app.                                          |                                                    |
| `assistant.config.json`   | The assistant saved from the Studio admin screen. Wins over `./assistant.config.json`. | `STUDIO_DIR`, or `ASSISTANT_CONFIG` to name a file |
| `voice-backends.json`     | Voice backend keys and models entered in the Studio (mode 600).                        | `STUDIO_DIR`                                       |
| `brand-logo.svg` / `.png` | A logo uploaded in the Studio.                                                         | `STUDIO_DIR`                                       |

Back this directory up if you use accounts or the Studio. It contains transcripts of user conversations, so protect
it like user data, and set a retention policy (`TESTING_HISTORY_MAX_SESSIONS`, `TESTING_ARCHIVE_MAX_SESSIONS`). If you
embed the SDK only and want no persistence, you can set `ACCOUNTS_FILE=off`, `USER_MEMORY_FILE=off` and
`TESTING_DATABASE=off`.

Minted session tokens (`vst_...`) are never written to disk. Login session tokens are stored only as SHA-256 hashes; see
[security](security.md#accounts).

## Updating

1. Build the new version (`npm run build`, or `docker build`).
2. Replace the running process: **stop the old process, then start the new one.** Do not run a rolling or
   blue-green deploy that starts the new process while the old one still runs against the same data directory: for
   that overlap both write the same files, and whichever writes last silently undoes the other (see
   [Scaling](#scaling)). `SIGTERM` makes the old process close sessions with 1001 and flush its files before it exits;
   wait for it to exit. Clients reconnect.
3. Check `/ready` and `/health`. `build.gitCommit` in the answer tells you which version is running.

In Docker Compose this is the default (`docker compose up -d` stops the old container first). In Kubernetes use the
`Recreate` strategy with one replica. With pm2, `pm2 restart` stops before it starts; do not use `pm2 reload` or cluster
mode.

The first start of this version rewrites `accounts.json` so that it holds session-token hashes instead of the tokens
themselves. Existing logins keep working. An older relay cannot read the hashes back, so after a rollback to an older
version everyone has to sign in again.

`deploy-lightsail.command` automates this for the maintainers' own test server and rolls back when the health check
fails. It is specific to that host, so treat it as an example.
