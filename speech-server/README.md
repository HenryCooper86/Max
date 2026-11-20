# Max Speech

Max Speech is a local speech server. It serves OpenAI-compatible speech-to-text (Whisper) and text-to-speech
(Kokoro) from models whose weights are commercially usable, so Max's `local` voice pipeline can run without a cloud
provider.

It listens on port **8790**. The model list, licenses and hardware profiles are in
[docs/local-models.md](../docs/local-models.md).

## Quick start

Models download on first start into `~/.max-speech/models`, at pinned revisions. The server answers `503` until they
have loaded.

### Mac (Apple silicon)

```bash
uv sync --extra mlx
uv run --extra mlx max-speech serve
```

### Linux (CPU or CUDA)

```bash
uv sync
uv run max-speech serve
```

`max-speech engines` prints the engines, models and licenses the server will use, without loading anything.
`max-speech download` fetches the models and exits.

## Access and API keys

With no key set, the server accepts only loopback clients. Set `SPEECH_API_KEY` to accept connections from other
machines, and always set it when the server sits behind a reverse proxy. Clients then send
`Authorization: Bearer <key>`.

`/healthz` and `/.well-known/max-speech` need no key. Everything under `/v1` does.

## Configuration

| Variable            | Default         | Meaning                                                        |
| ------------------- | --------------- | -------------------------------------------------------------- |
| `SPEECH_API_KEY`    | unset           | Bearer token required on `/v1`. Unset means loopback only.     |
| `SPEECH_PROFILE`    | detected        | `mlx`, `cuda` or `cpu`. Detected from the hardware when unset. |
| `SPEECH_DATA_DIR`   | `~/.max-speech` | Where models are stored (`models/` under this directory).      |
| `SPEECH_STT_ENGINE` | profile default | `whisper-ct2`, `whisper-mlx`, or `off`.                        |
| `SPEECH_TTS_ENGINE` | `kokoro`        | `kokoro`, or `off`.                                            |
| `SPEECH_STT_MODEL`  | profile default | Any speech-to-text model id in the license registry.           |
| `SPEECH_TTS_MODEL`  | `kokoro-v1.0`   | Any text-to-speech model id in the license registry.           |

`serve` also takes `--host`, `--port` and `--profile`, which override the environment.

Defaults per profile:

| Profile | Speech-to-text                  | Engine        |
| ------- | ------------------------------- | ------------- |
| `mlx`   | `mlx-whisper-large-v3-turbo`    | `whisper-mlx` |
| `cuda`  | `faster-whisper-large-v3-turbo` | `whisper-ct2` |
| `cpu`   | `faster-whisper-small`          | `whisper-ct2` |

Text-to-speech is `kokoro-v1.0` on every profile. Kokoro runs on the CPU through onnxruntime unless
`onnxruntime-gpu` is installed, in which case it uses CUDA. GPU speech-to-text needs the CUDA 12 and cuDNN 9
libraries that faster-whisper and CTranslate2 require; if they are missing, the server logs a warning and
runs the same model on the CPU with int8.

## Endpoints

| Method | Path                       | Notes                                                   |
| ------ | -------------------------- | ------------------------------------------------------- |
| GET    | `/healthz`                 | `{"ok": true, "ready": bool}`                           |
| GET    | `/.well-known/max-speech`  | Protocol version, active engines and model attributions |
| POST   | `/v1/audio/speech`         | Text to audio (see below)                               |
| POST   | `/v1/audio/transcriptions` | Audio to text (see below)                               |
| GET    | `/v1/audio/voices`         | Voice ids, names, languages and gender                  |
| GET    | `/v1/models`               | The active model ids plus the OpenAI aliases            |
| GET    | `/v1/models/{id}`          | One model, or `404`                                     |

### Speech (`POST /v1/audio/speech`)

- `input`: required, at most 4096 characters.
- `voice`: a Kokoro voice id (for example `af_heart`), or `default`. The OpenAI names `alloy`, `nova`, `shimmer`,
  `coral`, `sage` map to a default female voice; `onyx`, `echo`, `ash`, `ballad`, `fable`, `verse` map to a default
  male voice.
- `speed`: 0.25 to 4.0, default 1.0. Kokoro supports 0.5 to 2.0, so values outside that range are clamped for Kokoro.
- `language`: optional. Kokoro speaks English, Chinese, Spanish, French, Hindi, Italian, Japanese and Portuguese.
- `response_format`: `wav` (default) or `pcm`. Both are 24 kHz, mono, 16-bit. MP3, Opus, AAC and FLAC return `400`.
- `stream_format`: optional. `audio` streams raw PCM as it is produced (requires `response_format: "pcm"`). `sse`
  streams server-sent events, each carrying base64 PCM in `speech.audio.delta`, ending with `speech.audio.done`.

Responses carry an `X-Max-Speech-Engine` header. When the client disconnects, synthesis stops.

### Transcription (`POST /v1/audio/transcriptions`)

Multipart form with a `file` field: WAV, FLAC or OGG, up to 25 MB and 15 minutes long. Optional `language` and
`prompt`. `response_format` is `json` (default), `text` or `verbose_json` (adds language, duration and segments).
`model` and `temperature` are accepted for SDK compatibility and ignored: the active model serves every name.

## Licenses

Every model must have an entry in [`src/max_speech/licenses/registry.toml`](src/max_speech/licenses/registry.toml).
A model without an entry never downloads or loads. The entry's weights license must be one of Apache-2.0, MIT,
BSD-2-Clause, BSD-3-Clause, CC-BY-4.0 or CC0-1.0 (see `ALLOWED_WEIGHTS_LICENSES` in
`src/max_speech/licenses/__init__.py`). Anything else fails before the first download.

To add a model:

1. Read the model's license at its `license_url`. Check the weights, and note any code or runtime licenses.
2. Add a `[models."<id>"]` table to `registry.toml`. Give it `kind` (`stt` or `tts`), `source` and the files or repo.
   For `source = "hf"`, pin a 40-character commit sha in `revision`. For `source = "url"`, give each file a
   `sha256`. Also set `weights_license`, `code_license`, `license_url`, `checked` (today's date) and `attribution`.
3. If the model needs an engine that does not exist yet, add it under `src/max_speech/engines/` and wire it into
   `engines/select.py`. The registry entry alone does not make a model runnable.

Kokoro's weights are Apache-2.0, but its phonemizer and espeak-ng are GPL-3.0 code, imported in-process by
`kokoro-onnx`. Running Max Speech as a service is fine. If you distribute an image or other bundle that includes
them, you must also offer their source under GPL-3.0.

## Benchmark

The latency benchmark works against any OpenAI-compatible speech server. With the server running:

```bash
uv run python -m bench.latency --base-url http://localhost:8790/v1 --runs 5 --json bench/out/run.json
```

Options: `--api-key`, `--voice`, `--tts-model`, `--stt-model`, `--fixtures DIR` (WAV files, each with an optional
`.txt` reference), and `--format wav` for servers that only return WAV, where time to first byte equals total time.

Text-to-speech reports time to first byte, total time, audio seconds and real-time factor. Speech-to-text reports
latency, plus word error rate for English or character error rate for Chinese when a reference is known. Tables show
p50 and p95. Output goes to `bench/out/`, which is git-ignored. See [bench/README.md](bench/README.md).

## Tests

```bash
uv run pytest -q
uv run ruff check .
```

The default tests use fake engines and need no models. The real-model tests download and run the models; they are
off unless you opt in:

```bash
MAX_SPEECH_MODEL_TESTS=1 uv run --extra mlx pytest -q -m models
```

On Linux, drop `--extra mlx`.
