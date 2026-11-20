# Max Speech, Milestone 2: live conversation

> **For agentic workers:** implement only the task you are given, and touch only the files it owns. Write tests first.
> Do not commit; the lead commits. Do not edit `speech-server/pyproject.toml` or `uv.lock`: sherpa-onnx 2.0.2 is
> already added.

**Goal.** A `/v1/speech/session` WebSocket that:

- listens with Silero VAD and streaming speech-to-text (partial words while the user talks);
- ends turns with smart-turn instead of a fixed silence;
- speaks reply text as it streams in, cutting the first piece early so audio starts sooner.

The relay gets a `max-speech` backend that uses this socket and the shared chat loop (`server/providers/live/chat-loop.ts`,
already done).

**Spec.** See `docs/superpowers/specs/2026-11-20-max-speech-server-design.md`, sections "Turn-taking" and "Native
session WebSocket".

**Already done on this branch:**

- `server/providers/live/chat-loop.ts`, used by `pipeline.ts`.
- `SentenceChunker(early_first_chunk=True)`, with `reset()`.
- The interfaces `SttStream`, `StreamingSttEngine`, `VadStream`, `VadEngine` and `TurnDetector` in
  `speech-server/src/max_speech/engines/base.py`. These are the contract between tasks; do not change them without
  telling the lead.

## Models (checked 2026-11-20)

| Registry id                  | Kind | Source                                                                                                                                                                                                                                                                         | License                                                                                                        |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `silero-vad-v6.2`            | vad  | url: `https://github.com/snakers4/silero-vad/raw/bfdc0193023f121ea5b3cc7b176dbed570a68a59/src/silero_vad/data/silero_vad.onnx`, sha256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`                                                                      | MIT                                                                                                            |
| `smart-turn-v3.2`            | turn | url: `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx` (download it and compute the sha256)                                                                                                          | BSD-2-Clause                                                                                                   |
| `x-asr-zh-en-480ms`          | stt  | url: the sherpa-onnx GitHub release asset `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2` (find its exact URL in the k2-fsa/sherpa-onnx releases; its sha256 starts `fa5f63d6` and ends `bf74`; verify it); `archive = "tar.bz2"` | Apache-2.0 (upstream GilgameshWind/X-ASR-zh-en; note: training data "open-source and collected", not itemised) |
| `paraformer-zh-en-streaming` | stt  | hf `csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en` @ `8e40c432…` (get the full sha from the HF API); `allow_patterns` for the int8 files and `tokens.txt` only                                                                                                   | Apache-2.0 (converted from ModelScope damo paraformer; data not stated)                                        |

The research behind these choices ran local experiments (not committed):

- sherpa-onnx streaming
- Silero VAD
- smart-turn numpy features, verified against transformers to 1.2e-7

Read them; you may reuse that code.

## Protocol (`/v1/speech/session`): the contract between the server tasks and the relay task

Auth is the same as `/v1/*`: a bearer key when `SPEECH_API_KEY` is set, otherwise loopback only. A refused
connection is closed before accept, which the client sees as HTTP 403.

### Client → server

| Message                                                                                                                                   | Meaning                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type":"session.update","languages":["zh","en"],"keyterms":["Max"],"voice":"af_heart","gender":"female","turn":{"eagerness":"normal"}}` | Every field is optional. Send it first. It can be sent again; later values replace earlier ones. `voice` wins over `gender`. `eagerness` is `low`, `normal` or `high`. |
| binary frame                                                                                                                              | Microphone audio, 16 kHz mono PCM16 little-endian, any length.                                                                                                         |
| `{"type":"speak","id":"r1","text":"…","final":false}`                                                                                     | More reply text for reply `r1`. `final:true` (text may be empty) marks the end of `r1`.                                                                                |
| `{"type":"cancel","id":"r1"}`                                                                                                             | Stop reply `r1` now.                                                                                                                                                   |
| `{"type":"turn.end"}`                                                                                                                     | End the user's turn now.                                                                                                                                               |

### Server → client

| Message                                                                                            | Meaning                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"type":"ready","protocol":"max-speech.session.v1","engines":{"vad":…,"turn":…,"stt":…,"tts":…}}` | Sent after the first `session.update`. If models are not loaded, the server sends `error` with code `loading` and closes with 1013.                           |
| `{"type":"speech.started"}`                                                                        | The user started talking. This is also the barge-in signal.                                                                                                   |
| `{"type":"transcript.partial","text":"…"}`                                                         | Cumulative text of this turn, sent only when it changes.                                                                                                      |
| `{"type":"transcript.final","text":"…","ms":{"turn":N,"stt":N}}`                                   | The turn ended. `turn` is the time from the end of speech to the turn decision; `stt` is the time from the decision to the final text. The text may be empty. |
| `{"type":"audio.start","id":"r1","sampleRate":24000}`                                              | Reply `r1` starts. Binary frames of 24 kHz PCM16 follow.                                                                                                      |
| `{"type":"audio.done","id":"r1","cancelled":false}`                                                | Reply `r1` ended. Every `speak` id gets exactly one `audio.done`. `cancelled` is true after `cancel`.                                                         |
| `{"type":"error","code":"…","message":"…"}`                                                        | A recoverable problem, such as a bad message or an unknown voice.                                                                                             |

Rules:

- Replies are spoken in the order their ids first appear, one at a time.
- Binary frames from the server belong to the reply whose `audio.start` came last.
- A malformed client message gets an `error` and the session continues.

## Turn-taking (server)

The state machine is pure, driven by 512-sample frames (32 ms at 16 kHz), with an injectable clock. Thresholds:

- **Speech starts** when the probability is ≥ 0.5 for 2 consecutive frames.
  - The STT stream gets 300 ms of pre-roll.
  - The server emits `speech.started`.
- **A frame is quiet** when its probability is < 0.35.
- **When quiet time reaches `pause_ms`** (low 400, normal 200, high 120), the server runs smart-turn on the last 8 s
  of the utterance.
  - If p ≥ 0.5, the turn ends.
  - Otherwise it waits. If speech resumes, it continues the turn. If quiet time reaches `max_wait_ms` (low 2000,
    normal 1500, high 800), the turn ends.
- **An utterance longer than 30 s** ends the turn.
- **An utterance with less than 200 ms of voiced frames** ends with `transcript.final ""`.
- **At turn end:** call `stream.finish()`, emit `transcript.final`, then `stream.reset()`.
  - Optional second pass: if a batch STT engine is loaded and `SPEECH_SECOND_PASS` is not `off`, transcribe the
    utterance with it under a 300 ms deadline. If it returns non-empty text in time, use it.
  - The second pass defaults to on for the `mlx` and `cuda` profiles and off for `cpu`.

---

### Task A: registry, archive downloads, Silero VAD

**Owns:**

- `speech-server/src/max_speech/licenses/registry.toml`
- `speech-server/src/max_speech/licenses/__init__.py` (only if needed for new fields)
- `speech-server/src/max_speech/models.py`
- new `speech-server/src/max_speech/engines/silero_vad.py`
- tests: `tests/test_models.py`, `tests/test_licenses.py`, new `tests/test_silero_vad.py`

**Work:**

- **Registry:** add the four registry entries above, with real hashes and SHAs.
- **Archive downloads:**
  - Add the optional fields `archive = "tar.bz2"` (on a url source with exactly one file) and `allow_patterns`
    (on an hf source).
  - `ensure_model` verifies the archive's sha256, then extracts it with `tarfile` and `filter="data"`, so no
    absolute paths, `..`, links or devices. It extracts into `models_dir/<id>/` and writes an `.extracted` marker
    holding the sha.
  - If the marker matches, it skips. It deletes the archive after extracting.
  - Expose a helper that finds the single top-level directory, because sherpa archives contain one.
- **`SileroVad(model_dir)` (`VadEngine`):**
  - One shared `onnxruntime.InferenceSession` with 1 intra-op thread.
  - `new_stream()` returns a stream with `frame_samples = 512`. It keeps the `[2,1,128]` state and the last 64
    samples of context, and feeds the model 576 samples.
  - The session call is serialized with a `threading.Lock`, since streams share it.
  - `reset()` zeroes the state and context.
- **Tests:**
  - Unit tests: archive extraction, rejecting a traversal member, the marker skip, registry entries passing
    `require()`, and the VAD stream with a fake session checking state threading and context.
  - Real-model tests (`models` marker): speech audio (synthesize with Kokoro, resample to 16 kHz) gives
    probability > 0.5 on most voiced frames, and silence gives < 0.1.

### Task B: smart-turn

**Owns:** new `speech-server/src/max_speech/engines/smart_turn.py` and new `tests/test_smart_turn.py`.

**Work:**

- **`whisper_log_mel(audio_16k) -> np.ndarray[80, 800]`**, numpy only:
  - Zero-mean/unit-variance normalise.
  - Truncate to the last 8 s, or zero-pad at the start.
  - STFT with n_fft 400, hop 160, a periodic Hann window and reflect centre padding; drop the last frame.
  - 80 slaney mel filters, 0–8000 Hz, with slaney normalisation.
  - log10 with floor 1e-10, clamp to (max − 8), then (x + 4) / 4.
  - Build the mel filter bank yourself, cached.
- **`SmartTurn(model_dir)` (`TurnDetector`):**
  - Loads `smart-turn-v3.2-cpu.onnx` with onnxruntime (1 thread, lock-serialized).
  - `turn_complete(utterance)` returns the model output as a float in 0–1.
  - `warm_up` runs it once.
- **Tests:**
  - Unit tests: the feature shape; padding goes at the start; truncation keeps the end; a 1 kHz sine puts its
    energy in the expected mel band; values stay in the expected range; deterministic.
  - The research script compared against transformers. Do not add transformers. Instead, commit a small fixture:
    generate reference features for a 1 s synthetic signal with transformers in a throwaway environment, save them as
    `.npy` under `tests/fixtures/`, and assert max abs difference < 1e-4.
  - Real-model tests (`models` marker), using Kokoro audio resampled to 16 kHz with 0.2 s of trailing silence:
    - "What's the weather like today?" → p > 0.5.
    - "I want to go to the" → p < 0.5.

### Task C: streaming STT engine and engine selection

**Owns:**

- new `speech-server/src/max_speech/engines/streaming_sherpa.py`
- `speech-server/src/max_speech/engines/select.py`
- `speech-server/src/max_speech/settings.py`
- `speech-server/src/max_speech/cli.py`
- `speech-server/src/max_speech/api/discovery.py`
- tests: `tests/test_select.py`, `tests/test_cli.py`, `tests/test_settings.py`, new `tests/test_streaming_sherpa.py`,
  `tests/test_api_http.py` (discovery assertions only)

**Work:**

- **`SherpaStreamingStt(model_dir, kind="transducer"|"paraformer", model_id=…)` (`StreamingSttEngine`):**
  - Builds one `sherpa_onnx.OnlineRecognizer` (int8 files, `num_threads=2`, sherpa's own endpointing disabled,
    because turn-taking decides).
  - `new_stream()` wraps `recognizer.create_stream()`.
  - `accept()` calls `accept_waveform(16000, audio)`, decodes while ready and returns the text if it changed.
  - `finish()` feeds 0.5 s of tail padding (zeros), calls `input_finished()`, decodes to the end and returns the
    final text.
  - `reset()` creates a fresh stream; sherpa's `reset` alone does not clear `input_finished`.
  - Decoding is serialized by a lock on the recognizer.
  - Keyterms: sherpa hotwords need `modified_beam_search`. Accept them, ignore them, and add a TODO comment.
- **Selection:** add roles to the plan for every profile.
  - The roles: `vad` (`silero-vad-v6.2`), `turn` (`smart-turn-v3.2`) and `stt_stream` (`x-asr-zh-en-480ms`,
    transducer). The existing `stt` becomes the second pass.
  - Overrides go in `settings.py`: `SPEECH_VAD_MODEL`, `SPEECH_TURN_MODEL`, `SPEECH_STREAM_STT_MODEL` (each may be
    `off`) and `SPEECH_SECOND_PASS` (`on`, `off` or `auto`; auto means on for mlx and cuda).
  - Every model goes through `require()` before any download.
  - `build_engines` returns a small dataclass `Engines(stt, tts, vad, turn, stt_stream, second_pass: bool)`
    instead of a tuple. Update the callers.
- **CLI:**
  - `serve` and `download` cover the new roles. `engines` prints them.
  - `_load_engines` warms them up and puts them on `slots` (`slots.vad`, `slots.turn`, `slots.stt_stream`,
    `slots.second_pass`). Task D adds those fields to `EngineSlots`; you set them.
  - Until D's change lands, use `setattr`; tests can use a simple object.
- **Discovery:** `features.session_ws` is true when `vad`, `turn`, `stt_stream` and `tts` are all loaded. Attributions
  include the new models.
- **Tests:**
  - Unit tests: selection defaults and overrides, `off`, license refusal before download, and the
    `SherpaStreamingStt` logic against a fake recognizer.
  - Real-model tests (`models` marker): English and Chinese Kokoro audio, resampled to 16 kHz and streamed in 100 ms
    chunks, gives at least one partial before the end. The final text is close to the reference: WER ≤ 0.2 for
    English, CER ≤ 0.2 for Chinese.

### Task D: the session WebSocket

**Owns:**

- new package `speech-server/src/max_speech/session/` (`turns.py`, `speaking.py`, `__init__.py`)
- new `speech-server/src/max_speech/api/session_ws.py`
- `speech-server/src/max_speech/api/slots.py`
- `speech-server/src/max_speech/api/auth.py`
- `speech-server/src/max_speech/app.py`
- tests: new `tests/test_turns.py`, `tests/test_speaking.py`, `tests/test_session_ws.py`; `tests/test_auth.py`

**Work:**

- **`session/turns.py`:** `TurnTaker`, a pure state machine implementing the turn-taking rules above.
  - Driven by `push(frame_probability, frame_audio, now_ms)`. It returns a list of events (`SpeechStarted`,
    `Partial(text)`, `TurnEnded(text, ms)`).
  - It takes a `VadStream`-independent probability, an `SttStream` and a `turn_complete` callable, all injected, so
    it is fully testable with fakes and a fake clock.
  - Running smart-turn and the STT is the caller's business. Design it so the WS layer can run those calls in a
    thread without blocking the loop: for example, `push` returns a `RunTurnCheck(audio)` request, and
    `turn_checked(p, now)` feeds the result back.
- **`session/speaking.py`:** `ReplySpeaker`.
  - Holds the reply queue in id order.
  - Each reply has a `SentenceChunker(early_first_chunk=True)`.
  - Chunks are synthesized through the shared TTS engine under `slots.tts_lock` (asyncio), one chunk per
    threadpool call, as `SynthJob` does in `api/openai_routes.py`. Reuse or factor out that code; do not duplicate
    it carelessly.
  - Output is resampled to 24 kHz PCM16.
  - Cancel stops between chunks, drops queued text and audio, and emits `audio.done cancelled:true`.
  - Exactly one `audio.done` per id.
- **`api/session_ws.py`:** the protocol above, a websocket route at `/v1/speech/session`.
  - A receive loop pushes audio into an asyncio queue.
  - A per-session worker task slices audio into 512-sample frames, runs the VAD probability, `stt_stream.accept`
    and smart-turn in the threadpool (serialized per engine by locks on the slots), and sends events.
  - A send lock or single writer prevents interleaved writes.
  - On disconnect, cancel everything and release locks.
- **`EngineSlots`:** add `vad`, `turn`, `stt_stream` (default None), `second_pass: bool = False`, and asyncio locks
  `vad_lock`, `turn_lock`, `stt_stream_lock`.
- **`AuthMiddleware`:** also covers `websocket` scopes under `/v1`, by sending `websocket.close` (code 1008) before
  accept.
- **Tests (TDD):**
  - `TurnTaker`, exhaustive with a fake clock:
    - speech start needs 2 frames;
    - pre-roll is fed to STT;
    - partials only on change;
    - p ≥ 0.5 ends the turn;
    - a low p then resumed speech continues the turn;
    - a low p then `max_wait` ends the turn;
    - eagerness levels;
    - a short blip gives an empty final;
    - 30 s cap;
    - `turn.end` forces the end;
    - the second pass uses the deadline.
  - `ReplySpeaker` with fake TTS: ordering, early first chunk, cancel mid-reply, exactly one `audio.done`, and a
    reply with only `final:true`.
  - The WebSocket through Starlette's `TestClient`, with fake engines (deterministic fake VAD driven by audio
    amplitude, fake STT stream, fake turn): the full conversation (audio in → `speech.started` → partials → final;
    `speak` → `audio.start`, binary, `audio.done`), `cancel`, bad messages give `error` and the session continues,
    `loading` close 1013, and auth refusal.

### Task E: the relay's `max-speech` backend

**Owns:**

- new `server/providers/live/max-speech.ts`
- `server/providers/catalog.ts`
- `server/providers/factory.ts`
- `server/studio-backends.ts`
- any shared provider-id type, plus a generated protocol file if `npm run check:protocol` requires it
- new `tests/max-speech.test.ts`
- the `docs/local-models.md` section on the backend

Do not change `chat-loop.ts` or `pipeline.ts` unless unavoidable; if you must, report it.

**Work:** implement `VoiceEngine` (`responseMode: "manual-only"`) over the protocol above.

- **Settings:**
  - `MAX_SPEECH_URL`, default `ws://localhost:8790/v1/speech/session`; accept `http(s)://host:port` and derive
    the ws URL.
  - `MAX_SPEECH_API_KEY`, sent as a bearer header.
  - `MAX_SPEECH_VOICE`, optional.
  - The chat model comes from `localPipelineSettings().llm`, so `LOCAL_LLM_*` and the Ollama default.
- **`connect`:**
  - Open the socket.
  - Send `session.update` with `languages`, `keyterms`, `gender` from `config.voiceGender` and `voice`.
  - Wait for `ready`, with a 10 s timeout.
  - Reject with a message fit for the person setting up: "Max Speech is not reachable at …" or "Max Speech is still
    loading its models".
- **`sendAudio`:** forward the binary audio.
- **`speech.started`:** barge-in, mirroring pipeline's VAD `onStart`: `wasReplying = loop.replying`, `loop.stop()`,
  send `cancel` for the active reply id, `events.onSpeechStarted()`, and `endReply(true)` if it was replying.
- **Transcripts:**
  - `transcript.partial` → `onRiderTranscript(text, false)`.
  - `transcript.final` → keep `pendingUser`, then `onRiderTranscript(text, true)`.
  - Log the ms values at debug level.
- **`respond`:** `loop.reply(pendingUser)`, as the pipeline does.
- **Speaker per reply** (`newSpeaker`): a fresh id.
  - `delta` sends `speak {final:false}` when `ctx.current()` holds.
  - `say` sends `speak {final:true}` with the line.
  - `finish` sends `speak {text:"", final:true}` if not already final, then resolves on that id's `audio.done`, a
    socket close or an abort.
  - Binary frames go to `onAgentAudio` only while the last `audio.start` id is the current reply and
    `ctx.current()` holds.
- **`cancel`, `close` and `onClosed`:** `cancel`, `close`, and `onClosed` on an unexpected socket close.
- **Registration:**
  - `catalog.ts`: id `max-speech`, label "Max Speech (local)", configured when `MAX_SPEECH_URL` is set or
    `MAX_SPEECH=on`, `local: true`.
  - `factory.ts` and the `studio-backends.ts` fields.
- **`tests/max-speech.test.ts` (vitest)**, with an in-process fake speech server using the `ws` package and a fake
  chat `request`:
  - connect and `ready`;
  - a spoken turn (partials, final, then `respond` → speak messages → audio forwarded → `onResponseDone`);
  - barge-in during a reply;
  - an unreachable server error;
  - the loading close;
  - a tool round still works.
- **Checks:** `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm run format:check`,
  `npm run check:dead-code`, `npm run check:protocol`.

### Task F (lead): integration

- Benchmark WS mode. Play Kokoro-generated zh and en utterances at real time with 1.5 s of trailing silence, and
  measure:
  - end of speech → `transcript.final`;
  - `speak` → first audio.
  - For comparison, compute the M1 pipeline equivalent: 700 ms of VAD hangover plus the measured
    `/v1/audio/transcriptions` latency.
- Run the relay end to end with `VOICE_PROVIDER=max-speech`.
- Docs.
- A final whole-branch review.
