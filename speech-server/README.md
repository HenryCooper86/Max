# Max Speech

Max Speech is a local speech server. It serves OpenAI-compatible speech-to-text (Whisper) and text-to-speech
(Kokoro) from models whose weights are commercially usable, so Max's `local` voice pipeline can run without a cloud
provider. It also runs a live conversation over one WebSocket, `/v1/speech/session`: voice detection, turn-taking,
streaming transcripts and spoken replies, which Max's `max-speech` backend uses.

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

A WebSocket opened by a web page carries an `Origin` header. Under `/v1`, a WebSocket with an `Origin` whose host is
not `localhost`, `127.0.0.1` or `[::1]` (any port, `http` or `https`) is refused before accept (HTTP 403), with or
without a key, so a page on another site cannot talk to a server on your machine. List the origins you trust in
`SPEECH_ALLOWED_ORIGINS`. Native clients send no `Origin` and pass.

The same rules protect plain HTTP. Without a key, every HTTP request must carry a `Host` of `localhost`,
`127.0.0.1`, `[::1]` or the address given to `--host` (any port), or it is refused with 403 `forbidden_host`; this
blocks DNS rebinding. It covers `/healthz` and `/.well-known/max-speech` too. Any HTTP request that carries an `Origin` from another site is refused with 403
`forbidden_origin` (also with a key), before its body is read. `Origin: null` is refused. Requests with no `Origin`
(the relay, `curl`, the OpenAI SDK) are unaffected.

## Configuration

| Variable                  | Default             | Meaning                                                                              |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `SPEECH_API_KEY`          | unset               | Bearer token required on `/v1`. Unset means loopback only.                           |
| `SPEECH_PROFILE`          | detected            | `mlx`, `cuda` or `cpu`. Detected from the hardware when unset.                       |
| `SPEECH_DATA_DIR`         | `~/.max-speech`     | Where models are stored (`models/` under this directory).                            |
| `SPEECH_STT_ENGINE`       | profile default     | `whisper-ct2`, `whisper-mlx`, or `off`.                                              |
| `SPEECH_TTS_ENGINE`       | `kokoro`            | `kokoro`, or `off`.                                                                  |
| `SPEECH_STT_MODEL`        | profile default     | Any speech-to-text model id in the license registry.                                 |
| `SPEECH_TTS_MODEL`        | `kokoro-v1.0`       | Any text-to-speech model id in the license registry.                                 |
| `SPEECH_TTS_ZH_MODEL`     | `kokoro-v1.1-zh`    | Chinese text-to-speech model, or `off` to use v1.0 for Chinese.                      |
| `SPEECH_CLONING_MODEL`    | `mlx` only          | Voice cloning model (a registry entry with `cloning = true`), or `off`.              |
| `SPEECH_VAD_MODEL`        | `silero-vad-v6.2`   | Voice activity model for the live session, or `off`.                                 |
| `SPEECH_TURN_MODEL`       | `smart-turn-v3.2`   | End-of-turn model for the live session, or `off`.                                    |
| `SPEECH_STREAM_STT_MODEL` | `x-asr-zh-en-480ms` | Streaming speech-to-text for the live session (must be a streaming model), or `off`. |
| `SPEECH_SECOND_PASS`      | `auto`              | `on`, `off` or `auto` (on for the `mlx` and `cuda` profiles).                        |
| `SPEECH_ALLOWED_ORIGINS`  | unset               | Comma-separated browser origins allowed on WebSockets, beyond localhost.             |

`serve` also takes `--host`, `--port` and `--profile`, which override the environment.

Defaults per profile:

| Profile | Speech-to-text                  | Engine        |
| ------- | ------------------------------- | ------------- |
| `mlx`   | `mlx-whisper-large-v3-turbo`    | `whisper-mlx` |
| `cuda`  | `faster-whisper-large-v3-turbo` | `whisper-ct2` |
| `cpu`   | `faster-whisper-small`          | `whisper-ct2` |

Text-to-speech is `kokoro-v1.0` on every profile, plus `kokoro-v1.1-zh` for Chinese (below). Kokoro runs on the CPU through onnxruntime unless
`onnxruntime-gpu` is installed, in which case it uses CUDA. GPU speech-to-text needs the CUDA 12 and cuDNN 9
libraries that faster-whisper and CTranslate2 require; if they are missing, the server logs a warning and
runs the same model on the CPU with int8.

### Chinese speech

Kokoro v1.0 reads Chinese through espeak's Mandarin rules, which is poor: a speak-then-transcribe check on the five
Chinese benchmark phrases gave a mean character error rate (CER) of 0.39 to 0.68. So Chinese sentences go to a
dedicated model, `kokoro-v1.1-zh` (Apache-2.0), phonemized by [misaki](https://github.com/hexgrad/misaki)'s Chinese
G2P (jieba and pypinyin). The same check now gives a mean CER of 0.00. English words inside a Chinese sentence are
phonemized by v1.0's espeak path. Every other language still uses v1.0.

- The script of each sentence picks the model, as it picked the voice before. A Chinese voice id, an English voice
  id with Chinese text, or `language: "zh"` all end up on `kokoro-v1.1-zh`.
- `/v1/audio/voices` lists the v1.1-zh Chinese voices (`zf_001`, `zm_009`, ...). The default female voice is `zf_002`
  and the default male voice is `zm_009`, picked by lowest CER over the benchmark phrases. The old v1.0 Chinese ids
  (`zf_xiaobei`, `zm_yunjian`, ...) are still accepted and map to the default voice of the same gender.
- It adds a 325 MB download and a second model in memory. `SPEECH_TTS_ZH_MODEL=off` skips both and keeps the old
  v1.0 behaviour for Chinese.

### Python version

Max Speech needs Python 3.12 exactly (`>=3.12,<3.13`). misaki, the Chinese G2P, does not support Python 3.13.

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

## Custom voices

With a cloning model loaded, an admin can add a voice from 5 to 30 seconds of recorded speech and use it anywhere a
voice id is accepted: `/v1/audio/speech`, `session.update.voice` and the relay's `MAX_SPEECH_VOICE`. Custom ids look
like `v_3f9a0c12ab`. Voices live in `SPEECH_DATA_DIR/voices/<id>/` (`reference.wav` and `voice.json`, mode 0600).
Without a cloning model, `POST /v1/voices` returns `409 cloning_unavailable` and custom ids are not listed or
spoken.

`created_by` (stored with the consent record) is supplied by the client and not verified by this server. The relay or
Studio that calls `POST /v1/voices` should fill it in with the signed-in admin rather than pass through user input.

### Cloning engines

`SPEECH_CLONING_MODEL` takes a registry id, or `off`. It needs the TTS role to be on, and a model that is not marked
`cloning = true` in the registry is refused before anything downloads.

| Profile | Default model        | Engine                             | Download     | Memory (peak) | Languages                     |
| ------- | -------------------- | ---------------------------------- | ------------ | ------------- | ----------------------------- |
| `mlx`   | `qwen3-tts-0.6b-mlx` | Qwen3-TTS Base through mlx-audio   | 2.3 GB       | about 4 GB    | zh en ja ko de fr ru pt es it |
| `cpu`   | off (opt-in)         | MOSS-TTS-Nano (ONNX) and its codec | about 730 MB | about 2 GB    | 19, see the engine            |
| `cuda`  | off                  | none yet                           |              |               |                               |

On `cpu`, cloning is opt-in because of its memory cost: set `SPEECH_CLONING_MODEL=moss-tts-nano-onnx`
(Apache-2.0 code and weights). If a _default_ cloning model fails to load or warm up, the server logs a warning
and keeps running without cloning; a model you set explicitly fails loudly instead.

- `qwen3-tts-1.7b-mlx` is the larger Qwen3 model (`SPEECH_CLONING_MODEL=qwen3-tts-1.7b-mlx`); it needs more memory.
- Qwen3-TTS speaks each sentence in the language of its script (Chinese, Japanese or Korean characters) or, for
  Latin text, the voice's first language, so one voice can read mixed English and Chinese text. On an M5 Max the 0.6B
  model measured about 0.14 s to first audio and a real-time factor near 0.2.
- A cloning model may need companion models (MOSS needs an audio codec). The registry lists them under `requires`;
  they are license-checked and downloaded with it, and credited in `/.well-known/max-speech`.
- CUDA has no cloning engine yet, because none has been tested there. Set `SPEECH_CLONING_MODEL` to try one anyway.
- The `mlx` extra installs mlx-audio (MIT) and, through it, `transformers`, `safetensors` and `sentencepiece`. The
  base install on Linux is unchanged.

| Method | Path                        | Notes                                                          |
| ------ | --------------------------- | -------------------------------------------------------------- |
| GET    | `/v1/voices`                | Preset and custom voices, plus `cloning: bool`                 |
| POST   | `/v1/voices`                | Multipart upload, returns `201` (see below)                    |
| GET    | `/v1/voices/{id}`           | One voice with its consent record, or `404`                    |
| PATCH  | `/v1/voices/{id}`           | JSON `name`, `languages`, `gender`, `transcript`               |
| DELETE | `/v1/voices/{id}`           | `204`; removes the reference audio too                         |
| GET    | `/v1/voices/{id}/reference` | The stored reference WAV, to hear what was recorded            |
| POST   | `/v1/voices/{id}/preview`   | JSON `{"text"?}` (at most 300 characters), returns `audio/wav` |
| GET    | `/v1/lexicon`, PUT          | Read or replace the whole pronunciation lexicon                |

`POST /v1/voices` fields: `audio` (file, up to 25 MB), `name` (at most 64 characters), `transcript` (optional, at most
1000; a blank one is transcribed by the speech recognizer, or `400 transcript_required` if there is none), `languages`
(comma list), `gender` (`female`, `male` or `neutral`), `created_by`, and the consent fields below. The recording is
trimmed, resampled to 24 kHz and normalised. It is refused with `reference_too_short`, `reference_too_long`,
`reference_silent` or `reference_clipped` when it is unsuitable.

**Consent is required.** Send `consent=true`, `consent_statement` (at least 20 characters, for example "I, Ava Lee,
agree that my voice may be cloned for the Acme assistant.") and `consent_speaker` (the speaker's name). Anything else
returns `400 consent_required`. The consent record is stored with the voice and returned by `GET`. The store itself
enforces this, not only the route. Every `/v1` route needs the API key like the rest of the server.

**Lexicon.** `PUT /v1/lexicon` takes `{"entries": {"MAX": "Max", "Dr": "Doctor"}}` and applies to all speech, preset
or custom, before synthesis. Longest keys win. Latin keys match whole words, case-insensitively; keys with Chinese
characters match anywhere in the text. At most 500 entries, keys up to 64 characters, values up to 128.

## Live session (`/v1/speech/session`)

One WebSocket does both directions of a voice conversation. The server listens with a voice activity model
(Silero VAD), a streaming recognizer and an end-of-turn model (Smart Turn), and it speaks replies with Kokoro. The
client sends microphone audio and the reply text; the server sends back when the user started and stopped talking,
the transcript, and reply audio. The chat model stays on the client side.

The session needs the VAD, turn, streaming speech-to-text and text-to-speech engines. If any is `off` the server
closes the session with an `engine_disabled` error. While models load it sends `loading` and closes with 1013.
Auth is the same as `/v1`: a bearer key when `SPEECH_API_KEY` is set, otherwise loopback only. A refused connection
is closed before accept, which the client sees as HTTP 403.

### Protocol

Client to server:

| Message                                                                                                                               | Meaning                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `{"type":"session.update","languages":["zh","en"],"keyterms":[…],"voice":"af_heart","gender":"female","turn":{"eagerness":"normal"}}` | Every field is optional. Send it first; send it again to change a setting. `voice` wins over `gender`. |
| binary frame                                                                                                                          | Microphone audio: 16 kHz, mono, PCM16 little-endian, any length.                                       |
| `{"type":"speak","id":"r1","text":"…","final":false}`                                                                                 | More reply text for reply `r1`. `final: true` (text may be empty) ends `r1`.                           |
| `{"type":"cancel","id":"r1"}`                                                                                                         | Stop reply `r1` now.                                                                                   |
| `{"type":"turn.end"}`                                                                                                                 | End the user's turn now.                                                                               |

Server to client:

| Message                                                             | Meaning                                                                                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type":"ready","protocol":"max-speech.session.v1","engines":{…}}` | Sent after the first `session.update`. `engines` names the vad, turn, stt and tts models.                                                                              |
| `{"type":"speech.started"}`                                         | The user started talking. This is also the barge-in signal.                                                                                                            |
| `{"type":"transcript.partial","text":"…"}`                          | Cumulative text of this turn, sent only when it changes.                                                                                                               |
| `{"type":"transcript.final","text":"…","ms":{"turn":N,"stt":N}}`    | The turn ended. `turn` is the audio time since the speaker stopped, plus the time the turn check took; `stt` is the decision to the final text. The text may be empty. |
| `{"type":"audio.start","id":"r1","sampleRate":24000}`               | Reply `r1` starts. Binary frames of 24 kHz PCM16 follow.                                                                                                               |
| `{"type":"audio.done","id":"r1","cancelled":false}`                 | Reply `r1` ended. Every `speak` id gets exactly one `audio.done`; `cancelled` is true after `cancel`.                                                                  |
| `{"type":"error","code":"…","message":"…"}`                         | A recoverable problem, such as a bad message or an unknown voice. The session continues.                                                                               |

### Limits and errors

| Limit                                  | Value                                  | What happens                                                                         |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Text of one `speak`                    | 8 KB (UTF-8)                           | Error `speak_too_long`; that message is ignored.                                     |
| Text of one reply                      | 64 KB (UTF-8)                          | Error `reply_too_long`, then the reply is cancelled (`audio.done` with `cancelled`). |
| One WebSocket message                  | 1 MiB                                  | The connection is closed (uvicorn `ws_max_size`).                                    |
| Microphone audio waiting to be handled | about 10 s (320 KB)                    | Queued audio is dropped, the turn restarts, error `overrun`.                         |
| Reply audio the client has not taken   | about 5 s queued, or one send over 5 s | The server closes the socket with 1008 and reason `slow_reader`.                     |

When the server drops a turn that is in progress, because an engine failed, the audio overran, or `session.update`
changed the languages or keyterms, the client still gets a `transcript.final` with empty text and `ms` of 0, so a
turn that began with `speech.started` always ends.

Replies are spoken one at a time, in the order their ids first appear. A reply keeps at most two sentences queued
for synthesis and asks for the next when one finishes, so several sessions and HTTP requests share the speech engine
sentence by sentence instead of one long reply holding it. Engine work for microphone audio is cut into pieces of
at most 1 s per engine lock hold.
Binary frames from the server belong to the
reply whose `audio.start` came last. Audio sent before `ready` is kept and processed after it.

### Turn-taking

The server cuts the microphone into 512-sample frames (32 ms) and asks the VAD for a speech probability per frame.

- Speech starts when the probability is at least 0.5 for 2 frames in a row. The recognizer is given 300 ms of audio
  from before that point, and the server sends `speech.started`.
- A frame is quiet when the probability is below 0.35.
- Once quiet time reaches the pause length, Smart Turn judges the last 8 s of the utterance. If it says the turn is
  complete (0.5 or more), the turn ends. Otherwise the server keeps waiting; if speech resumes, the turn continues.
  If the speaker stays quiet until 400 ms past the pause length, Smart Turn judges again and the turn ends at 0.3 or
  more (very short phrases, such as 你好。, are scored low at first and high a moment later). If quiet time reaches
  the maximum wait, the turn ends anyway.
- An utterance with less than 200 ms of voiced frames ends with an empty `transcript.final`. One longer than 30 s is
  ended.
- `turn.end` ends the turn at once.

`turn.eagerness` sets the two quiet-time limits:

| Eagerness | Pause before the check | Maximum wait |
| --------- | ---------------------- | ------------ |
| `low`     | 400 ms                 | 2000 ms      |
| `normal`  | 200 ms                 | 1500 ms      |
| `high`    | 120 ms                 | 800 ms       |

Lower eagerness waits longer, so it interrupts slow talkers less. Higher eagerness answers sooner.

At the end of a turn the streaming recognizer is flushed and the final text is sent. If a batch speech-to-text model
is loaded and `SPEECH_SECOND_PASS` is not `off`, the utterance is also transcribed by it under a 300 ms deadline, and
its text replaces the streaming text when it arrives in time and is not empty. `auto` turns this on for the `mlx` and
`cuda` profiles and off for `cpu`. Some short Chinese phrases can still sit at the maximum wait, because
Smart Turn judges them unfinished even on the second check.

### Live session models

| Model                        | Role                     | Weights license | Default |
| ---------------------------- | ------------------------ | --------------- | ------- |
| `silero-vad-v6.2`            | Voice activity           | MIT             | yes     |
| `smart-turn-v3.2`            | End of turn              | BSD-2-Clause    | yes     |
| `x-asr-zh-en-480ms`          | Streaming speech-to-text | Apache-2.0      | yes     |
| `paraformer-zh-en-streaming` | Streaming speech-to-text | Apache-2.0      | no      |

Set `SPEECH_STREAM_STT_MODEL=paraformer-zh-en-streaming` to use the Paraformer recognizer instead of X-ASR. They run
on the CPU on every profile. The session needs a streaming model: the registry marks them with `streaming = true`,
and the server refuses any other speech-to-text id for this setting before it downloads anything.

X-ASR-zh-en's upstream card says its training data is open-source and collected data, and does not itemise it. The
weights license is Apache-2.0, which is what the registry checks, but the data provenance is unstated, so review it
before you ship the model in a product. The Paraformer conversion likewise does not state its training data.

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
   A voice-cloning model also sets `cloning = true`. A model that needs others loaded beside it lists their ids in
   `requires = [...]`; each is license-checked and downloaded too (cycles are rejected).
3. If the model needs an engine that does not exist yet, add it under `src/max_speech/engines/` and wire it into
   `engines/select.py`. The registry entry alone does not make a model runnable.

Kokoro's weights are Apache-2.0, but its phonemizer and espeak-ng are GPL-3.0 code, imported in-process by
`kokoro-onnx`. Running Max Speech as a service is fine. If you distribute an image or other bundle that includes
them, you must also offer their source under GPL-3.0. The Chinese model's G2P (misaki, jieba, pypinyin) is
Apache-2.0 and MIT.

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

The session benchmark drives `/v1/speech/session` at real-time pace:

```bash
uv run python -m bench.session --url ws://localhost:8790/v1/speech/session --runs 3 --json bench/out/session.json
```

For each built-in English and Chinese phrase it synthesizes the phrase with the server, streams it as 16 kHz audio
with 0.4 s of silence before and 1.5 s after, and reports end of speech to `transcript.final`, time to the first
partial, WER or CER, and the server's `ms.turn` and `ms.stt`. It then sends the phrase as a `speak` message and times
the first audio frame and `audio.done`. For comparison it reports the M1 pipeline equivalent: the relay's fixed
700 ms silence wait plus one `POST /v1/audio/transcriptions` of the same utterance. Options: `--api-key`, `--voice`,
`--lead`, `--trail`, `--languages`.

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
