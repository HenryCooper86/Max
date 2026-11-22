# Deploying Max Speech

[Max Speech](../speech-server/README.md) is the local speech server on port 8790. This page covers running it on a
Mac, in Docker (CPU or NVIDIA), and behind a reverse proxy. Which models it uses and why is in
[local-models.md](local-models.md).

| Where                | Profile | How                                               |
| -------------------- | ------- | ------------------------------------------------- |
| Apple silicon Mac    | `mlx`   | Native: `start-speech.command`                    |
| Linux, any machine   | `cpu`   | Docker target `cpu`, or `uv run max-speech serve` |
| Linux with an NVIDIA | `cuda`  | Docker target `cuda` (not yet tested on a GPU)    |
| Docker on a Mac      | `cpu`   | Works, slowly: Docker on a Mac has no Metal       |

Use the native Mac setup on Apple silicon. It is the only one that gets the MLX models, cloning and voice design.

## Mac, native

Double-click `start-speech.command` in the repo root. It checks that [uv](https://docs.astral.sh/uv/) is installed,
runs `uv sync --extra mlx`, and starts the server on `http://localhost:8790`. Without an API key it answers loopback
clients only, which is what you want on a laptop. It exits with a message on an Intel Mac. If `SPEECH_API_KEY` is set
in your environment, it prints the keyed relay settings instead. Equivalent by hand:

```bash
cd speech-server
uv sync --extra mlx
uv run --extra mlx max-speech serve
```

Then in the relay's `.env`, either use the live session backend:

```dotenv
VOICE_PROVIDER=max-speech
MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session
```

or the local pipeline:

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
LOCAL_STT_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_FORMAT=pcm
```

## Docker, CPU

```bash
docker build --target cpu -t max-speech:cpu speech-server
docker run -d --name max-speech -p 127.0.0.1:8790:8790 \
  -e SPEECH_API_KEY="$(openssl rand -hex 24)" \
  -v max-speech-data:/data max-speech:cpu
```

`127.0.0.1:` publishes the port on this machine only. To reach it from other machines use `-p 8790:8790`, with the API
key set (it always is, see below).

Keep the key you generated: the relay needs it as `MAX_SPEECH_API_KEY` (live session backend) or `LOCAL_API_KEY`
(local pipeline, or `LOCAL_STT_API_KEY` and `LOCAL_TTS_API_KEY` per stage).

- **A key is required to serve.** In a container the server binds `0.0.0.0`, and without a key it answers loopback
  clients only, so a mapped port could never be reached. The image's entrypoint exits with code 64 if
  `SPEECH_API_KEY` is empty and the command is `max-speech serve`. Other commands (`download`, `engines`) need no key.
- **Port.** The server listens on `SPEECH_PORT` (default 8790), which the entrypoint and the image's healthcheck both
  read. To change it, set `-e SPEECH_PORT=9000` and publish that port; do not pass `--port` alone, or the healthcheck
  keeps probing 8790. An argument starting with `-` replaces the default options: `docker run IMAGE --log-level debug`
  runs `max-speech serve --host 0.0.0.0 --log-level debug`.
- **Anonymous volume.** The image declares `/data` as a volume. `docker run` without `-v max-speech-data:/data` creates
  an anonymous volume that holds the downloaded models and voices but is easy to lose track of (`docker volume ls`
  shows it with a hash for a name). Always name the volume.
- **Models** download into `/data/models` on first start. Keep `/data` on a volume so a restart does not download
  them again.
- **Health.** `/healthz` returns `{"ok": true, "ready": false}` while models load and `ready: true` after. The image's
  healthcheck is healthy once `ready` is true, with a 20 minute start period for the first download. A failed load
  is not left hanging: download and network failures are retried (4 tries, 5 s then 10 s then 20 s apart; see
  `SPEECH_LOAD_ATTEMPTS` and `SPEECH_LOAD_BACKOFF_S`), and the last error is in the `/healthz` body as `error`. When
  the tries run out, or the failure is a configuration or install problem, `/healthz` answers `503` with the error and
  the process exits with status 1, so `restart: unless-stopped` (or systemd, launchd) starts it again. Read the reason
  with `docker logs max-speech`. A bad configuration therefore shows as a restart loop, not as a server that stays up
  answering 503.
- **Port clash.** A native Max Speech on the same machine also uses 8790. Publish the container elsewhere, for
  example `-p 127.0.0.1:18790:8790`, and point the relay at that port.
- **Runs as user 10001**, not root. A bind mount for `/data` must be writable by that user.

`docker-compose.local-voice.yml` runs the same image next to Ollama:

```bash
echo "SPEECH_API_KEY=$(openssl rand -hex 24)" >> .env
docker compose -f docker-compose.local-voice.yml up -d --build
```

To run it together with the relay from `docker-compose.yml`, list both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-voice.yml up -d --build
```

Compose starts the relay without waiting for Ollama, so its first chat request can fail while Ollama is still
starting (Ollama has a healthcheck, `ollama list`). To make the relay wait, put this in a third file and add
`-f` for it (it cannot be in the local-voice file, which has to stay valid on its own):

```yaml
services:
  relay:
    depends_on:
      ollama: { condition: service_healthy }
```

The Ollama image is pinned to a tested release (`ollama/ollama:0.40.17`), so it does not change when images are pulled
again. Raise the tag in `docker-compose.local-voice.yml` when you have tested a newer one.

The compose file publishes both ports on `127.0.0.1` only. Ollama has no authentication, so do not publish `11434`
beyond loopback unless something in front of it authenticates; with the relay in the same network you can remove that
`ports` entry. The relay settings depend on where the relay runs.

**Relay on the host** (Max Speech at `localhost:8790`, Ollama at `localhost:11434`, which is the relay's default chat
endpoint). Set `LOCAL_LLM_MODEL` if you pulled something other than `qwen3:8b`:

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
LOCAL_STT_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_FORMAT=pcm
LOCAL_STT_API_KEY=<the same value as SPEECH_API_KEY>
LOCAL_TTS_API_KEY=<the same value as SPEECH_API_KEY>
```

or `VOICE_PROVIDER=max-speech` with `MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session` and `MAX_SPEECH_API_KEY`.
Per-stage keys are better than `LOCAL_API_KEY` here: `LOCAL_API_KEY` applies to all three stages, so it would also
send the speech key to Ollama.

**Relay in the compose network** (services reach each other by name). The relay's chat stage defaults to
`http://localhost:11434/v1`, which inside the relay's own container is the relay itself, so point it at Ollama:

```dotenv
LOCAL_LLM_BASE_URL=http://ollama:11434/v1
LOCAL_LLM_MODEL=qwen3:8b
# then either the live session backend:
VOICE_PROVIDER=max-speech
MAX_SPEECH_URL=ws://max-speech:8790/v1/speech/session
MAX_SPEECH_API_KEY=<the same value as SPEECH_API_KEY>
# or the local pipeline:
VOICE_PROVIDER=local
LOCAL_VOICE=on
LOCAL_STT_BASE_URL=http://max-speech:8790/v1
LOCAL_TTS_BASE_URL=http://max-speech:8790/v1
LOCAL_TTS_FORMAT=pcm
LOCAL_STT_API_KEY=<the same value as SPEECH_API_KEY>
LOCAL_TTS_API_KEY=<the same value as SPEECH_API_KEY>
LOCAL_LLM_API_KEY=ollama
```

The local pipeline counts as configured only when every stage has a key or a `localhost` (or `127.0.0.1`, `[::1]`,
`*.local`) address. `http://ollama:11434` is neither, so without `LOCAL_LLM_API_KEY` the provider is reported as not
configured. Ollama ignores the value; any non-empty string works. Setting `LOCAL_API_KEY=<key>` instead satisfies all
three stages at once, at the cost of sending the speech key to Ollama.

A relay in Docker cannot use a native keyless Max Speech through `host.docker.internal`: the `Host` header is not
local, so the server answers 403 `forbidden_host`. Set `SPEECH_API_KEY` on the native server (export it before
double-clicking `start-speech.command`, or run it by hand) and give the relay the key.

## Docker, NVIDIA

This target has not been run on GPU hardware yet. It builds and starts, but treat the GPU path as untested until you
have seen it transcribe.

```bash
docker build --target cuda -t max-speech:cuda speech-server
docker run -d --name max-speech --gpus all -p 127.0.0.1:8790:8790 \
  -e SPEECH_API_KEY=... -v max-speech-data:/data max-speech:cuda
```

You need the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
on the host. The image is `nvidia/cuda` 12.6 with cuDNN 9 (what CTranslate2 needs) and Python 3.12 from uv, and it
sets `SPEECH_PROFILE=cuda`: `faster-whisper-large-v3-turbo` on the GPU. Text-to-speech, voice detection and the other
live-session models stay on the CPU, and the `cuda` profile has no cloning or voice design. If the GPU or its libraries
are not visible, the server logs a warning, runs the same model on the CPU with int8, and turns the live session's
second pass off (unless you set `SPEECH_SECOND_PASS=on`), so check the log. The large model on the CPU is slow: on a
machine without a GPU use the `cpu` image instead, which defaults to the small model.

In compose, the image follows `MAX_SPEECH_TARGET`, so the cuda build is tagged `max-speech:cuda` and never replaces the
cpu one. Uncomment the `deploy` block on `max-speech`, then:

```bash
MAX_SPEECH_TARGET=cuda docker compose -f docker-compose.local-voice.yml up -d --build
```

## Limits

| What                                                      | Default                     | Setting                              |
| --------------------------------------------------------- | --------------------------- | ------------------------------------ |
| Live sessions at once                                     | `cpu` 2, `mlx` 4, `cuda` 8  | `SPEECH_MAX_SESSIONS`                |
| Time for a new session to send its first `session.update` | 15 s                        | `SPEECH_SESSION_HANDSHAKE_TIMEOUT_S` |
| Time a session may receive nothing from its client        | off (`0`)                   | `SPEECH_SESSION_IDLE_TIMEOUT_S`      |
| A client that stops answering WebSocket pings             | closed within 40 s          | fixed (ping 20 s, pong 20 s)         |
| Transcription requests in progress                        | 4                           | `SPEECH_MAX_TRANSCRIPTIONS`          |
| Time a transcription upload may take to arrive            | 300 s                       | `SPEECH_UPLOAD_TIMEOUT_S`            |
| Voice design requests in progress                         | 1 running, 1 waiting        | fixed                                |
| JSON request body (everything except audio uploads)       | 256 KB; lexicon 1,172,096 B | fixed                                |
| Uploaded audio                                            | 25 MB, 15 minutes           | fixed                                |

A session over the cap gets the error `busy` and is closed with code 1013 and reason `busy`; the relay reports
"Max Speech is at its limit of live sessions". A timeout of `0` turns that timeout off. Each session holds a voice
detector and recognizer stream and shares one speech engine with the others, so raise the cap only as far as the
machine keeps up: the defaults are conservative. A transcription over the cap gets `429` with `Retry-After` before its
upload is read, and one whose upload has not arrived after `SPEECH_UPLOAD_TIMEOUT_S` gets `408`; a design request
beyond the two in progress gets `429`. `curl` the `live.max_sessions` field of `/.well-known/max-speech` to see the cap a server is running with.

The idle timeout is off because the relay sends no audio while a rider is muted: with a timeout, a muted rider's
session was closed every 10 minutes, and on a full server its reconnects were refused with `busy`. A client whose
network is gone stops answering the server's WebSocket pings and is closed within 40 s, which frees its slot. Set
`SPEECH_SESSION_IDLE_TIMEOUT_S` only if you also want quiet sessions closed; `ready` and `live.idle_timeout_s` in
`/.well-known/max-speech` report it (`null` when off).

## Behind a reverse proxy

Always set `SPEECH_API_KEY`. A proxy on the same machine makes every client look like loopback, so without a key
anyone who can reach the proxy could use the server.

- Forward WebSockets for `/v1/speech/session` (`Upgrade` and `Connection` headers) and turn off response buffering
  for `/v1/audio/speech` streaming.
- Pass the `Authorization` header through. Terminate TLS at the proxy.
- Browsers that open the session WebSocket directly must have their origin listed:
  `SPEECH_ALLOWED_ORIGINS=https://app.example.com` (comma-separated). Native clients and the relay send no `Origin`
  and need no entry. Any HTTP request that carries a foreign `Origin` is refused with 403 `forbidden_origin`.
- `/healthz` and `/.well-known/max-speech` need no key; everything under `/v1` does. Keep the server off the public
  internet if you can, and put the relay in front of it.

Caddy example:

```
speech.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

## Models and offline installs

Models are fetched at pinned revisions on first start. To fetch them ahead of time, for example on a build machine or
before going offline:

```bash
docker run --rm -v max-speech-data:/data max-speech:cpu max-speech download
```

Native: `uv run --extra mlx max-speech download`. Pass `--profile cpu|cuda|mlx` to fetch another profile's set. For a
machine with no internet, run the download elsewhere and copy the volume's `models/` directory into the target's
`SPEECH_DATA_DIR` (`/data` in the container). `max-speech engines` prints what the server will use, without loading
anything (`docker run --rm max-speech:cpu max-speech engines`). Neither needs an API key.

## Data and backups

`SPEECH_DATA_DIR` (`/data`, or `~/.max-speech` natively) holds:

- `models/`: downloaded models. Safe to delete; they download again.
- `voice-audit.log`: one JSON line for every voice created or deleted (when, which voice, speaker, audio hash, caller
  address and key id), mode 0600. It is personal data too, and it is an ordinary file: see what the consent record
  does and does not prove in the [Max Speech README](../speech-server/README.md#what-the-consent-record-does-and-does-not-prove).
- `voices/`: custom voices. These are **consented recordings of real people** and the cloning data derived from them.
  Treat them as personal data: back them up to somewhere access-controlled, delete a voice when its owner withdraws
  consent, and do not copy them into shared storage.

Back up only the voices:

```bash
docker run --rm -v max-speech-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/max-speech-voices.tgz -C /data voices
```

## Upgrading

```bash
git pull
docker build --target cpu -t max-speech:cpu speech-server
docker rm -f max-speech && docker run -d ...   # same flags, same volume
```

The volume is kept, so models and voices carry over. A new release may pin a newer model revision; that one model
downloads on the next start. Native: `git pull`, then double-click `start-speech.command` again (it re-syncs).

## Resources

| Profile         | Disk (models)                                                                                          | Memory while serving                                                           | Notes                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `cpu`           | about 1.5 GB                                                                                           | about 2 GB                                                                     | Whisper small, Kokoro, voice and turn models                           |
| `cpu` + cloning | add about 730 MB                                                                                       | add about 2 GB                                                                 | `SPEECH_CLONING_MODEL=moss-tts-nano-onnx`                              |
| `cuda`          | about 2.5 GB                                                                                           | about 3 GB RAM, 2 to 4 GB VRAM                                                 | Large-v3-turbo on the GPU                                              |
| `mlx`           | about 2.4 GB, plus 2.3 GB for cloning (on by default) and 4.2 GB for design (on with 24 GB+ of memory) | about 4 GB, plus about 4 GB for cloning; design peaks near 8.6 GB while in use | Measured on an M5 Max: 4.7 GB of models by default, 8.9 GB with design |

The CPU Docker image is about 800 MB; the CUDA image about 4.1 GB. The `cpu` figures were measured in a container
(1.4 GB of models, 1.9 GB resident) and the `mlx` download sizes on an M5 Max; the rest are estimates; see the [README](../speech-server/README.md) for the exact model list.

## Troubleshooting

- **401 `api_key_required`**: the server has no `SPEECH_API_KEY` and the client is not loopback (a published
  container port always arrives from the Docker network, never loopback). Set `SPEECH_API_KEY` on the server and send
  `Authorization: Bearer <key>`.
- **403 `forbidden_host`**: the server has no `SPEECH_API_KEY` and the request's `Host` is not `localhost` or
  `127.0.0.1` (for example `host.docker.internal` or a LAN name). This is checked before the client address. Set
  `SPEECH_API_KEY` on the server; this includes a native server that a relay in Docker reaches through
  `host.docker.internal`.
- **401 `invalid_api_key`**: the key is wrong. The relay's `MAX_SPEECH_API_KEY` (or `LOCAL_API_KEY`) must equal the
  server's `SPEECH_API_KEY`. Check that a native server on 8790 is not answering instead of your container.
- **403 `forbidden_origin`** on a WebSocket from a web page: add the page's origin to `SPEECH_ALLOWED_ORIGINS`.
- **503 while starting**: the models are still downloading or loading. Watch `docker logs -f max-speech` and
  `/healthz` for `ready: true`. This is normal for the first few minutes. If `/healthz` itself answers 503, the load
  failed for good and the container is restarting; its `error` field and the log say why.
- **"incomplete ... interrupted first download"** at start: a model download was cut off and the server started
  without a network. Start it again with network access, or run `max-speech download`; partial files are kept and the
  download continues.
- **Sessions are refused with `busy`**: the server is at `SPEECH_MAX_SESSIONS`. Close idle clients or raise it.
- **A download stalls**: the models come from Hugging Face and GitHub releases, and some downloads go slowly for
  minutes without failing. Wait, or stop and start the container; completed files are kept in the volume and the
  download resumes. Behind a proxy, pass `HTTPS_PROXY` to the container. Corporate networks may block one of the hosts.
- **Container exits at once with code 64**: `SPEECH_API_KEY` is empty and the command is `serve`.
- **The relay says the local provider is not configured**: with the relay in the compose network, set
  `LOCAL_LLM_BASE_URL=http://ollama:11434/v1` and `LOCAL_LLM_API_KEY=ollama` (see above).
- **CUDA container is slow**: the log says it fell back to the CPU (and that the second pass is off). Check `nvidia-smi` on the host and that
  `--gpus all` (or the compose `deploy` block) is set.
