# Max Speech: our own local speech server

Date: 2026-11-20

## Goal

Give Max a speech server of its own, so a fully local deployment sounds as good as a cloud one. It is built for live
conversation first:

- Speech-to-text that streams partial words while the user is still talking.
- Turn detection that knows a pause from the end of a sentence.
- Text-to-speech that starts playing within a few hundred milliseconds.
- Voice cloning and voice design, managed from Max's Studio.

It replaces the three third-party containers in `docker-compose.local-voice.yml` (Speaches, Kokoro-FastAPI, our
MOSS-TTS-Nano adapter) for speech. Ollama or any other OpenAI-compatible server stays the chat model. The relay keeps
the conversation, tools and persona; the speech server only listens and speaks.

### Why not use VoiceStudio

VoiceStudio (github.com/debpalash/VoiceStudio) already serves OpenAI-compatible speech and would work with Max's
`local` backend unchanged. We are building our own because:

- **License of the code.** VoiceStudio is AGPL-3.0; Max is MIT. We can call it over HTTP but cannot ship any of it.
- **License of the weights.** Its default engine, OmniVoice, has CC-BY-NC weights. Max sells usage, so that engine
  is off limits to us.
- **What it is built for.** It is a studio that also serves agents. Its transcription returns the whole utterance at
  the end, and it has no turn detection. Those two things decide how a voice agent feels.

Ideas taken from it, all reimplemented: OpenAI-shaped errors, contract tests that drive the API through the official
`openai` SDK, a discovery document, a pronunciation lexicon, and recording the license of every model.

### What "better" means here, measured

Measured from the moment the user stops talking to the first byte of reply audio, **not counting the chat model**:

| Hardware           | Today (`local` pipeline) | Target  |
| ------------------ | ------------------------ | ------- |
| NVIDIA GPU         | ~1.5–2.5 s               | ≤ 0.5 s |
| Apple Silicon      | ~2–3 s                   | ≤ 0.8 s |
| CPU only (4 cores) | ~3–5 s                   | ≤ 1.5 s |

The "today" column is an estimate. Milestone 1 measures it with the same benchmark harness, before anything changes.

## Model choices: commercial-safe only

Every model's weights license was checked on its model card on 2026-11-20. The server refuses to load any model
that is not in the license registry (see "License gate").

| Role                                    | NVIDIA GPU                                                                  | Apple Silicon                       | CPU only              |
| --------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- | --------------------- |
| Voice activity                          | Silero VAD (MIT)                                                            | same                                | same                  |
| End of turn                             | smart-turn v3 (BSD-2), 8 MB ONNX                                            | same                                | same                  |
| Streaming STT, Chinese + English        | Paraformer-zh-streaming (Apache-2.0, pinned revision `apache-2.0-20260804`) | same, via sherpa-onnx               | same, via sherpa-onnx |
| Streaming STT, English and others       | Moonshine streaming (MIT)                                                   | same                                | same                  |
| Final transcript (optional second pass) | Whisper large-v3-turbo, faster-whisper                                      | Whisper large-v3-turbo, mlx-whisper | off by default        |
| TTS with cloning (default)              | Qwen3-TTS 0.6B / 1.7B Base (Apache-2.0), streaming, 10 languages            | Qwen3-TTS via mlx-audio             | —                     |
| TTS with cloning (alternative)          | CosyVoice 3 0.5B (Apache-2.0), 9 languages + Chinese dialects               | —                                   | —                     |
| Voice design from a description         | VoxCPM2 (Apache-2.0)                                                        | VoxCPM2 via mlx-audio               | —                     |
| Preset-voice TTS                        | Kokoro-82M (Apache-2.0)                                                     | Kokoro, MLX                         | Kokoro, ONNX          |

Considered and rejected:

- **Non-commercial weights:** OmniVoice, F5-TTS, XTTS-v2, Spark-TTS, OpenAudio S1.
- **Restricted:** IndexTTS2 (revenue and MAU caps), TEN VAD (no competing with Agora), the LiveKit turn detector
  (LiveKit Agents only), SenseVoice (the model license does not say whether commercial use is allowed).
- **No Chinese:** Kyutai TTS/STT, Pocket TTS, Parakeet.
- **Unmaintained:** Chatterbox, retired in August 2026.
- **Copyleft engine and per-voice terms:** Piper.

**CPU cloning stays off until a license is confirmed.** MOSS-TTS-Nano is the only CPU-friendly cloning model that
fits, but its README says to treat the repo as unlicensed if the root LICENSE file is missing. Until that file
exists, the CPU tier offers Kokoro's preset voices, and cloned voices need a GPU or a Mac. The existing MOSS adapter in
`examples/moss-tts-nano` stays as an example for people making their own license decision.

## Architecture

```text
browser / app / RDK ──/agent WS──► relay (Node, unchanged role) ──HTTP──► chat model (Ollama, vLLM, …)
                                      │
                                      │  /v1/speech/session  (WS: mic in → transcripts + turn events,
                                      │                       text in → reply audio out)
                                      │  /v1/voices…         (Studio voice management, admin only)
                                      ▼
                               Max Speech (Python, new: speech-server/)
                               ├─ engines/   one adapter per model family, behind three interfaces
                               ├─ turn/      Silero VAD + smart-turn
                               ├─ voices/    voice store: reference audio, transcript, consent record
                               ├─ licenses/  registry; refuses unlisted models
                               └─ api/       native WS, OpenAI-compatible HTTP, discovery
```

**Language: Python 3.11 + FastAPI + uvicorn.** Every model above ships for PyTorch, MLX or ONNX, so the model side
has to be Python. The relay stays TypeScript and talks to it over the network, as it does with every other backend.

**Where it lives:** `speech-server/` in this repo, MIT-licensed like the rest of Max, with its own `pyproject.toml`
managed by `uv`.

### Engine interfaces

```python
class SttStream(Protocol):          # one per conversation
    def push(self, pcm16_16k: bytes) -> list[SttEvent]: ...   # partials as they change
    def finish(self) -> SttEvent: ...                         # final for the current turn
    def reset(self) -> None: ...

class TtsEngine(Protocol):
    sample_rate: int
    supports_cloning: bool
    def stream(self, text: str, voice: Voice, *, cancel: Event) -> Iterator[bytes]: ...  # PCM16 chunks

class TurnDetector(Protocol):
    def speech_started(self, frame: bytes) -> bool: ...
    def turn_complete(self, utterance: bytes) -> float: ...   # probability the user is done
```

On startup the server reads the hardware profile (`cuda`, `mlx` or `cpu`; detected automatically, can be
overridden) and picks a default engine per role from the table above. `SPEECH_STT_ENGINE`, `SPEECH_TTS_ENGINE` and
the like override any choice.

All models are loaded and warmed up before the server reports ready, so the first request is never slow. GPU work
goes through one queue per device, so two sessions cannot run out of memory by loading the same model twice.

### Turn-taking (the biggest user-visible gain)

1. Silero VAD marks speech start. The server emits `speech.started` at once, which also drives barge-in.
2. Audio streams into the streaming STT, and partials go to the relay as they change.
3. After 200 ms of silence, smart-turn scores the utterance.
   - At ≥ 0.5 the turn ends.
   - Below 0.5, the server waits up to 1.5 s more for the user to continue, then ends the turn anyway.

   Today's relay always waits a fixed 700 ms and still cuts people off mid-thought. With this scheme a clear
   end-of-sentence closes the turn in about 200 ms, and a thinking pause is not mistaken for one.

4. When the turn ends, the final transcript comes from the streaming model, or from a Whisper second pass if that is
   on and arrives within 300 ms. Otherwise the streaming model's text is used.

Keyterms and the session language go to both STT passes, matching `EngineConfig.keyterms` and
`EngineConfig.languages` today.

### Speaking

The relay sends reply text as it streams from the chat model. The server splits it into speakable chunks:

- **Sentences**, with abbreviations, decimals, URLs and Chinese punctuation handled.
- **The first chunk** is cut early, at a comma or after about 6 words, so speech starts sooner.

Each chunk is synthesized as a stream, and 24 kHz PCM16 goes back as soon as the engine produces it. `cancel` stops
synthesis and drops queued audio within one chunk.

A pronunciation lexicon, edited in the Studio, rewrites words before synthesis, for example `{"MAX": "Max"}` or
place names.

## APIs

### Native session WebSocket: `GET /v1/speech/session`

The relay's new `max-speech` engine uses this. Auth is a bearer key (`SPEECH_API_KEY`); with no key set, the server
accepts loopback connections only.

Client → server:

| Message                                                                                                                   | Meaning                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `{"type":"session.update","languages":["zh","en"],"keyterms":["Max"],"voice":"<voice id>","turn":{"eagerness":"normal"}}` | Configure; can be sent again mid-session.                          |
| binary frame                                                                                                              | Microphone audio, 16 kHz mono PCM16, any frame size.               |
| `{"type":"speak","id":"r1","text":"…","final":false}`                                                                     | More reply text for reply `r1`. `final:true` marks the last piece. |
| `{"type":"cancel","id":"r1"}`                                                                                             | Stop speaking reply `r1` now.                                      |
| `{"type":"turn.end"}`                                                                                                     | End the user's turn now, e.g. a push-to-talk release.              |

Server → client:

| Message                                                                                                                             | Meaning                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `{"type":"ready","engines":{…}}`                                                                                                    | The session is configured.                      |
| `{"type":"speech.started"}`                                                                                                         | The user started talking (barge-in signal).     |
| `{"type":"transcript.partial","text":"…"}`                                                                                          | Cumulative words so far in this turn.           |
| `{"type":"transcript.final","text":"…","ms":{"stt":…,"turn":…}}`                                                                    | The turn ended; the relay calls the chat model. |
| `{"type":"audio.start","id":"r1","sampleRate":24000}`, then binary frames, then `{"type":"audio.done","id":"r1","cancelled":false}` | Reply audio.                                    |
| `{"type":"error","code":"…","message":"…"}`                                                                                         | A recoverable problem.                          |

### OpenAI-compatible HTTP

Max's existing `local` pipeline, and any other OpenAI client, can use these:

- `POST /v1/audio/speech`: `response_format` is `pcm` or `wav`, and `stream_format` is `audio` or `sse`.
- `POST /v1/audio/transcriptions`: `json`, `text` or `verbose_json`. OpenAI model ids map to the active engine.
- `GET /v1/models` and `GET /v1/audio/voices`.
- Errors use OpenAI's `{"error":{"message","type","param","code"}}` shape.

Only uncompressed formats are supported. MP3, Opus and AAC return a 400 that names `pcm` or `wav`, so ffmpeg is not a
dependency.

### Voices (admin): `/v1/voices`

| Route                              | Purpose                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/voices`                   | Preset and custom voices, with engine, languages and a preview URL.                                                                                    |
| `POST /v1/voices` (multipart)      | Clone from 5–30 s of audio plus its transcript. The transcript is filled in by the STT if left blank. Requires `consent: true` and `consentStatement`. |
| `POST /v1/voices/design`           | Create a voice from a text description (VoxCPM2). Returns candidates to audition before saving.                                                        |
| `POST /v1/voices/{id}/preview`     | Speak a sample line in this voice.                                                                                                                     |
| `PATCH` / `DELETE /v1/voices/{id}` | Rename, set languages, delete (removes the reference audio too).                                                                                       |
| `GET` / `PUT /v1/lexicon`          | Pronunciation lexicon.                                                                                                                                 |

Voices are stored under `SPEECH_DATA_DIR`, default `~/.max-speech/voices/<id>/`:

- `reference.wav`, plus a cached speaker embedding where the engine has one.
- `voice.json`: name, engine, languages, created by, and the consent record.

A voice cloned on one engine works on any cloning engine, because the reference audio and transcript are what is
stored.

### Discovery: `GET /.well-known/max-speech`

Returns the protocol version, hardware profile, active engine per role, whether cloning and design are available,
and the licenses of the loaded models (for the attribution screen).

## License gate

`speech-server/licenses/registry.toml` lists every model the server may load:

- Hugging Face repo and pinned revision.
- Weights license (SPDX id).
- Code license.
- The URL where the license was read, and the date.
- Attribution text, required for CC-BY models.

Downloads always use the pinned revision. Loading a model that is not in the registry, or whose license is not in the
commercial allowlist, fails with a message saying so. CI checks that every engine adapter's model ids are in the
registry. The discovery document and the Studio's "About voices" panel show the attributions.

## Max-side changes

1. **New engine `max-speech`** (`server/providers/live/max-speech.ts`). It uses the native WS for listening and
   speaking and keeps the chat-model and tool loop that `pipeline.ts` already has.
   - That loop moves into a shared module `server/providers/live/chat-loop.ts`, so the two engines share one copy.
   - `responseMode: "manual-only"`, as with the pipeline. The wake word, equaliser, navigation speech and device
     actions behave as with every other backend.
   - Configured with `VOICE_PROVIDER=max-speech`, `MAX_SPEECH_URL`, `MAX_SPEECH_API_KEY`, plus the existing
     `LOCAL_LLM_*` variables for the chat model.
2. **Catalog and Studio backends:** add `max-speech` to `server/providers/catalog.ts` and its fields to
   `server/studio-backends.ts`.
3. **Studio "Voices" tab** (`src/console/studio/`). All requests are proxied by the relay under
   `/auth/admin/studio/voices…`, so the browser never needs the speech server's address or key. The tab has:
   - A list of voices with play buttons.
   - **Clone:** record in the browser or upload, review the transcript, tick the consent box.
   - **Design:** describe the voice, audition three candidates, save one.
   - **Use for assistant:** sets the assistant's voice in `assistant.config.json`. This is a new `voice` key; for this
     backend it replaces `voiceGender`.
   - **Pronunciation:** edit the lexicon.
4. **`docker-compose.local-voice.yml`** runs `max-speech` plus Ollama instead of the three speech containers.
   `docs/local-models.md` gets a Max Speech section.

## Consent and safety

- Cloning needs an explicit consent statement, stored with the voice: who gave consent, when, and which admin
  uploaded it.
- Without consent the API refuses (400); the Studio will not submit without the box ticked.
- Voices are visible only to admins of the relay that owns them.
- **Out of scope:** watermarking generated audio, and per-project voices in Max Cloud. Both are follow-ups.

## Packaging

| Target                     | How                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| NVIDIA                     | `ghcr.io/…/max-speech:cuda` image (CUDA 12), GPU reservation in compose.                          |
| CPU / Lightsail / RDK host | `max-speech:cpu` image, ONNX only, under 1.5 GB.                                                  |
| Apple Silicon              | Native, not Docker (Docker on a Mac has no Metal): `uv run max-speech` or `start-speech.command`. |

Models download on first start into a volume, at pinned revisions, with progress in the logs and the discovery
document. `max-speech download --profile cuda` pre-fetches them for offline installs.

## Testing

- **Unit:** sentence chunker (Chinese and English fixtures, abbreviations, decimals, URLs), lexicon, turn-end policy
  with synthetic probability sequences, license registry checks.
- **Contract:** the official `openai` Python SDK drives every HTTP route. A recorded WS session pins the native
  protocol, on the Python side and in a vitest test of the `max-speech` engine against a fake server.
- **Engines:** each adapter has a smoke test (load, transcribe a fixture clip, synthesize one sentence) that runs only
  on matching hardware (marked `cuda`, `mlx`, `cpu`); CI runs the CPU set.
- **Latency benchmark** (`speech-server/bench/`): plays recorded zh and en turns through the WS at real-time pace and
  reports p50/p95 for speech end → final transcript, and for speak → first audio byte. It runs against the current
  `local` pipeline as well, which gives the "today" baseline and checks the targets.

## Milestones

Each milestone ships on its own and leaves Max working.

1. **Server skeleton and OpenAI-compatible routes.**
   - Hardware profile, license gate, Kokoro and Whisper engines, discovery, contract tests.
   - The latency benchmark, with a baseline of today's stack.
   - Max's existing `local` pipeline can point at it with no relay changes.
2. **Live conversation.**
   - Silero VAD, smart-turn, streaming STT (Paraformer, Moonshine), sentence chunker.
   - The native WS and the relay's `max-speech` engine, with the chat loop extracted.
   - Targets checked with the benchmark.
3. **Cloning.** Qwen3-TTS (CUDA, MLX), CosyVoice 3 (CUDA), the voice store, consent, voice routes.
4. **Studio Voices tab.** Clone, design (VoxCPM2), preview, assign, lexicon, attribution panel.
5. **Packaging and docs.** CUDA and CPU images, the Mac launcher, compose, `docs/local-models.md`, README.

## Risks and open questions

- **Qwen3-TTS on MLX** is listed by mlx-audio but untested by us. If its streaming is not good enough on a Mac, the
  Mac default for cloning falls back to whole-sentence synthesis, which is slower but still works. Milestone 3 decides
  with the benchmark.
- **The data behind the streaming Chinese STT models** (WenetSpeech and others) is not stated on every card. Before
  milestone 2 ships, check the training data of the exact Paraformer and Moonshine checkpoints we pin.
- **Whisper large-v3** shows Apache-2.0 on one card and MIT on another. Both allow commercial use; record whichever
  the pinned revision's LICENSE file says.
- **Echo:** barge-in assumes the client cancels its own echo, as the browser, iOS and Android clients and
  `rdk/aec` already do. A client without echo cancellation will interrupt itself. The server does not try to fix that.
