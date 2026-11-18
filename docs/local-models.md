# Running on local, open-weight models

The relay can run the whole voice loop on your own hardware. Two backends do it:

| `VOICE_PROVIDER` | What it is                                                                                               | Turn on with           |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| `local`          | A cascade: speech-to-text → chat model → text-to-speech, each an OpenAI-compatible HTTP server you run   | `LOCAL_VOICE=on`       |
| `local-realtime` | One self-hosted server that speaks the OpenAI Realtime WebSocket protocol in front of open-weight models | `LOCAL_REALTIME_URL=…` |

Both use the same session core as the cloud backends, so the wake word, device actions, navigation speech, the
equaliser and the design templates behave identically.

## Quick start

```bash
docker compose -f docker-compose.local-voice.yml up -d
docker compose -f docker-compose.local-voice.yml exec ollama ollama pull qwen2.5:7b
```

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
```

That starts Speaches (faster-whisper) on `:8000`, Ollama on `:11434` and Kokoro-FastAPI on `:8880` — the three
defaults the `local` backend expects. The first request to each downloads its model.

## The `local` pipeline

Each stage is independent. Point any of them at a different server or model:

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

Anything that exposes the endpoints above works; none of these is required.

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

The pipeline transcribes the wearer's whole sentence before the model starts, so replies begin later than with a
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
