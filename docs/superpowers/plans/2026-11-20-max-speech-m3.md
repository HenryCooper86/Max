# Max Speech, Milestone 3: voice cloning with consent

> **For agentic workers:** implement only the task you are given and touch only the files it owns. Write tests
> first. Do not commit; the lead commits. Code must be original MIT: never copy from VoiceStudio (AGPL) or other
> copyleft projects.

**Goal:** an admin can clone a voice from 5–30 s of recorded speech plus an explicit consent statement, and then use
that voice anywhere a voice id is accepted: `/v1/audio/speech`, the live session's `session.update.voice`, and the
relay's `MAX_SPEECH_VOICE`.

**Spec:** `docs/superpowers/specs/2026-11-20-max-speech-server-design.md`. See "Voices (admin)", "Consent and
safety", the model table, and milestone 3.

**Contract between tasks:** `ReferenceVoice` and `CloningTtsEngine` in
`speech-server/src/max_speech/engines/base.py`. They already exist; do not change them without telling the lead.

## Design

- **Voice store** (`speech-server/src/max_speech/voices/store.py`).
  - Custom voices live in `SPEECH_DATA_DIR/voices/<id>/`, as `reference.wav` (24 kHz mono PCM16) plus `voice.json`.
  - Ids are `v_` followed by 10 lowercase hex characters (`secrets.token_hex(5)`), so they can never collide with
    preset voice ids such as `af_heart`.
  - `voice.json` holds:

    ```json
    {"id": "v_3f9a…", "name": "Ava", "languages": ["en"], "gender": "female",
     "transcript": "…", "transcript_source": "given"|"stt", "duration_s": 12.4,
     "created_at": "2026-11-20T10:00:00Z", "created_by": "admin name from the request",
     "consent": {"statement": "I, Ava Lee, agree that my voice may be cloned for the Acme assistant.",
                 "speaker": "Ava Lee", "recorded_at": "…"},
     "engine_hint": null}
    ```

  - Writes are atomic: write a temp file, then `os.replace`. Directory creation uses `0o700`.
  - A `threading.Lock` guards the in-memory index, which is loaded once at startup.
  - `delete(id)` removes the directory, reference audio included.
  - `get(id) -> ReferenceVoice` caches the decoded audio per id, and the cache is invalidated on update or delete.
- **Reference validation**, in the store's `create`:
  - Decode with `audio.decode_audio` and mix down to mono.
  - Duration must be 5–30 s; otherwise `VoiceError("reference_too_short" | "reference_too_long")`.
  - Reject near-silence with `reference_silent`: RMS below about −45 dBFS after trimming leading and trailing
    silence.
  - Reject heavy clipping with `reference_clipped`: more than 1% of samples at |x| ≥ 0.999.
  - Trim leading and trailing silence, resample to 24 kHz, and peak-normalise to −1 dBFS.
- **Consent.**
  - `consent` must be literally `true`.
  - `consent_statement` must be at least 20 characters, and `consent_speaker` must be non-empty.
  - Anything else is refused with `consent_required` (400).
  - The consent record is stored with the voice and returned by `GET`.
  - There is no way to create a custom voice without it, including from code; the store enforces it, not just the
    route.
- **Lexicon** (`speech-server/src/max_speech/voices/lexicon.py`).
  - Stored in `SPEECH_DATA_DIR/lexicon.json` as `{"entries": {"MAX": "Max", "Dr": "Doctor", "GIF": "jiff"}}`.
  - `apply(text)` replaces longest keys first. Keys made of Latin letters, digits, apostrophes or hyphens match whole
    words case-insensitively. Keys containing CJK characters match as substrings.
  - At most 500 entries, keys ≤ 64 characters and values ≤ 128.
- **Voice router** (`speech-server/src/max_speech/engines/router.py`).
  - `VoiceRouter(preset: TtsEngine, cloning: CloningTtsEngine | None, store: VoiceStore, lexicon: Lexicon)`
    implements the `TtsEngine` protocol, so every existing caller works unchanged.
  - `voices()` returns the preset voices plus custom voices (as `VoiceInfo`). It returns custom voices only when
    `cloning` is loaded.
  - `default_voice` delegates to the preset engine.
  - `synthesize(text, voice, …)` applies the lexicon first. A `v_…` id goes to `cloning.synthesize_cloned(text,
store.get(id), …)`; anything else goes to `preset.synthesize`.
  - A custom id with no cloning engine raises `UnknownVoiceError`. The message must say cloning is not available on
    this server, and the API maps it to 404 `voice_not_found`.
  - `id`, `model_id` and `sample_rate` follow the preset engine, and output is resampled to the preset rate when the
    cloning engine's rate differs.
  - Expose `.preset` and `.cloning`, so discovery can list both engines' attributions.
- **Wiring:**
  - `EngineSlots.tts` becomes the router.
  - Add `slots.voices` (the store), `slots.lexicon` and `slots.cloning`.
  - `create_app` gains `cloning=None, voice_store=None, lexicon=None`. When it is given a plain preset TTS, it wraps
    it in a router with an empty store under a temp or settings `data_dir`.
- **Routes** (`speech-server/src/max_speech/api/voice_routes.py`). All require auth, like the rest of `/v1`.

  | Route                                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /v1/voices`                     | `{"voices":[{id,name,kind:"preset"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "custom",languages,gender, …custom: transcript,duration_s,created_at,created_by,consent}],"cloning":bool}` |
  | `POST /v1/voices`                    | Multipart: `audio` (file), `name`, `transcript` (optional), `languages` (comma list, optional), `gender` (optional, default `neutral`), `consent` (`true`), `consent_statement`, `consent_speaker`, `created_by` (optional). Returns 201 with the voice. A blank transcript is transcribed with `slots.stt` (the batch engine); if there is none, 400 `transcript_required`. If cloning is not loaded, 409 `cloning_unavailable`. Errors use the `VoiceError` codes, and the upload limit is 25 MB through the existing middleware. |
  | `GET /v1/voices/{id}`                | One voice, or 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
  | `PATCH /v1/voices/{id}`              | JSON: `name`, `languages`, `gender`, `transcript`. Changing the transcript clears the engine cache.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | `DELETE /v1/voices/{id}`             | 204.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | `GET /v1/voices/{id}/reference`      | The stored reference WAV, so an admin can listen to what was recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | `POST /v1/voices/{id}/preview`       | JSON `{text?}`, default "Hello, this is my voice." or "你好，这是我的声音。" by the voice's language. Returns `audio/wav`, at most 300 chars.                                                                                                                                                                                                                                                                                                                                                                                       |
  | `GET /v1/lexicon`, `PUT /v1/lexicon` | Read or replace the whole lexicon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
  - `/v1/audio/voices` must also list custom voices; it does so automatically through the router.
  - Discovery: `features.cloning` is true when a cloning engine is loaded, and attributions include it.

---

### Task A: store, lexicon, router, routes (model-independent)

**Owns:**

- new package `speech-server/src/max_speech/voices/`
- new `engines/router.py`
- new `engines/fake_cloning.py` (`FakeCloningTts`: deterministic audio whose pitch depends on the reference id,
  for tests)
- new `api/voice_routes.py`
- `api/slots.py`, `app.py`, `api/discovery.py`, `api/limits.py` (extend the upload limit to `POST /v1/voices`)
- `api/openai_routes.py` (only if needed to map the new errors)
- `settings.py` (only if a new setting is needed)
- tests: new `test_voice_store.py`, `test_lexicon.py`, `test_router.py`, `test_voice_routes.py`; extend
  `test_api_http.py` and `test_session_ws.py` with one test each, checking that a custom voice works through
  `/v1/audio/speech` and through `session.update.voice`

**Do not touch** `engines/select.py` or `cli.py`; Task B wires the real engines.

**Tests must cover:** every validation code; the consent refusal at both route and store level; atomic persistence
(reload from disk); delete removing files; lexicon matching (whole word vs CJK substring, case-insensitive, longest
first, limits); router dispatch, resampling and errors; and the discovery flag.

### Task B (after the research): real cloning engines and selection

The lead writes this task once the model research is in. It covers the engines per profile, the registry entries,
the `cloning` role in `select.py` and `cli.py` (`SPEECH_CLONING_MODEL`, or `off`), and real-model tests: CER/WER of
cloned speech plus a speaker-similarity check where available.
