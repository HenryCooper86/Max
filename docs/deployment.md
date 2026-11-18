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
`npm ci --omit=dev`, and restarts a pm2 process named `horizon` that runs `tsx server/index.ts` on port 8787. Both ways
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
- The image sets `HOME=/data` and `STUDIO_DIR=/data/.horizon-helmet-testing`. Mount a volume at `/data` or you lose
  accounts, history and Studio settings when the container is replaced.
- To use your own assistant identity, mount the file and point at it:

  ```bash
  docker run -d -p 8787:8787 --env-file .env -v relay-data:/data \
    -v "$PWD/assistant.config.json:/app/assistant.config.json:ro" voice-agent-kit
  ```

  A `toolsModule` or `logo` path in that file is resolved relative to the config file, so mount those files beside it
  inside the container too.

- The image has a `HEALTHCHECK` on `/health`.
- To reach model servers on your host from the container (Ollama, for example), use `host.docker.internal` or a
  Compose network, not `localhost`.
- For a local-model stack, see [local-models.md](local-models.md) and `docker-compose.local-voice.yml`.

## Reverse proxy with TLS

Browsers need a secure origin for the microphone, and a token in a URL needs TLS. Put a proxy in front that terminates
TLS and forwards WebSocket upgrades. Then tell the relay it is behind a proxy:

```dotenv
RELAY_TRUST_PROXY=on
RELAY_TRUSTED_PROXY_HOPS=1
```

With this on, the per-IP rate limit reads the real client address from `X-Forwarded-For`. Without it every client looks
like the proxy. Turn it on only when the relay is reachable through the proxy alone.

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

| Check                      | Setting                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A real backend and its key | `VOICE_PROVIDER` and its API key (see [backends](backends.md)). `mock` is for development.                     |
| Access control             | `RELAY_AUTH_TOKEN` set to a long random value: `openssl rand -hex 32`.                                         |
| Browser origins            | `RELAY_ALLOWED_ORIGINS` set to your site origins, if browsers connect.                                         |
| Proxy awareness            | `RELAY_TRUST_PROXY=on` behind exactly one trusted proxy, with `RELAY_TRUSTED_PROXY_HOPS` set to the hop count. |
| Production mode            | `NODE_ENV=production`.                                                                                         |
| Rate limits                | `RELAY_CONN_PER_MINUTE` suits your traffic (default 30 per IP per minute).                                     |
| Account sign-up            | `AUTH_REGISTRATION=off` if you use accounts and the team has registered.                                       |
| Backend switching          | `VOICE_PROVIDER_SWITCHING=off` if clients must not choose a backend.                                           |
| Webhook secrets            | `TOOL_WEBHOOK_SECRET` (or your name) set, and referenced as `${TOOL_WEBHOOK_SECRET}`.                          |
| Assistant identity         | `ASSISTANT_CONFIG` points at your `assistant.config.json`, or run `npm run setup`.                             |
| Data directory             | A persistent volume or disk for `STUDIO_DIR` / `HOME`. See below.                                              |
| Spend limit                | A budget alert or hard limit with your model vendor.                                                           |

All variables are described in `.env.example`. The values for sessions are in [security](security.md#rate-limits).
Note that `RELAY_MAX_PAYLOAD_BYTES` has a floor of 320 KiB: the `65536` shown in `.env.example` is raised to 327,680.

## Health and readiness

| Endpoint      | Use it for | Answer                                                                         |
| ------------- | ---------- | ------------------------------------------------------------------------------ |
| `GET /health` | Liveness   | `200` with JSON: provider, assistant, voice backends, uptime, build, counters. |
| `GET /ready`  | Readiness  | `200` when ready, `503` with a list of issues.                                 |

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

Both endpoints send `Cache-Control: no-store`. A relay with `VOICE_PROVIDER=mock` and `NODE_ENV=production` and no token
reports `access-control-not-configured` and `503`: that is the check working.

## Scaling

One relay process holds, in memory:

- every live voice session (a WebSocket and its upstream connection to the model), and
- every live session token.

A single small process handles many sessions, because audio is relayed, not processed. When you need more:

- **Vertical first.** Give the process more CPU and memory. The `pipeline` and `local` backends do the most work in
  the relay, because they detect speech and resample audio there.
- **One relay per region.** Run an independent relay near each group of users, each with its own token and its own
  data directory. This is the simplest way to cut latency.
- **Several relays behind one address.** Mint a session token against the relay that will serve the session, because
  tokens exist only on the relay that issued them. Either route by a stable key (sticky routing by the token, the user
  or a cookie) so the connect reaches the issuing relay, or have your backend return both the token and the relay URL
  it came from. A connect that lands on another relay gets 401, so your backend must be able to mint again.
- **Shared state.** Accounts, history and memory are files and a SQLite database in the data directory. They are not
  shared between relays. If you use accounts, run one relay, or accept that each relay has its own users.

The relay restarts quickly and revokes all session tokens when it does. Active sessions drop with close code 1001, and
the SDK reconnects with a fresh token.

## Logs

The relay writes plain-text log lines to standard output and standard error, one event per line, with a timestamp,
a level and a source such as `relay` or `sess:8021ea69`. Collect them with your platform:

```bash
docker compose logs -f relay          # Docker Compose
pm2 logs horizon                      # the pm2 deployment
journalctl -u voice-relay -f          # a systemd unit
```

`LOG_LEVEL` is `debug`, `info`, `warn` or `error` (default `info`). Speech-recognition text is never logged. Debug
level adds lengths and wake-word decisions. At start, the relay logs its effective configuration, including
warnings such as tools that were dropped and why.

## Data directory

The relay keeps state in one directory, `~/.horizon-helmet-testing` by default (the name is historical). Set `STUDIO_DIR`
to move the Studio's files, and `HOME` (or the per-file variables below) to move the rest. In Docker both are under
`/data`.

| File                      | Contents                                                                               | Override                                           |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `accounts.json`           | Users and login sessions (passwords hashed).                                           | `ACCOUNTS_FILE` (`off` keeps it in memory)         |
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

Session tokens are never written to disk.

## Updating

1. Build the new version (`npm run build`, or `docker build`).
2. Replace the running process. Active sessions end with 1001 and clients reconnect.
3. Check `/ready` and `/health`. `build.gitCommit` in the answer tells you which version is running.

`deploy-lightsail.command` automates this for the maintainers' own test server and rolls back when the health check
fails. It is specific to that host, so treat it as an example.
