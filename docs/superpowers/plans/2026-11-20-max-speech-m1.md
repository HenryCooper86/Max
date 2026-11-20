# Max Speech, Milestone 1: server skeleton and OpenAI-compatible routes

> **For agentic workers:** Implement task by task. Steps use checkbox (`- [ ]`) syntax. Write the test first, watch it
> fail, then make it pass. Do not commit; the lead commits.

**Goal:** A Python speech server at `speech-server/` that serves OpenAI-compatible speech-to-text and text-to-speech
from commercially licensed local models, refuses unlicensed models, and has a benchmark. With it, Max's existing
`local` pipeline works with no relay changes:

```dotenv
LOCAL_STT_BASE_URL=http://localhost:8790/v1
LOCAL_TTS_BASE_URL=http://localhost:8790/v1
```

**Spec:** `docs/superpowers/specs/2026-11-20-max-speech-server-design.md` (milestone 1 only: no streaming STT, no
turn-taking, no cloning).

**Tech stack:** Python 3.12, uv, FastAPI, uvicorn, kokoro-onnx (TTS), faster-whisper (STT on CPU and CUDA),
mlx-whisper (STT on Apple Silicon), pytest, the `openai` SDK for contract tests, ruff.

## Global constraints

- Everything lives under `speech-server/`. Python package `max_speech` in `speech-server/src/max_speech/`, tests in
  `speech-server/tests/`.
- **The code must stay MIT.** Never copy code from VoiceStudio (AGPL) or any other copyleft project.
- **No model is loaded unless it is in the license registry** (`speech-server/src/max_speech/licenses/registry.toml`)
  with an allowed weights license. No exceptions in tests: fakes are not models and skip the registry.
- **Default unit and contract tests must not download models or need a GPU.** Tests that need real models are marked
  `@pytest.mark.models` and are skipped unless `MAX_SPEECH_MODEL_TESTS=1`.
- **The audio contract matches the relay** (`server/providers/live/engine.ts`): input is 16 kHz mono PCM16, and
  output is 24 kHz mono PCM16 for `pcm`. WAV output is 24 kHz mono PCM16 too.
- **Default port is 8790.**
- **Every env var is `SPEECH_*`.**
- **Errors on `/v1/*` use OpenAI's shape:** `{"error":{"message","type","param","code"}}`, HTTP 400 for bad
  requests, 401 for auth, 404 for unknown voice or model, 503 while models are loading.
- **Comments explain why, not what.** Match the tone of `server/providers/live/pipeline.ts`.
- **Dependencies are declared once in Task 1.** Later tasks must not edit `pyproject.toml`. If a task truly needs a
  new dependency, stop and report.

## Pinned dependencies (Task 1 writes these)

Runtime:

- `fastapi==0.165.0`
- `uvicorn[standard]==0.54.0`
- `python-multipart==0.0.34`
- `numpy==2.5.5`
- `soundfile==0.14.0`
- `huggingface-hub==2.4.0`
- `httpx==0.28.1`
- `kokoro-onnx==0.6.1`
- `faster-whisper==1.2.1`

Optional extra `mlx` (macOS arm64 only):

- `mlx-whisper==0.4.3; sys_platform == 'darwin' and platform_machine == 'arm64'`

Dev group:

- `pytest==9.2.0`
- `pytest-asyncio==1.5.0`
- `openai==3.57.0`
- `ruff==0.17.6`

---

### Task 1: Scaffold, settings, hardware profile

**Files:**

- Create: `speech-server/pyproject.toml`, `speech-server/.python-version` (`3.12`), `speech-server/README.md` (stub:
  one paragraph plus "see docs/local-models.md")
- Create: `speech-server/src/max_speech/__init__.py` (`__version__ = "0.1.0"`)
- Create: `speech-server/src/max_speech/settings.py`, `speech-server/src/max_speech/profile.py`
- Create: `speech-server/tests/test_settings.py`, `speech-server/tests/test_profile.py`, `speech-server/tests/conftest.py`
- Modify: root `package.json`: add the script
  `"test:speech": "cd speech-server && uv run --frozen pytest -q"`.

**`pyproject.toml`:**

- Project name `max-speech`, license `MIT`, `requires-python = ">=3.12,<3.14"`.
- hatchling build backend, src layout.
- Console script `max-speech = "max_speech.cli:main"`. `cli.py` arrives in Task 5; until then, create
  `max_speech/cli.py` with `def main() -> int: raise SystemExit("not yet")`.
- `[tool.pytest.ini_options]`: `testpaths = ["tests"]`, `asyncio_mode = "auto"`, marker
  `models: downloads and runs real models (set MAX_SPEECH_MODEL_TESTS=1)`.
- `[tool.ruff]`: `line-length = 110`, `target-version = "py312"`.

Run `uv lock`, and commit-ready `uv.lock` must exist.

**`settings.py`:**

- A frozen dataclass `Settings`, with `Settings.from_env(env: Mapping[str, str] = os.environ)`.
- Fields:
  - `host="127.0.0.1"`, `port=8790`
  - `api_key: str | None` (`SPEECH_API_KEY`; empty means None)
  - `data_dir: Path` (`SPEECH_DATA_DIR`, default `~/.max-speech`)
  - `profile: str | None` (`SPEECH_PROFILE`: `cuda`, `mlx` or `cpu`; anything else raises `ValueError` naming the
    allowed values)
  - `stt_engine: str | None`, `tts_engine: str | None`, `stt_model: str | None`, `tts_model: str | None`
    (`SPEECH_STT_ENGINE`, `SPEECH_TTS_ENGINE`, `SPEECH_STT_MODEL`, `SPEECH_TTS_MODEL`)
- `models_dir` property = `data_dir / "models"`.

**`profile.py`:** `detect_profile() -> Literal["cuda","mlx","cpu"]`:

- `cuda` when `onnxruntime.get_available_providers()` includes `CUDAExecutionProvider`, or `ctranslate2`
  reports CUDA devices > 0 (import lazily, catch every failure).
- Else `mlx` when `sys.platform == "darwin"` and `platform.machine() == "arm64"`.
- Else `cpu`.
- `resolve_profile(settings)` returns `settings.profile` or `detect_profile()`.

**Tests:**

- Defaults; each env var parsed; a bad profile raises; an empty `SPEECH_API_KEY` is None.
- Profile detection, with monkeypatched `sys.platform`, `platform.machine` and a fake onnxruntime module.

- [ ] Write the failing tests
- [ ] Implement
- [ ] `cd speech-server && uv run pytest -q` and `uv run ruff check .` both pass

---

### Task 2: License registry and model downloads

**Files:**

- Create: `speech-server/src/max_speech/licenses/__init__.py`, `speech-server/src/max_speech/licenses/registry.toml`
- Create: `speech-server/src/max_speech/models.py`
- Create: `speech-server/tests/test_licenses.py`, `speech-server/tests/test_models.py`
- Package data: make sure hatch includes `registry.toml` (it does by default inside the package; verify with a test
  that loads it via `importlib.resources`).

**Registry format:**

```toml
# Every model Max Speech may load. Read each license where `license_url` points, on `checked`.
# Weights licenses must be in ALLOWED_WEIGHTS_LICENSES (licenses/__init__.py); a model without an entry never loads.

[models."kokoro-v1.0"]
kind = "tts"
source = "url"                       # "hf" or "url"
files = [
  { url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx", sha256 = "…" },
  { url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin", sha256 = "…" },
]
weights_license = "Apache-2.0"
code_license = "MIT"                 # kokoro-onnx
runtime_licenses = ["GPL-3.0-or-later (phonemizer, espeak-ng; separate process-local libraries)"]
license_url = "https://huggingface.co/hexgrad/Kokoro-82M"
checked = "2026-11-20"
attribution = "Kokoro-82M by hexgrad, Apache-2.0"

[models."faster-whisper-small"]
kind = "stt"
source = "hf"
repo = "Systran/faster-whisper-small"
revision = "<40-char commit sha>"
weights_license = "MIT"
...
```

**Entries to create.** Fill in the real sha256 and HF commit SHAs. Get SHAs from the HF API:
`https://huggingface.co/api/models/<repo>` → `sha`. Get the license from the card's metadata `license`. Hashes for
the GitHub release assets are in the release API's `digest` field:
`https://api.github.com/repos/thewh1teagle/kokoro-onnx/releases/tags/model-files-v1.0`.

| Id                              | Source                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kokoro-v1.0`                   | `kokoro-v1.0.onnx` + `voices-v1.0.bin` from release `model-files-v1.0`                                                                                                   |
| `faster-whisper-small`          | `Systran/faster-whisper-small`                                                                                                                                           |
| `faster-whisper-large-v3-turbo` | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (if its card license is not MIT or Apache-2.0, use `deepdml/faster-whisper-large-v3-turbo-ct2` and say so in your report) |
| `mlx-whisper-large-v3-turbo`    | `mlx-community/whisper-large-v3-turbo`                                                                                                                                   |

The Whisper conversions inherit OpenAI's MIT weights. If a conversion's card states no license, set
`weights_license` to the upstream's (`MIT`) and add `note = "conversion card states no license; upstream openai/whisper-large-v3-turbo is MIT"`.

**`licenses/__init__.py`:**

- `ALLOWED_WEIGHTS_LICENSES = frozenset({"Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-4.0", "CC0-1.0"})`.
- A frozen dataclass `ModelEntry` (all fields above; `files: tuple[RemoteFile, ...]`; `repo` and `revision` are
  optional).
- `load_registry(text: str | None = None) -> dict[str, ModelEntry]`. It validates:
  - `kind` is `stt`, `tts`, `vad` or `turn`.
  - An `hf` source has `repo` and a 40-hex `revision`.
  - A `url` source has files that each carry a 64-hex `sha256`.
  - `checked` is an ISO date.
  - Anything else raises `RegistryError` naming the model and the field.
- `require(model_id: str, kind: str) -> ModelEntry` raises `LicenseError`:
  - Unknown id: `"<id> is not in the license registry; add it to licenses/registry.toml after reading its license"`.
  - License not allowed: names the license and the allowlist.
  - Wrong kind: says so.

**`models.py`:** `ensure_model(entry: ModelEntry, models_dir: Path, *, progress=None) -> Path`.

- `hf`: `huggingface_hub.snapshot_download(repo_id, revision=entry.revision, local_dir=models_dir / id)`. Return
  that dir.
- `url`: download each file with httpx (streamed, follow redirects) to `models_dir/id/<basename>.part`, verify
  sha256, then rename. If an existing file already matches, skip it. If the hash mismatches, delete the part file
  and raise `ModelDownloadError`.
- It never downloads anything that did not come from `require()`. The signature takes a `ModelEntry`, so callers
  must have gone through the registry.

**Tests:**

- The registry shipped in the package loads, and every entry passes `require`.
- Bad TOML fixtures raise `RegistryError`, one per rule above.
- An NC license is refused.
- An unknown id is refused with the exact message.
- A `url` download goes through `httpx.MockTransport` (inject the client via a keyword param `client=`): the hash
  matches, the hash mismatches, and a file that already exists is skipped.
- `hf` monkeypatches `snapshot_download` and checks it receives the pinned revision.

- [ ] Failing tests → implement → `uv run pytest -q` and `uv run ruff check .` pass

---

### Task 3: Audio utilities, sentence chunker, engine interfaces, fakes

**Files:**

- Create: `speech-server/src/max_speech/audio.py`, `speech-server/src/max_speech/chunker.py`
- Create: `speech-server/src/max_speech/engines/__init__.py`, `speech-server/src/max_speech/engines/base.py`,
  `speech-server/src/max_speech/engines/fake.py`
- Create: `speech-server/tests/test_audio.py`, `speech-server/tests/test_chunker.py`, `speech-server/tests/test_fake_engines.py`

**`audio.py`** (numpy only):

- `OUTPUT_RATE = 24_000`, `INPUT_RATE = 16_000`.
- `float_to_pcm16(x: np.ndarray) -> bytes`: clip to [-1, 1], little-endian int16.
- `pcm16_to_float(b: bytes) -> np.ndarray`: float32.
- `resample(x, src_rate, dst_rate) -> np.ndarray`: linear interpolation is acceptable; return x unchanged when the
  rates are equal.
- `wav_bytes(pcm16: bytes, rate: int) -> bytes`: a canonical 44-byte RIFF header, mono 16-bit.
- `decode_audio(data: bytes) -> tuple[np.ndarray, int]`: reads WAV, FLAC or OGG through soundfile, mixes down to
  mono float32. Raises `AudioDecodeError("could not read the audio file; send WAV, FLAC or OGG")` on failure.

**`chunker.py`:** `split_sentences(text: str) -> list[str]` and a streaming `SentenceChunker` with
`push(delta) -> list[str]` and `flush() -> list[str]`. Rules:

- Break after `。！？；!?;` and newlines at once.
- Break after `.` only when followed by whitespace or end of text, and **not** after:
  - known abbreviations, case-insensitive: `mr mrs ms dr prof sr jr st vs etc e.g i.e a.m p.m no fig approx inc ltd
co`
  - a single uppercase letter (an initial, as in "J. Smith")
  - a number followed by a digit (decimals never have whitespace, so this is already handled; include a test)
- No break inside URLs or emails (`example.com/a.b`, `a.b@c.d`).
- Ellipsis `...` or `…` followed by whitespace and an uppercase letter or CJK character is a break.
- Strip the result; drop empty chunks.
- `first_chunk_min_words` is out of scope (milestone 2).

The fixture table in `test_chunker.py` is the contract. At least 20 cases, Chinese and English, including:

- `"Dr. Smith is here. He waits."` → 2 chunks.
- `"It costs 3.5 dollars."` → 1 chunk.
- `"See example.com. Then call."` → 2 chunks.
- `"你好。今天天气不错！"` → 2 chunks.
- Mixed `"OK。Next one."` → 2 chunks.
- Streaming: feeding the same texts one character at a time through `SentenceChunker` gives the same chunks as
  `split_sentences`.

**`engines/base.py`:**

```python
@dataclass(frozen=True)
class VoiceInfo:
    id: str            # what clients send as `voice`
    name: str
    languages: tuple[str, ...]   # BCP-47 primary tags, e.g. ("en",) or ("zh",)
    gender: Literal["female", "male", "neutral"]

@dataclass(frozen=True)
class Transcript:
    text: str
    language: str | None
    duration_s: float
    segments: tuple[tuple[float, float, str], ...] = ()   # (start, end, text) for verbose_json

class TtsEngine(Protocol):
    id: str                 # engine id, e.g. "kokoro"
    model_id: str           # registry id, e.g. "kokoro-v1.0"
    sample_rate: int        # native rate; callers resample to 24 kHz
    def voices(self) -> list[VoiceInfo]: ...
    def default_voice(self, gender: str = "female", language: str | None = None) -> str: ...
    def synthesize(self, text: str, voice: str, *, speed: float = 1.0, language: str | None = None) -> Iterator[np.ndarray]: ...
    def warm_up(self) -> None: ...

class SttEngine(Protocol):
    id: str
    model_id: str
    def transcribe(self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None) -> Transcript: ...
    def warm_up(self) -> None: ...

class UnknownVoiceError(ValueError): ...
```

`synthesize` yields float32 mono chunks at `sample_rate`, one or more per sentence. It raises `UnknownVoiceError`
for an unknown voice.

**`engines/fake.py`:**

- `FakeTts`: voices `alpha` (en, female) and `bravo` (zh, male), `sample_rate = 22050`. For each sentence from
  `split_sentences(text)` it yields 0.1 s of a 440 Hz sine per word or CJK char.
- `FakeStt`: returns `Transcript(text=f"heard {duration:.1f}s", …)`, or the `prompt` if it is set and equals
  `"echo"` (lets tests check prompt plumbing).

**Tests:**

- Audio: round trips; the WAV header parses with soundfile; resampling 22050→24000 has the right length; garbage
  bytes raise `AudioDecodeError`.
- Chunker fixtures.
- Fake engines behave as described.

- [ ] Failing tests → implement → pytest and ruff pass

---

### Task 4: HTTP API: OpenAI-compatible routes, errors, auth, discovery

**Files:**

- Create: `speech-server/src/max_speech/app.py`
- Create: `speech-server/src/max_speech/api/__init__.py`, `speech-server/src/max_speech/api/errors.py`,
  `speech-server/src/max_speech/api/auth.py`, `speech-server/src/max_speech/api/openai_routes.py`,
  `speech-server/src/max_speech/api/discovery.py`
- Create: `speech-server/tests/test_api_contract.py` (official `openai` SDK), `speech-server/tests/test_api_http.py`
  (raw httpx), `speech-server/tests/test_auth.py`

**`app.py`:** `create_app(settings: Settings, *, stt: SttEngine | None, tts: TtsEngine | None, profile: str,
ready: threading.Event | None = None) -> FastAPI`.

- Engines are injected (tests pass fakes).
- `ready` unset means `/v1/*` returns 503 `{"error":{"code":"loading","type":"server_error","message":"models are still loading"}}`.
  None means ready.
- `GET /healthz` → `{"ok": true, "ready": bool}`, no auth.

**Auth (`api/auth.py`):** a dependency on every `/v1/*` route.

- If `settings.api_key` is set: require `Authorization: Bearer <key>` (constant-time compare) → 401
  `invalid_api_key`.
- If unset: allow only loopback clients (`127.0.0.0/8`, `::1`, and `testclient` for Starlette's test client) → 401
  `{"code":"api_key_required","message":"set SPEECH_API_KEY to accept connections from other machines"}`.

**Errors (`api/errors.py`):** an `OpenAIError(status, message, *, type="invalid_request_error", param=None, code=None)`
exception plus handlers.

- `RequestValidationError` → 400 with `param` set to the first failing field.
- Unhandled exceptions → 500 `server_error` with a generic message. Log the traceback, never return it.

**Routes (`api/openai_routes.py`, prefix `/v1`):**

`POST /v1/audio/speech`, JSON body:

- `model`: str. Any value is accepted; it is served by the active TTS engine. Max sends `kokoro`, other clients send
  `tts-1`, and this is more forgiving than strict matching on purpose.
- `input`: str, 1–4096 chars after strip; otherwise 400, `param="input"`.
- `voice`: str. Resolved in this order: an exact engine voice id; then the OpenAI names `alloy`, `nova`, `shimmer`,
  `coral`, `sage` mapped to `default_voice("female")` and `onyx`, `echo`, `ash`, `ballad`, `fable`, `verse` mapped to
  `default_voice("male")`; then `"default"`. Anything else → 404 `voice_not_found`, listing up to 10 valid ids in
  the message.
- `response_format`: `pcm` or `wav`, default `wav` (differs from OpenAI's mp3 default, because we do not encode mp3).
  `mp3`, `opus`, `aac` or `flac` → 400 `unsupported_response_format`:
  `"Max Speech returns uncompressed audio; request 'pcm' or 'wav'"`.
- `speed`: 0.25–4.0, default 1.0.
- `stream_format`: `audio` or `sse`, optional.
- Optional extension `language`.

The response:

- **Without `stream_format`:** synthesize everything, resample to 24 kHz, and return `audio/pcm` or `audio/wav`.
- **`stream_format=audio`** (only with `pcm`; with `wav` → 400): a `StreamingResponse` of raw 24 kHz PCM16, sending
  each engine chunk as soon as it is resampled.
- **`stream_format=sse`:** `text/event-stream` with `data: {"type":"speech.audio.delta","audio":"<base64 pcm16>"}`
  per chunk, then `data: {"type":"speech.audio.done"}`. On an error after the first chunk, send
  `data: {"type":"error","error":{…}}` and end.
- Synthesis runs in a worker thread (`starlette.concurrency.iterate_in_threadpool` or `run_in_threadpool`), so the
  event loop never blocks. A `threading.Lock` per engine serializes inference.
- Header `X-Max-Speech-Engine: <engine id>`.

`POST /v1/audio/transcriptions`, multipart:

- `file` (required), `model` (any value is accepted and served by the active STT), `language`, `prompt`,
  `response_format` (`json` default, `text`, `verbose_json`; `srt` or `vtt` → 400), `temperature` (accepted, ignored).
- Decode with `decode_audio` (on error, 400 `invalid_audio`), resample to 16 kHz, transcribe in the threadpool.
- `json` → `{"text": …}`. `text` → plain text. `verbose_json` →
  `{"task":"transcribe","language","duration","text","segments":[{"id","start","end","text"}]}`.
- Upload limit 25 MB → 413 `file_too_large`.

`GET /v1/models`: `{"object":"list","data":[{"id","object":"model","owned_by":"max-speech"}]}`, listing the active
engines' ids plus the aliases `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `whisper-1`, `gpt-4o-transcribe`.
`GET /v1/models/{id}` returns one of them or 404 `model_not_found`.

`GET /v1/audio/voices`: `{"voices":[{"id","name","languages","gender"}]}`.

If the STT or TTS engine is None (disabled), its routes return 503 `{"code":"engine_disabled"}`.

**Discovery (`api/discovery.py`):** `GET /.well-known/max-speech` (no auth; it contains no secrets) →

```json
{
  "protocol": "max-speech.v1",
  "version": "0.1.0",
  "profile": "mlx",
  "ready": true,
  "engines": {
    "stt": { "id": "whisper-mlx", "model": "mlx-whisper-large-v3-turbo" },
    "tts": { "id": "kokoro", "model": "kokoro-v1.0" }
  },
  "features": {
    "openai_compatible": true,
    "streaming_tts": true,
    "session_ws": false,
    "cloning": false,
    "voice_design": false
  },
  "attributions": [
    { "model": "kokoro-v1.0", "weights_license": "Apache-2.0", "text": "Kokoro-82M by hexgrad, Apache-2.0" }
  ]
}
```

Attributions come from the registry entries of the active engines' `model_id`. Fake engines (model id `fake-*`) are
skipped.

**Contract tests** (`test_api_contract.py`) drive the app through the official SDK:
`AsyncOpenAI(base_url="http://test/v1", api_key="k", http_client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app)))`,
with `settings.api_key="k"` and fake engines. They cover:

- `audio.speech.create(response_format="wav")` returns a parseable 24 kHz WAV.
- `with_streaming_response.create(response_format="pcm", extra_body={"stream_format":"audio"})` yields several chunks.
- `audio.transcriptions.create(file=…, model="whisper-1")` returns text, and `response_format="verbose_json"`
  returns segments.
- `models.list()` works.
- A wrong key raises `openai.AuthenticationError`, an unknown voice raises `openai.NotFoundError`, and `mp3` raises
  `openai.BadRequestError` whose message mentions `pcm`.

**Also, in `test_api_http.py`, replay the exact requests Max's relay sends** (see
`server/providers/live/pipeline.ts`, `transcribe()` and `synthesize()`):

- Speech: `{"model":"kokoro","voice":"af_heart","input":…,"response_format":"wav"}`. Use a fake voice id instead of
  `af_heart`.
- Transcription: multipart with `model=Systran/faster-whisper-small`, `response_format=json`, `language=zh`,
  `prompt="Max, 导航"`. It must return 200 with `{"text": …}`.

Also test: SSE framing, 503 while not ready, `engine_disabled`, the 413 limit (use a patched small limit), and that
a transcription request reaches the engine with the `language` and `prompt` it was sent.

- [ ] Failing tests → implement → pytest and ruff pass

---

### Task 5: Real engines, engine selection, CLI

**Files:**

- Create: `speech-server/src/max_speech/engines/kokoro.py`, `speech-server/src/max_speech/engines/whisper_ct2.py`,
  `speech-server/src/max_speech/engines/whisper_mlx.py`, `speech-server/src/max_speech/engines/select.py`
- Replace: `speech-server/src/max_speech/cli.py`
- Create: `speech-server/tests/test_select.py`, `speech-server/tests/test_cli.py`,
  `speech-server/tests/test_engines_real.py` (all `@pytest.mark.models`)

**Defaults per profile (`select.py`):**

| Profile | STT engine / registry model                                            | TTS engine / registry model                                              |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `cuda`  | `whisper-ct2` / `faster-whisper-large-v3-turbo` (device cuda, float16) | `kokoro` / `kokoro-v1.0` (onnxruntime CUDA provider when available)      |
| `mlx`   | `whisper-mlx` / `mlx-whisper-large-v3-turbo`                           | `kokoro` / `kokoro-v1.0` (CPU onnxruntime; fast enough on Apple Silicon) |
| `cpu`   | `whisper-ct2` / `faster-whisper-small` (cpu, int8)                     | `kokoro` / `kokoro-v1.0`                                                 |

- `SPEECH_STT_ENGINE`, `SPEECH_TTS_ENGINE`, `SPEECH_STT_MODEL` and `SPEECH_TTS_MODEL` override these. The value
  `off` disables a role.
- The model always goes through `licenses.require(model_id, kind)` before `ensure_model`.
- `build_engines(settings, profile) -> tuple[SttEngine|None, TtsEngine|None]`. Engines are constructed lazily: the
  heavy imports happen inside the engine modules, so `select.py` imports nothing heavy at module level.
- `test_select.py` monkeypatches the engine constructors and `ensure_model`, and checks:
  - The defaults per profile.
  - The overrides, and `off`.
  - An unregistered `SPEECH_STT_MODEL` raises `LicenseError` before any download.

**`kokoro.py`** (`kokoro_onnx.Kokoro(model_path, voices_path)`):

- `sample_rate = 24000`.
- `voices()` from `Kokoro.get_voices()`. Language comes from the voice id's first letter:
  - `a`, `b` → en
  - `e` → es, `f` → fr, `h` → hi, `i` → it, `j` → ja, `p` → pt, `z` → zh
  - Gender from the second letter (`f` or `m`).
- `kokoro_onnx` `lang` codes: `a` → `en-us`, `b` → `en-gb`, `e` → `es`, `f` → `fr-fr`, `h` → `hi`, `i` → `it`,
  `j` → `ja`, `p` → `pt-br`, `z` → `cmn`.
- `default_voice`:
  - female: `af_heart` for en, `zf_xiaobei` for zh
  - male: `am_michael` for en, `zm_yunjian` for zh
  - Fall back to the first voice of that gender.
- `synthesize`: for each sentence from `split_sentences`, call `create(sentence, voice=…, speed=…, lang=…)` and
  yield the samples, so the first sentence is out before the rest are synthesized. The language is the voice's
  unless `language` is given.

**`whisper_ct2.py`** (faster-whisper):

- `WhisperModel(model_dir, device=…, compute_type=…)`.
- `transcribe`: `beam_size=1`, `vad_filter=False`; pass `language` and `prompt` (as `initial_prompt`). Join the
  segment texts and strip.

**`whisper_mlx.py`:** `mlx_whisper.transcribe(audio, path_or_hf_repo=str(model_dir), language=…, initial_prompt=…)`.

Each engine's `warm_up()` runs one tiny inference: a 0.5 s silence transcription, or synthesizing "Ready." in the
default voice.

**`cli.py`** (argparse):

- `max-speech serve [--host] [--port] [--profile]`:
  1. Resolve settings and profile.
  2. Start uvicorn at once with `ready` unset.
  3. In a background thread: `build_engines` (downloads, logging progress), warm up, set the engines on the app,
     then set `ready`.
  4. On failure, log the error and keep serving 503 with the message, rather than exiting. The relay then shows a
     readable error.
- `max-speech download [--profile]`: ensures the profile's default models and exits.
- `max-speech engines`: prints the resolved profile, engine and model per role, and the license of each.

`create_app` must therefore accept engines set later: hold them in a mutable `EngineSlots` object in `app.state`.
Adjust Task 4's `create_app` signature if needed, keeping its tests green.

`test_cli.py`: `engines` prints with monkeypatched detection; `serve` wiring is tested by calling the internal
`_load_engines(app_state, settings, profile)` with fakes. No sockets.

**`test_engines_real.py`** (`models` marker, run locally with `MAX_SPEECH_MODEL_TESTS=1`):

- Kokoro synthesizes "Hello there. How are you?" in `af_heart`: at least 2 chunks, more than 0.5 s total.
- Whisper (the engine for this machine's profile) transcribes that audio, resampled to 16 kHz, to text containing
  "hello", case-insensitive.
- Kokoro zh `zf_xiaobei` synthesizes "你好，今天天气很好。" without error.

- [ ] Failing tests → implement → default pytest and ruff pass → `MAX_SPEECH_MODEL_TESTS=1 uv run --extra mlx pytest -q -m models` passes on this Mac

---

### Task 6: Latency benchmark

**Files:**

- Create: `speech-server/bench/__init__.py`, `speech-server/bench/latency.py`, `speech-server/bench/README.md`
- Create: `speech-server/tests/test_bench.py`

`python -m bench.latency --base-url http://localhost:8790/v1 [--api-key …] [--voice …] [--tts-model …] [--stt-model …] [--runs 5] [--fixtures DIR] [--json out.json]`.

- **TTS:** for each phrase in a built-in list (5 en, 5 zh, short and long), POST `/audio/speech` with `pcm` and
  `stream_format=audio`, and measure:
  - time to first byte
  - total time
  - audio seconds, from bytes / 48000
  - real-time factor
- If the server ignores `stream_format` (the old Kokoro-FastAPI), the time to first byte simply equals the total;
  report it as is.
- **STT:** for each WAV in `--fixtures`, or when there are none, the TTS output of the phrases synthesized in the
  previous step (saved, then sent back), POST `/audio/transcriptions` and measure the latency. When the phrase
  text is known, report the word error rate (en) or character error rate (zh).
- Print a table of p50 and p95 per metric, and optionally write JSON.
- Only httpx and numpy; no SDK.

`test_bench.py` runs the benchmark functions against the app with fake engines via `httpx.ASGITransport`, and checks
the metric computation (time to first byte is at most the total, WER is 0 for an exact match, CER for Chinese).

- [ ] Failing tests → implement → pytest and ruff pass

---

### Task 7: Docs and CI

**Files:**

- Modify: `speech-server/README.md` (full): what it is; quick start on a Mac (`uv sync --extra mlx`,
  `uv run max-speech serve`); quick start on Linux; env vars table; endpoints; the license registry and how to add
  a model; benchmark usage; tests.
- Modify: `docs/local-models.md`: a new section "Max Speech (our own speech server)" near the top, with the env lines
  that point the `local` pipeline at it (`LOCAL_STT_BASE_URL`, `LOCAL_TTS_BASE_URL` = `http://localhost:8790/v1`,
  `LOCAL_TTS_FORMAT=pcm`). Say plainly what milestone 1 does and does not do yet (no streaming STT, turn-taking or
  cloning; those come later).
- Modify: `.github/workflows/ci.yml`: add a job `speech-server`:
  - ubuntu-latest, `astral-sh/setup-uv` (pin a major version, as the other actions do)
  - `uv sync --frozen` then `uv run pytest -q` and `uv run ruff check .` in `speech-server/`
  - `timeout-minutes: 10`
- Modify: `.gitignore`: `speech-server/.venv/` is already covered by `.venv/`; add `speech-server/bench/out/`.

- [ ] Edit → verify CI YAML parses (`python3 -c "import yaml…"` or `npx js-yaml`) → `npm run format:check` passes on
      changed markdown (run `npx prettier --write` on the changed .md files if the repo formats markdown)

---

## Done when

- `npm run test:speech` passes; ruff is clean.
- `MAX_SPEECH_MODEL_TESTS=1` real-model tests pass on this Mac.
- With `uv run max-speech serve` running, Max's relay runs with `VOICE_PROVIDER=local` and the two `LOCAL_*_BASE_URL`
  lines pointed at port 8790, plus Ollama for the chat model. A typed and a spoken turn both get a spoken reply.
  This is checked by hand by the lead.
- The benchmark has run against Max Speech on this Mac, and the numbers are in the milestone report.
