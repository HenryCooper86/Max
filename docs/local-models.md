# Running on local, open-weight models

The relay can run the whole voice loop on your own hardware. Three backends do it:

| `VOICE_PROVIDER` | What it is                                                                                                    | Turn on with           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `local`          | A cascade: speech-to-text → chat model → text-to-speech, each an OpenAI-compatible HTTP server you run        | `LOCAL_VOICE=on`       |
| `local-realtime` | One self-hosted server that speaks the OpenAI Realtime WebSocket protocol in front of open-weight models      | `LOCAL_REALTIME_URL=…` |
| `max-speech`     | Max Speech (below) for listening, turn-taking and speaking over one WebSocket; the relay keeps the chat model | `MAX_SPEECH=on`        |

Both use the same session core as the cloud backends, so the wake word, device actions, navigation speech, the
equaliser and the design templates behave identically.

## Max Speech: our own speech server

[Max Speech](../speech-server/README.md) is a speech server in this repo, on port 8790. It serves Whisper
transcription and Kokoro speech, and it can run the whole listening side of a conversation. On a Mac, double-click
`start-speech.command`; elsewhere use Docker. [Deploying Max Speech](speech-server-deployment.md) covers both, NVIDIA
and a reverse proxy. There are two ways to use it. Chat stays on Ollama in both, set with the `LOCAL_*` variables
(default `http://localhost:11434/v1`).

### As the speech stages of the `local` pipeline

Point the `local` backend's speech stages at the OpenAI-compatible endpoints:

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
LOCAL_STT_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_FORMAT=pcm
```

The relay detects the end of the wearer's turn itself, with its energy-based detector and a fixed 700 ms wait, then
sends the utterance to `/v1/audio/transcriptions`. It asks for one sentence of speech per request, so each sentence is
synthesised and returned whole; it does not use `stream_format`.

### As the `max-speech` backend

The server hears the wearer itself: voice detection, turn-taking, streaming transcription and spoken replies run over
a single WebSocket (`/v1/speech/session`). The relay keeps the chat model, so the model, tools and persona work as in
the `local` backend.

```dotenv
VOICE_PROVIDER=max-speech
MAX_SPEECH=on
# optional
MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session   # http(s)://host:port also works
MAX_SPEECH_API_KEY=            # the server's SPEECH_API_KEY, if it has one
MAX_SPEECH_VOICE=af_heart      # a Kokoro preset or a custom voice id
```

The server decides when the wearer has finished, so replies start sooner than with the energy-based detector, and
talking over the assistant stops it at once. If the server is down or still loading its models, the session says so
when it starts. The protocol, turn-taking rules and the session benchmark are in the
[Max Speech README](../speech-server/README.md#live-session-v1speechsession).

### What it does

- Text-to-speech with Kokoro preset voices, in English, Chinese and six more languages (Spanish, French, Hindi,
  Italian, Japanese, Portuguese). Chinese is spoken by Kokoro v1.1-zh with misaki's Chinese G2P, which cut the
  character error rate on a speak-then-transcribe check from about 0.4-0.7 to under 0.05; other languages use v1.0.
  `SPEECH_TTS_ZH_MODEL=off` turns the Chinese model off. Max Speech needs Python 3.12 because misaki does not support 3.13.
- Transcription with Whisper, and live partial transcripts while the wearer speaks (streaming X-ASR, Chinese and
  English).
- Turn detection on the server: Silero VAD and Smart Turn, with a `low`, `normal` or `high` eagerness.
- Only loads models whose licenses are on its allowlist, and pins each model to a fixed revision.

- Voice cloning with consent: an admin adds a voice from 5 to 30 seconds of recorded speech. On by default on Apple
  silicon; on a CPU it is opt-in with `SPEECH_CLONING_MODEL=moss-tts-nano-onnx`; there is none on NVIDIA yet.
- Voice design: describe a voice and pick one of three candidates. Apple silicon with at least 24 GB of memory.
- A **Voices** section in the relay's admin Studio to hear voices, clone or design one, choose the assistant's voice
  (`voice.id` in the assistant config, which overrides `MAX_SPEECH_VOICE`) and edit pronunciations. The relay proxies
  it, so the browser never sees the speech server's address or key; it needs `MAX_SPEECH=on` or `MAX_SPEECH_URL`.

Details, limits and the consent rules are in the [Max Speech README](../speech-server/README.md#custom-voices). The
design is in [docs/superpowers/specs/2026-11-20-max-speech-server-design.md](superpowers/specs/2026-11-20-max-speech-server-design.md).

## Quick start

### With Docker: Max Speech and Ollama

```bash
echo "SPEECH_API_KEY=$(openssl rand -hex 24)" >> .env
docker compose -f docker-compose.local-voice.yml up -d --build
docker compose -f docker-compose.local-voice.yml exec ollama ollama pull qwen2.5:7b
```

This builds the CPU image of Max Speech on `127.0.0.1:8790` and starts Ollama on `127.0.0.1:11434` (both bound to
loopback; Ollama has no authentication). The API key is required in Docker. The first start downloads about 1.5 GB of
speech models, and `max-speech` shows "starting" until they load. Then point the relay at it, in one of two ways
depending on where the relay runs.

**Relay on the host:** use `localhost`. Ollama at `localhost:11434` is the default chat endpoint.

```dotenv
VOICE_PROVIDER=max-speech
MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session
MAX_SPEECH_API_KEY=<the same value as SPEECH_API_KEY>
```

or, with the `local` pipeline, `LOCAL_VOICE=on`, `LOCAL_TTS_FORMAT=pcm`, `LOCAL_STT_BASE_URL` and `LOCAL_TTS_BASE_URL` set to
`http://localhost:8790/v1`, and `LOCAL_STT_API_KEY` and `LOCAL_TTS_API_KEY` set to the same value as `SPEECH_API_KEY`.

**Relay in the compose network:** use the service names, and point the chat stage at Ollama, because its default
(`localhost:11434`) would be the relay's own container:

```dotenv
LOCAL_LLM_BASE_URL=http://ollama:11434/v1
LOCAL_LLM_MODEL=qwen2.5:7b
LOCAL_LLM_API_KEY=ollama   # any value; the local pipeline needs a key on every stage that is not localhost

VOICE_PROVIDER=max-speech
MAX_SPEECH_URL=ws://max-speech:8790/v1/speech/session
MAX_SPEECH_API_KEY=<the same value as SPEECH_API_KEY>
```

or for the `local` pipeline:

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
LOCAL_STT_BASE_URL=http://max-speech:8790/v1
LOCAL_TTS_BASE_URL=http://max-speech:8790/v1
LOCAL_TTS_FORMAT=pcm
LOCAL_STT_API_KEY=<the same value as SPEECH_API_KEY>
LOCAL_TTS_API_KEY=<the same value as SPEECH_API_KEY>
LOCAL_LLM_BASE_URL=http://ollama:11434/v1
LOCAL_LLM_MODEL=qwen2.5:7b
LOCAL_LLM_API_KEY=ollama
```

(`LOCAL_API_KEY` sets all three stages' keys at once, but then Ollama also receives the speech key.) Docker on a Mac has
no Metal, so the container runs on the CPU there; on Apple silicon prefer the native path below. For NVIDIA see
[Deploying Max Speech](speech-server-deployment.md#docker-nvidia). A relay in Docker cannot use a native keyless Max
Speech via `host.docker.internal`; see the [deployment guide](speech-server-deployment.md#troubleshooting).

### On a Mac, natively

Double-click `start-speech.command` in the repo root (it needs [uv](https://docs.astral.sh/uv/)). It starts Max Speech
on `http://localhost:8790` with the MLX models, cloning and (with 24 GB or more) voice design. Without an API key it
answers loopback clients only. Run Ollama yourself (`ollama pull qwen2.5:7b`), then use `VOICE_PROVIDER=max-speech`
with `MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session`, or the `local` settings above with `localhost`.

## The `local` pipeline

Each stage is independent. Point any of them at a different server or model. The defaults below are the ports of the
third-party servers listed later; with Max Speech you set the speech stages to `http://localhost:8790/v1` as above.

| Stage          | Variables                                                    | Default                                                    |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Speech-to-text | `LOCAL_STT_BASE_URL`, `LOCAL_STT_MODEL`                      | `http://localhost:8000/v1`, `Systran/faster-whisper-small` |
| Chat model     | `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`                      | `http://localhost:11434/v1`, `qwen2.5:7b`                  |
| Text-to-speech | `LOCAL_TTS_BASE_URL`, `LOCAL_TTS_MODEL`                      | `http://localhost:8880/v1`, `kokoro`                       |
| Voices         | `LOCAL_TTS_VOICE`, `LOCAL_TTS_VOICE_MALE`                    | `af_heart`, `am_michael`                                   |
| Speech format  | `LOCAL_TTS_FORMAT` (`wav` or `pcm`), `LOCAL_TTS_SAMPLE_RATE` | `wav`                                                      |

`LOCAL_BASE_URL` sets all three stages at once (a single gateway such as LocalAI). `LOCAL_API_KEY` or
`LOCAL_<STAGE>_API_KEY` adds a bearer token for servers that want one.

What each stage needs from its server:

- **Speech-to-text** — `POST /audio/transcriptions` (multipart `file`, `model`), JSON `{ "text": … }` back.
- **Chat model** — `POST /chat/completions` with `stream: true` (server-sent events).
- **Text-to-speech** — `POST /audio/speech` returning either a WAV file or raw 16-bit mono PCM. WAV is read at
  whatever sample rate, channel count (mono or stereo) and sample type (16-bit integer or 32-bit float) the server
  produces. Raw PCM is assumed to be 24 kHz unless `LOCAL_TTS_SAMPLE_RATE` says otherwise. MP3 and Opus are not
  decoded.

### Models and servers people commonly use

Anything that exposes the endpoints above works; none of these is required. They are alternatives to Max Speech, and
the `local` pipeline works with any of them.

| Stage          | Open-weight models                                                                                       | Servers with an OpenAI-compatible API                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Speech-to-text | Whisper (large-v3, large-v3-turbo, small), Distil-Whisper, Parakeet, SenseVoice, MOSS-Transcribe-Diarize | Speaches, whisper.cpp server, LocalAI, SGLang Omni, vLLM                                                             |
| Chat model     | Qwen, Llama, Gemma, Mistral, DeepSeek, Phi                                                               | Ollama, llama.cpp server, vLLM, LM Studio, LocalAI                                                                   |
| Text-to-speech | Kokoro, Piper, XTTS-v2, CosyVoice, F5-TTS, Chatterbox, Orpheus, MOSS-TTS-Nano                            | Kokoro-FastAPI, openedai-speech, Speaches, LocalAI, [our MOSS-TTS-Nano adapter](../examples/moss-tts-nano/README.md) |

Pick the chat model for your languages and hardware: it is the stage that decides how the assistant sounds in
conversation and most of the response time. A model in the 7–8 B range answers comfortably on a recent laptop GPU;
smaller ones suit a single-board computer.

### OpenMOSS models

[OpenMOSS](https://github.com/OpenMOSS) publishes open speech models that fit two of the three stages.

**Speech-to-text: MOSS-Transcribe-Diarize** (0.9B, Apache-2.0, 50+ languages). Serve it with SGLang Omni or vLLM, which
both give it the OpenAI transcription endpoint. It needs an NVIDIA GPU (CUDA 12 or 13); on a Mac, keep Whisper.

```bash
vllm serve OpenMOSS-Team/MOSS-Transcribe-Diarize --trust-remote-code --port 8000
```

```bash
LOCAL_STT_BASE_URL=http://localhost:8000/v1
LOCAL_STT_MODEL=OpenMOSS-Team/MOSS-Transcribe-Diarize
```

It labels speakers and times (`[0.52][S01]Where is my order?[1.87]`); the relay keeps only the words.

**Text-to-speech: MOSS-TTS-Nano** (0.1B, Apache-2.0, about 20 languages, voice cloning). It runs on a CPU. Its own
server has no OpenAI-style endpoint, so use [the adapter in examples/moss-tts-nano](../examples/moss-tts-nano/README.md):

```bash
LOCAL_TTS_BASE_URL=http://localhost:8890/v1
LOCAL_TTS_MODEL=moss-tts-nano
LOCAL_TTS_VOICE=Junhao
LOCAL_TTS_FORMAT=wav
```

**Not yet usable as a backend.** MOSS-Speech (speech-to-speech on Qwen3-8B) ships only a Gradio demo, without streaming
or an API. MOSS-Live (full-duplex, with tools) is offered as a hosted realtime API whose protocol is not published in its
repository. Either can become a backend once it has a documented streaming interface.

### What to expect

The `local` pipeline transcribes the wearer's whole sentence before the model starts, so replies begin later than with a
live speech-to-speech backend. Speech is synthesised sentence by sentence as the model writes, and barge-in stops
generation and playback at once. Turn-taking is done in the relay by an energy-based voice detector.

## The `local-realtime` backend

For a self-hosted server that implements the OpenAI Realtime protocol (Speaches and LocalAI both offer one):

```dotenv
VOICE_PROVIDER=local-realtime
LOCAL_REALTIME_URL=ws://localhost:8000/v1/realtime
LOCAL_REALTIME_MODEL=qwen2.5:7b
# optional
LOCAL_REALTIME_TRANSCRIBE_MODEL=Systran/faster-whisper-small
LOCAL_REALTIME_VOICE=af_heart
LOCAL_REALTIME_VOICE_MALE=am_michael
LOCAL_REALTIME_API_KEY=
```

The relay sends the original, flat `session.update` shape (`input_audio_format: "pcm16"`,
`input_audio_transcription`, `turn_detection`), which is what these servers implement, and understands both
generations of event names on the way back.

## Status

- The pipeline and its WAV handling are covered by tests against scripted servers. It has not yet been run against
  live instances of the servers named above; expect to adjust a model name or voice id for your installation.
- `local-realtime` is written to the published protocol and is untested against a real server.
- Native speech-to-speech models with their own protocols (Moshi, Ultravox, MiniCPM-o, Qwen-Omni) are not supported
  directly. They work today only through a server that exposes one of the two interfaces above. A new one is added
  by implementing `VoiceEngine` (`server/providers/live/engine.ts`).
