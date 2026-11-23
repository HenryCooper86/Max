# Max Speech

Max Speech is a local speech server. It serves OpenAI-compatible speech-to-text (Whisper) and text-to-speech
(Kokoro) from models whose weights are commercially usable, so Max's `local` voice pipeline can run without a cloud
provider. It also runs a live conversation over one WebSocket, `/v1/speech/session`: voice detection, turn-taking,
streaming transcripts and spoken replies, which Max's `max-speech` backend uses.

It listens on port **8790**. The model list, licenses and hardware profiles are in
[docs/local-models.md](../docs/local-models.md).

## Deployment

[docs/speech-server-deployment.md](../docs/speech-server-deployment.md) covers running it on a Mac, in Docker and
behind a reverse proxy. On Apple silicon, double-click `start-speech.command` in the repo root. In Docker, build
`speech-server/Dockerfile` with `--target cpu` or `--target cuda` (the CUDA image is untested on a GPU); an API key is
required there. `docker-compose.local-voice.yml` runs the CPU image next to Ollama. Downloads measured on an M5 Max:
about 4.7 GB of models for the default `mlx` set, about 8.9 GB with voice design, and about 1.4 GB for the `cpu` set.

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

| Variable                             | Default                    | Meaning                                                                                                                                      |
| ------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEECH_API_KEY`                     | unset                      | Bearer token required on `/v1`. Unset means loopback only.                                                                                   |
| `SPEECH_PROFILE`                     | detected                   | `mlx`, `cuda` or `cpu`. Detected from the hardware when unset.                                                                               |
| `SPEECH_DATA_DIR`                    | `~/.max-speech`            | Where models are stored (`models/` under this directory).                                                                                    |
| `SPEECH_STT_ENGINE`                  | profile default            | `whisper-ct2`, `whisper-mlx`, or `off`.                                                                                                      |
| `SPEECH_TTS_ENGINE`                  | `kokoro`                   | `kokoro`, or `off`.                                                                                                                          |
| `SPEECH_STT_MODEL`                   | profile default            | Any speech-to-text model id in the license registry.                                                                                         |
| `SPEECH_TTS_MODEL`                   | `kokoro-v1.0`              | Any text-to-speech model id in the license registry.                                                                                         |
| `SPEECH_TTS_ZH_MODEL`                | `kokoro-v1.1-zh`           | Chinese text-to-speech model, or `off` to use v1.0 for Chinese.                                                                              |
| `SPEECH_CLONING_MODEL`               | `mlx` only                 | Voice cloning model (a registry entry with `cloning = true`), or `off`.                                                                      |
| `SPEECH_DESIGN_MODEL`                | `mlx` only                 | Voice design model (a registry entry with `design = true`), or `off`. On by default only with 24 GB of RAM or more; setting it forces it on. |
| `SPEECH_VAD_MODEL`                   | `silero-vad-v6.2`          | Voice activity model for the live session, or `off`.                                                                                         |
| `SPEECH_TURN_MODEL`                  | `smart-turn-v3.2`          | End-of-turn model for the live session, or `off`.                                                                                            |
| `SPEECH_STREAM_STT_MODEL`            | `x-asr-zh-en-480ms`        | Streaming speech-to-text for the live session (must be a streaming model), or `off`.                                                         |
| `SPEECH_SECOND_PASS`                 | `auto`                     | `on`, `off` or `auto` (on for the `mlx` and `cuda` profiles).                                                                                |
| `SPEECH_ALLOWED_ORIGINS`             | unset                      | Comma-separated browser origins allowed on WebSockets, beyond localhost.                                                                     |
| `SPEECH_MAX_SESSIONS`                | `cpu` 2, `mlx` 4, `cuda` 8 | Live sessions open at once; more are refused (see [Limits and errors](#limits-and-errors)).                                                  |
| `SPEECH_SESSION_HANDSHAKE_TIMEOUT_S` | `15`                       | Seconds a new session may take to send its first `session.update`. `0` turns the limit off.                                                  |
| `SPEECH_SESSION_IDLE_TIMEOUT_S`      | `0` (off)                  | Seconds a session may go without receiving anything from the client (audio or JSON); `0` is off. Dead clients are caught by ping instead.    |
| `SPEECH_MAX_TRANSCRIPTIONS`          | `4`                        | Transcription requests handled at once (upload, decode and wait for the engine); more get `429` with `Retry-After`.                          |
| `SPEECH_UPLOAD_TIMEOUT_S`            | `300`                      | Seconds a transcription request may take to send its body; later it gets `408 upload_timeout` and its place is freed. `0` is off.            |
| `SPEECH_LOAD_ATTEMPTS`               | `4`                        | Tries to load the models before the process gives up and exits non-zero (only download and network failures are retried).                    |
| `SPEECH_LOAD_BACKOFF_S`              | `5`                        | Wait before the second try; it doubles each time, up to 60 s.                                                                                |

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
| GET    | `/healthz`                 | `{"ok": true, "ready": bool}`; see below                |
| GET    | `/.well-known/max-speech`  | Protocol version, active engines and model attributions |
| POST   | `/v1/audio/speech`         | Text to audio (see below)                               |
| POST   | `/v1/audio/transcriptions` | Audio to text (see below)                               |
| GET    | `/v1/audio/voices`         | Voice ids, names, languages and gender                  |
| GET    | `/v1/models`               | The active model ids plus the OpenAI aliases            |
| GET    | `/v1/models/{id}`          | One model, or `404`                                     |

### Health and model loading

`/healthz` answers `200 {"ok": true, "ready": false}` while the models load, so a healthcheck with a start period
does not kill a slow first download, and `200 {"ok": true, "ready": true}` once they have. If a download or network
step fails, the server retries it (`SPEECH_LOAD_ATTEMPTS` tries, backing off from `SPEECH_LOAD_BACKOFF_S`, doubling up
to 60 s) and the last error is in the body as `"error"` meanwhile. When the tries run out, or the failure is not a
network one (a bad configuration, a missing package, a corrupt model), the body becomes
`503 {"ok": false, "ready": false, "error": "..."}` and the process exits with status 1, so Docker's
`restart: unless-stopped`, systemd or launchd start it again. Without a supervisor the server simply stops; the
error is in the log. A cloning model that fails to warm up is still the one exception: with the default cloning
model the server starts without cloning and logs why.

A model download that was interrupted and then started offline is refused, with the error that stopped the download
and how to resume (start with network access, or run `max-speech download`; partial files are kept). The server
checks the files against the revision's file list, so truncated weights are not loaded.

### Speech (`POST /v1/audio/speech`)

- `input`: required, at most 4096 characters.
- `voice`: a Kokoro voice id (for example `af_heart`), or `default`. The OpenAI names `alloy`, `nova`, `shimmer`,
  `coral`, `sage` map to a default female voice; `onyx`, `echo`, `ash`, `ballad`, `fable`, `verse` map to a default
  male voice.
- `speed`: 0.25 to 4.0, default 1.0. Kokoro supports 0.5 to 2.0, so values outside that range are clamped for Kokoro.
- `language`: optional. Kokoro speaks English, Chinese, Spanish, French, Hindi, Italian, Japanese and Portuguese.
  Japanese uses misaki's Japanese G2P with the UniDic Lite dictionary, because espeak reads kanji aloud as the words
  "Chinese letter". Pass `language: "ja"` for text written only in kanji, which otherwise reads as Chinese.
- `response_format`: `wav` (default) or `pcm`. Both are 24 kHz, mono, 16-bit. MP3, Opus, AAC and FLAC return `400`.
- `stream_format`: optional. `audio` streams raw PCM as it is produced (requires `response_format: "pcm"`). `sse`
  streams server-sent events, each carrying base64 PCM in `speech.audio.delta`, ending with `speech.audio.done`.

Responses carry an `X-Max-Speech-Engine` header naming the engine that spoke: the cloning engine for a custom voice,
otherwise the preset engine. When the client disconnects, synthesis stops.

### Transcription (`POST /v1/audio/transcriptions`)

Multipart form with a `file` field: WAV, FLAC or OGG, up to 25 MB and 15 minutes long. Optional `language` and
`prompt`. `response_format` is `json` (default), `text` or `verbose_json` (adds language, duration and segments).
`model` and `temperature` are accepted for SDK compatibility and ignored: the active model serves every name.
The language can be any of Whisper's ISO 639-1 codes; this path is not limited to Chinese and English.

At most `SPEECH_MAX_TRANSCRIPTIONS` (default 4) requests are in progress at once, counted from the upload to the
response, because each holds the file (up to 25 MB) and its decoded audio (up to about 110 MB for 15 minutes of 48 kHz
stereo). Another one gets `429` with `Retry-After: 2` and error code `too_many_requests` before any of its body is
read; retry after a moment. A request that ends in any way (answered, failed, or the client disconnected mid-upload)
frees its place, and one whose body has not fully arrived after `SPEECH_UPLOAD_TIMEOUT_S` (300 s: the largest upload
at about 0.7 Mbit/s) gets `408 upload_timeout`, so slow uploads cannot hold every place. At most two files are decoded
at the same time. A client that disconnects while its audio is being transcribed stops the transcription at the next
30 s window (`mlx` profile), which frees the GPU and its place.

Request bodies other than uploads are limited to 256 KB (`413 request_too_large`): `POST /v1/voices/design`,
`PATCH /v1/voices/{id}`, `POST /v1/audio/speech` and the rest of the JSON endpoints. `PUT /v1/lexicon` is allowed
1,172,096 bytes, the largest body a valid lexicon can take: 500 entries at the key and value limits, every character
written the longest way JSON allows (12 bytes for a character outside the BMP as a `\uXXXX\uXXXX` pair), plus 32
bytes per entry for punctuation and indentation. A full lexicon in Chinese is about 282 KB as UTF-8 and 560 KB
escaped.

**Long transcriptions and live speech** (`mlx` profile). A long upload is transcribed in 30 s windows with the GPU
handed to live work between them, so it never holds up a rider's speech for more than one window; see
[MLX evaluation](#mlx-evaluation-live-work-first). The transcript is the same: the windows are the ones mlx-whisper
uses anyway, and nothing in between changes them.

## Custom voices

With a cloning model loaded, an admin can add a voice from 5 to 30 seconds of recorded speech and use it anywhere a
voice id is accepted: `/v1/audio/speech`, `session.update.voice` and the relay's `MAX_SPEECH_VOICE`. Custom ids look
like `v_3f9a0c12ab`. Voices live in `SPEECH_DATA_DIR/voices/<id>/` (`reference.wav` and `voice.json`, mode 0600).
Without a cloning model, `POST /v1/voices` returns `409 cloning_unavailable` and custom ids are not listed or
spoken.

`created_by` (stored with the consent record) is supplied by the client and not verified by this server. The relay or
Studio that calls `POST /v1/voices` should fill it in with the signed-in admin rather than pass through user input.

### What the consent record does and does not prove

Besides the statement and the speaker's name, the stored record (`voice.json`, `consent`) carries what the server
itself observed: `recorded_at` (UTC time), `audio_sha256` (SHA-256 of the stored `reference.wav`), `upload_sha256`
(SHA-256 of the file as uploaded), `client` (the peer address; proxy headers are not trusted, so behind a reverse
proxy this is the proxy) and `auth` (`api_key` or `loopback`). With an API key it also has `key_id`, the first 12 hex
characters of the key's SHA-256, which tells keys apart after a rotation. Creating and deleting a voice, designed
voices included, append a JSON line to `SPEECH_DATA_DIR/voice-audit.log` (mode 0600) with the time, event, voice id,
name, speaker, audio hash and the same caller fields. An audit-log write failure is logged and does not undo the
change.

What it proves: that this recording, byte for byte, was stored by a caller holding the key (or on loopback) at that
time, together with a statement that caller supplied. What it does not prove: that the speaker said, heard or agreed
to anything. The statement and speaker name are free text typed by the caller, there is one shared API key and no
user identity (`created_by` is self-declared), and the audio is not checked against the statement. There is no
spoken challenge. The log is an ordinary file the operator can edit; ship it somewhere append-only if you need it to
stand as evidence.

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

| Method | Path                        | Notes                                                             |
| ------ | --------------------------- | ----------------------------------------------------------------- |
| GET    | `/v1/voices`                | Preset and custom voices, plus `cloning: bool` and `design: bool` |
| POST   | `/v1/voices`                | Multipart upload, returns `201` (see below)                       |
| GET    | `/v1/voices/{id}`           | One voice with its consent record, or `404`                       |
| PATCH  | `/v1/voices/{id}`           | JSON `name`, `languages`, `gender`, `transcript`                  |
| DELETE | `/v1/voices/{id}`           | `204`; removes the reference audio too                            |
| GET    | `/v1/voices/{id}/reference` | The stored reference WAV, to hear what was recorded               |
| POST   | `/v1/voices/{id}/preview`   | JSON `{"text"?}` (at most 300 characters), returns `audio/wav`    |
| GET    | `/v1/lexicon`, PUT          | Read or replace the whole pronunciation lexicon                   |

`POST /v1/voices` fields: `audio` (file, up to 25 MB), `name` (at most 64 characters), `transcript` (optional, at most
1000; a blank one is transcribed by the speech recognizer, or `400 transcript_required` if there is none), `languages`
(comma list), `gender` (`female`, `male` or `neutral`), `created_by`, and the consent fields below. The recording is
trimmed, resampled to 24 kHz and normalised. It is refused with `reference_too_short`, `reference_too_long`,
`reference_silent` or `reference_clipped` when it is unsuitable.

**Consent is required.** Send `consent=true`, `consent_statement` (at least 20 characters, for example "I, Ava Lee,
agree that my voice may be cloned for the Acme assistant.") and `consent_speaker` (the speaker's name). Anything else
returns `400 consent_required`. The consent record is stored with the voice and returned by `GET`. The store itself
enforces this, not only the route. Every `/v1` route needs the API key like the rest of the server.

Every custom voice has an `origin`: `recorded` (the consent record above) or `designed` (see below; it carries a
`design` record instead of consent). `POST /v1/voices` only ever makes recorded voices, whatever fields it is sent.

### Designing a voice

An admin can also describe a voice in words ("a deep, low-pitched older male voice") instead of recording one. This
uses `qwen3-tts-1.7b-voicedesign-mlx` (Qwen3-TTS VoiceDesign, Apache-2.0, English and Chinese) on the `mlx` profile.
Nothing about a real person is cloned, so a designed voice has no consent record.

How it works: the model speaks a fixed sample sentence in a voice that fits the description. Design on its own drifts
from one sentence to the next, so a designed voice is never spoken by the design model. You audition candidates, save
one, and the saved sample becomes the reference audio (and the sample text its transcript) of an ordinary custom
voice that the cloning engine then speaks. Measured on an M5 Max, a cloned designed sample kept the voice (speaker
similarity 0.72 to 0.82, against 0.27 for design alone).

| Method | Path                            | Notes                                                                                                                                                                              |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/voices/design`             | JSON `{description (at most 300), text? (at most 300), language?, count? (1 to 3, default 3), created_by?}` returns `{candidates:[{id, text, description, language, expires_at}]}` |
| GET    | `/v1/voices/design/{cid}/audio` | The candidate as `audio/wav`, or `404`                                                                                                                                             |
| POST   | `/v1/voices/design/{cid}/save`  | JSON `{name, gender?, languages?, created_by?}` returns `201` and the new custom voice                                                                                             |

- `text` defaults to a fixed sentence in the language (`en` or `zh`), which comes from `language`, else from the script
  of `text` or the description. Each candidate uses a different random seed; the seed is stored in the voice's `design`
  record (`description`, `seed`, `model`, `text`), and the same seed, text and description give the same audio.
- Candidates live in memory only: 15 minutes each, at most 30 per server (the oldest is dropped first). A restart
  forgets them. Candidate ids look like `c_3f9a0c12ab45`.
- Generation takes no speech lock. It is batch work on the GPU, streamed in chunks of 0.5 s of audio (about 0.2 s of
  work each), and live speech gets the GPU between two chunks, so a rider waits for one chunk at most; a preset voice
  never waits for it. One design request runs at a time and one more waits its turn (on the event loop, not in a
  worker thread); a third gets `429 too_many_requests` with `Retry-After`. A request whose client disconnects stops at
  its next chunk. The streamed audio is the non-streamed audio up to float rounding (same seed, same samples to
  within -64 dB). It runs at a real-time factor near 0.3 on an idle server and slows down while riders are talking.
- Memory: the model is 4.5 GB on disk and peaks near 8.6 GB while generating. It is downloaded at startup (and by
  `max-speech download`) but loaded into memory only on the first design request, and unloaded after 10 idle minutes.
  Memory use of the rest of the server is unchanged until then.
- Design needs cloning. If cloning is off or failed to load, design is off (the server logs why), and the routes
  return `409 design_unavailable`. A default design model that fails to download is skipped with a warning; one set
  through `SPEECH_DESIGN_MODEL` fails loudly. `features.voice_design` in `/.well-known/max-speech` reports it.
- **Saving consumes the candidate.** A second save of the same candidate (or of an expired one) returns
  `404 candidate_not_found`, so a double click cannot make two voices. If a save fails, the candidate is kept for a
  retry. Its audio route is `404` after a save too.
- **Sample length.** A saved reference must be at least 3 s of speech. The default sample sentences give 4.9 to 6.1 s
  (English) and 4.3 to 7.3 s (Chinese) on the real model. A `text` of your own must have at least 25 characters (12
  Han characters for Chinese), otherwise `400 sample_text_too_short` at design time.
- **Loading.** The first design request loads the model: one unit of setup that includes the 651 MB speech tokenizer
  (0.16-0.18 s on an M5 Max with the files cached; that step is inside mlx-audio and not split), then the other weights
  in pieces of 256 MB (0.04 s each), letting live speech use the GPU between pieces. Unloading after 10 idle minutes
  frees the memory with the gate held.
- **Memory default.** On the `mlx` profile design is on by default only with at least 24 GB of RAM (the server logs why
  it is off otherwise). `SPEECH_DESIGN_MODEL=qwen3-tts-1.7b-voicedesign-mlx` forces it on.
- **Real people.** A description that asks for a particular person's voice is refused with `400 design_refused`.
  The check is best effort, not a safeguard. It refuses: capitalised names after "like" or "as" ("like Morgan
  Freeman", "speak as Taylor Swift"), "the voice of Name", "Name's voice", "Name Surname voice"; the verbs imitate,
  impersonate, mimic, clone, "in the style of", and "sound(s) like" followed by anything but a generic article
  ("sounds like my boss"); and in Chinese 模仿, 冒充, 仿照, 克隆, 听起来像/像/学 followed by a 2 to 4 character name,
  and "名字的声音" ("雷军的声音"). It allows generic descriptors ("a young woman's voice", "the voice of a cheerful
  young girl", "a deep voice from the south", "像老人一样说话"). Names are told from descriptions by capitalisation
  (English) and by a word list of common descriptive words (Chinese), so it misses lower-case or unusual names and
  can wrongly refuse a capitalised word or an adjective it does not know. A determined user can phrase around it.
  Treat designed voices that resemble someone as that person's likeness and do not use them to deceive.
- **Error codes** of the design routes: `design_unavailable` (409 when design is off; 503 when the model could not
  be loaded), `design_refused` (400), `candidate_not_found` (404), `sample_text_too_short` (400). Bad fields use the
  usual `invalid_field` and `invalid_language`.

**Lexicon.** `PUT /v1/lexicon` takes `{"entries": {"MAX": "Max", "Dr": "Doctor"}}` and applies to all speech, preset
or custom, before synthesis. Longest keys win. Latin keys match whole words, case-insensitively; keys with Chinese
characters match anywhere in the text. At most 500 entries, keys up to 64 characters, values up to 128.

## Live session (`/v1/speech/session`)

One WebSocket does both directions of a voice conversation. The server listens with a voice activity model
(Silero VAD), a streaming recognizer and an end-of-turn model (Smart Turn), and it speaks replies with Kokoro. The
client sends microphone audio and the reply text; the server sends back when the user started and stopped talking,
the transcript, and reply audio. The chat model stays on the client side.

**Languages.** The live recognizer is a Chinese and English model (both `x-asr-zh-en-480ms` and
`paraformer-zh-en-streaming`): it transcribes `zh` and `en` and nothing else, whatever `languages` says. Its
`languages` are published in `ready` and in `/.well-known/max-speech` (`live.languages`). Another language works only
through the second pass, where Whisper re-transcribes each finished turn (on by default for `mlx` and `cuda`, off for
`cpu`, see `SPEECH_SECOND_PASS`); that is best effort within the second pass's 300 ms deadline, and the live partials
stay wrong. When a session asks for a language the recognizer cannot do and the second pass is off, the server sends a
`warning` (`language_unsupported`). The recognizer does not support `keyterms` either (sherpa-onnx hotwords need
modified beam search and a BPE vocabulary file that the model does not ship), so `ready` has `keyterms: false` and a
request that sends them gets a `keyterms_unsupported` warning. `languages` is matched by primary tag (`zh-CN` is
`zh`); a code Whisper does not know is dropped with a `language_unknown` warning.

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

| Message                                                                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type":"ready","protocol":"max-speech.session.v1","engines":{…}}`           | Sent after the first `session.update`. `engines` names the vad, turn, stt and tts models. `idle_timeout_s` is `null` unless the server closes quiet sessions (then the seconds). It also has `languages` (what the streaming recognizer transcribes) and `keyterms` (whether it uses them) when the recognizer says so.                                                                                             |
| `{"type":"speech.started"}`                                                   | The user started talking. This is also the barge-in signal.                                                                                                                                                                                                                                                                                                                                                         |
| `{"type":"transcript.partial","text":"…"}`                                    | Cumulative text of this turn, sent only when it changes.                                                                                                                                                                                                                                                                                                                                                            |
| `{"type":"transcript.final","text":"…","ms":{"turn":N,"stt":N},"reason":"…"}` | The turn ended. `turn` is the audio time since the speaker stopped, plus the time the turn check took; `stt` is the decision to the final text. The text may be empty. `reason` says why the turn ended: `turn` (the speaker was done), `max_wait` (a pause too long to wait out), `max_length` (30 s), `forced` (`turn.end`), `blip` (a sound too short to be speech: the text is empty) or `dropped` (see below). |
| `{"type":"audio.start","id":"r1","sampleRate":24000}`                         | Reply `r1` starts. Binary frames of 24 kHz PCM16 follow.                                                                                                                                                                                                                                                                                                                                                            |
| `{"type":"audio.done","id":"r1","cancelled":false}`                           | Reply `r1` ended. Every `speak` id gets exactly one `audio.done`; `cancelled` is true after `cancel`.                                                                                                                                                                                                                                                                                                               |
| `{"type":"error","code":"…","message":"…"}`                                   | A recoverable problem, such as a bad message or an unknown voice. The session continues. An error about one reply (`speak_too_long`, `reply_too_long`, `bad_speak`, `unknown_voice`, `tts_failed`, `speak_failed`, or a `bad_message` for a `speak`) also has `"id":"r1"`, so a client can report a failing reply once.                                                                                             |
| `{"type":"warning","code":"…","message":"…"}`                                 | Not an error: the session works, but not quite as asked. `language_unsupported` (with `languages` and `supported`), `language_unknown` and `keyterms_unsupported`. Sent once per distinct request.                                                                                                                                                                                                                  |

### Limits and errors

| Limit                                  | Value                                              | What happens                                                                              |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Text of one `speak`                    | 8 KB (UTF-8)                                       | Error `speak_too_long`; that message is ignored.                                          |
| Text of one reply                      | 64 KB (UTF-8)                                      | Error `reply_too_long`, then the reply is cancelled (`audio.done` with `cancelled`).      |
| One WebSocket message                  | 1 MiB                                              | The connection is closed (uvicorn `ws_max_size`).                                         |
| Microphone audio waiting to be handled | about 10 s (320 KB)                                | Queued audio is dropped, the turn restarts, error `overrun`.                              |
| Reply audio the client has not taken   | about 5 s queued, or one send over 5 s             | The server closes the socket with 1008 and reason `slow_reader`.                          |
| Live sessions at once                  | `SPEECH_MAX_SESSIONS` (`cpu` 2, `mlx` 4, `cuda` 8) | The new session gets error `busy` and is closed with 1013 and reason `busy`. Retry later. |
| Time to the first `session.update`     | `SPEECH_SESSION_HANDSHAKE_TIMEOUT_S` (15 s)        | Error `handshake_timeout`, closed with 1008.                                              |
| Time with nothing received             | `SPEECH_SESSION_IDLE_TIMEOUT_S` (off)              | Only when set: error `idle_timeout`, closed with 1000. Audio, JSON or `turn.end` count.   |
| Client that stops answering pings      | ping every 20 s, pong within 20 s (fixed)          | The connection is closed (1011) and its session slot freed, within 40 s.                  |

Close code 1013 means "try again later" for both `busy` and `loading`; the error message sent just before it says
which. The relay turns each into its own message.

The idle timeout is off by default because a quiet session is normal: the relay stops sending audio while the rider
is muted, and closing that session (and, with the server full, refusing its reconnects with `busy`) ended rides. A
client that is really gone is caught by the WebSocket ping instead (uvicorn's `ws_ping_interval` and
`ws_ping_timeout`, 20 s each, set in `cli.py`): measured on the real server, a client that stopped answering freed
its slot after 40 s, and a muted client that sent nothing for 70 s was still served. `/.well-known/max-speech`
publishes the setting as `live.idle_timeout_s` (`null` when off).

When the server drops a turn that is in progress, because an engine failed, the audio overran, or `session.update`
changed the languages or keyterms, the client still gets a `transcript.final` with empty text, `ms` of 0 and
`"reason":"dropped"`, so a turn that began with `speech.started` always ends.

Replies are spoken one at a time, in the order their ids first appear. A reply keeps at most two sentences queued
for synthesis and asks for the next when one finishes, so several sessions and HTTP requests share the speech engine
sentence by sentence instead of one long reply holding it. Preset voices (Kokoro) and custom voices (the cloning
engine) are different engines with separate locks, so a preset sentence never queues behind a cloned one. Engine work for microphone audio is cut into pieces of
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
- An utterance with less than 200 ms of voiced frames ends with an empty `transcript.final` (`"reason":"blip"`). One longer than 30 s is
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
its text replaces the streaming text when it arrives in time and is not empty. A second pass that misses the deadline
is cancelled (its text would be dropped), which frees the GPU and Whisper for the next turn. `auto` turns this on for the `mlx` and
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

On the `mlx` profile, `tests/test_mlx_gate_real.py` runs transcription and synthesis at the same time on the real
models (it needs the Whisper and Qwen3-TTS cloning models in the cache; it skips otherwise).

### MLX evaluation: live work first

mlx-whisper and the Qwen3 cloning and design engines are separate engines on separate locks, so a second-pass
transcription could encode Metal work while a custom voice was being synthesised, which not every MLX release
survives. `engines/mlx_gate.py` keeps one process-wide gate: only one thread runs MLX work at a time. The `cpu` and
`cuda` profiles never take it, and Kokoro and the streaming recognizer are ONNX and never wait for it, so preset voices
and live partials are unaffected by anything on the GPU.

The gate has two lanes. Live work (a session's cloned sentence or second pass, `/v1/audio/speech`, a voice preview:
anything that holds a speech lock, because a live sentence queued behind that lock cannot ask the gate for priority)
is realtime; uploads to `/v1/audio/transcriptions`, voice design and voice-reference transcripts are batch, each
request with its own ticket that is abandoned when its client disconnects. Batch work is
cut into units and hands the gate to a waiting live call between two units: mlx-whisper before each 30 s window it
decodes, voice design between streamed chunks, a design-model load between 256 MB pieces of weights. After a live unit
ends, batch work also stays off the gate for 0.15 s, so a cloned sentence keeps the GPU from its first chunk to its
last. A live call therefore waits for at most one batch unit; on an M5 Max the longest is a Whisper window, 0.65 s
(0.24 s on average), then a design chunk, 0.19 s, and the design model's setup unit, 0.18 s. Batch work runs in the
gaps and is slower while riders talk; it is not refused, and it cannot be starved: a batch waiter that has waited 2 s
becomes due and takes the next free moment for one unit, ahead of live waiters, so batch work gets at least one unit
every 2 s and live work waits for at most that one unit. The 2 s count from when batch work last ran, and nothing
becomes due while batch work holds the gate, so two batch calls (a transcription and a design) cannot hand the gate
to each other while live work waits. Waiters of each lane are served first come, first served, and
a batch call yields to other batch waiters at its yield points too.

Speech in a cloned voice holds the cloning engine one sentence at a time (`/v1/audio/speech` and previews make one job
per sentence, at most two queued; a session's reply does the same), so a long request does not keep other sessions'
cloned speech waiting; the audio is the same as one synthesis of the whole input. A session that closes while its sentence waits for the gate gives up its place at once.

Lock order: an engine's asyncio lock (on the event loop), then the design engine's own lock, then the gate (in a worker
thread). A thread holding the gate never waits for anything else. A cloned synthesis is advanced on one thread for its
whole length (MLX keeps GPU streams per thread), and mlx-whisper interleaving with live calls leaves its transcript
unchanged: a 15-minute upload gave the same text and segments alone and with 18 cloned sentences spoken between its
windows.

Measured on an M5 Max with a 15-minute upload in flight (895 s of speech, 8.5 s to transcribe), time from `speak` to
the first audio of a sentence in another session:

| Voice                  | Idle   | Before (one lock for the whole upload) | Now         |
| ---------------------- | ------ | -------------------------------------- | ----------- |
| Custom (cloned)        | 0.17 s | 6.7 s                                  | 0.16-0.42 s |
| Preset, beside a clone | 0.27 s | 8.1-8.4 s                              | 0.26-0.77 s |

Most preset sentences matched idle (0.26-0.31 s); the slower ones took no lock and waited for no GPU time, only for
CPU. The session's second pass also runs during the upload now (before, a busy Whisper made it fall back to the
streaming text).
