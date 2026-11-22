import base64
import io
import json
import wave

import httpx
import numpy as np
import soundfile as sf

from max_speech.api import openai_routes
from max_speech.engines.base import Transcript
from max_speech.engines.fake import FakeTts
from max_speech.settings import Settings


def client(app, **kw):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://localhost", **kw
    )


def wav_16k(seconds=1.0) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(16000 * seconds), dtype=np.float32), 16000, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def error(r):
    return r.json()["error"]


async def test_relay_speech_request(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/speech",
            json={
                "model": "kokoro",
                "voice": "alpha",
                "input": "Hello there. Second one.",
                "response_format": "wav",
            },
        )
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-max-speech-engine"] == "fake"
    with wave.open(io.BytesIO(r.content)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24000, 1, 2)
        assert w.getnframes() == round(0.2 * 24000) + round(0.2 * 24000)


async def test_relay_pcm_default_format_request(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/speech",
            json={"model": "kokoro", "voice": "alpha", "input": "one two", "response_format": "pcm"},
        )
    assert r.headers["content-type"] == "audio/pcm"
    assert len(r.content) == round(0.2 * 24000) * 2


async def test_relay_transcription_request_reaches_engine(make_app):
    seen = {}

    class Spy:
        id = "spy"
        model_id = "fake-spy"

        def transcribe(self, audio, rate, *, language=None, prompt=None):
            seen.update(rate=rate, language=language, prompt=prompt, n=len(audio))
            return Transcript(text="你好", language=language, duration_s=len(audio) / rate)

        def warm_up(self):
            pass

    async with client(make_app(stt=Spy())) as c:
        r = await c.post(
            "/v1/audio/transcriptions",
            data={
                "model": "Systran/faster-whisper-small",
                "response_format": "json",
                "language": "zh",
                "prompt": "Max, 导航",
            },
            files={"file": ("speech.wav", wav_16k(), "audio/wav")},
        )
    assert r.status_code == 200
    assert r.json() == {"text": "你好"}
    assert seen == {"rate": 16000, "language": "zh", "prompt": "Max, 导航", "n": 16000}


async def test_transcription_resamples_to_16k(make_app):
    buf = io.BytesIO()
    sf.write(buf, np.zeros(48000, dtype=np.float32), 48000, format="WAV")
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/transcriptions", files={"file": ("a.wav", buf.getvalue())}, data={"model": "whisper-1"}
        )
    assert r.json() == {"text": "heard 1.0s"}


async def test_transcription_formats(make_app):
    async with client(make_app()) as c:
        f = {"file": ("a.wav", wav_16k(2.0), "audio/wav")}
        text = await c.post("/v1/audio/transcriptions", files=f, data={"response_format": "text"})
        assert text.headers["content-type"].startswith("text/plain")
        assert text.text == "heard 2.0s"
        verbose = await c.post("/v1/audio/transcriptions", files=f, data={"response_format": "verbose_json"})
        body = verbose.json()
        assert body["task"] == "transcribe" and body["text"] == "heard 2.0s"
        assert body["duration"] == 2.0 and body["segments"] == []
        srt = await c.post("/v1/audio/transcriptions", files=f, data={"response_format": "srt"})
        assert srt.status_code == 400 and error(srt)["param"] == "response_format"


async def test_verbose_json_segments(make_app):
    class Seg:
        id = "seg"
        model_id = "fake-seg"

        def transcribe(self, audio, rate, *, language=None, prompt=None):
            return Transcript("a b", "en", 1.0, ((0.0, 0.5, "a"), (0.5, 1.0, "b")))

        def warm_up(self):
            pass

    async with client(make_app(stt=Seg())) as c:
        r = await c.post(
            "/v1/audio/transcriptions",
            files={"file": ("a.wav", wav_16k())},
            data={"response_format": "verbose_json"},
        )
    assert r.json()["segments"] == [
        {"id": 0, "start": 0.0, "end": 0.5, "text": "a"},
        {"id": 1, "start": 0.5, "end": 1.0, "text": "b"},
    ]
    assert r.json()["language"] == "en"


async def test_invalid_audio_and_missing_file(make_app):
    async with client(make_app()) as c:
        bad = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", b"not audio")})
        assert bad.status_code == 400 and error(bad)["code"] == "invalid_audio"
        missing = await c.post("/v1/audio/transcriptions", data={"model": "x"})
        assert missing.status_code == 400 and error(missing)["param"] == "file"


async def test_upload_limit(make_app, monkeypatch):
    monkeypatch.setattr(openai_routes, "MAX_UPLOAD_BYTES", 1000)
    async with client(make_app()) as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav_16k())})
    assert r.status_code == 413 and error(r)["code"] == "file_too_large"


async def test_sse_framing(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/speech",
            json={
                "input": "one two. three four.",
                "voice": "alpha",
                "response_format": "pcm",
                "stream_format": "sse",
            },
        )
    assert r.headers["content-type"].startswith("text/event-stream")
    events = [json.loads(b[len("data: ") :]) for b in r.text.strip().split("\n\n")]
    assert [e["type"] for e in events] == ["speech.audio.delta", "speech.audio.delta", "speech.audio.done"]
    assert all(len(base64.b64decode(e["audio"])) == round(0.2 * 24000) * 2 for e in events[:2])


async def test_sse_error_after_first_chunk(make_app):
    class Boom(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            gen = super().synthesize(text, voice)
            yield next(gen)
            raise RuntimeError("secret detail")

    async with client(make_app(tts=Boom())) as c:
        r = await c.post(
            "/v1/audio/speech",
            json={"input": "one. two.", "voice": "alpha", "stream_format": "sse", "response_format": "pcm"},
        )
    events = [json.loads(b[len("data: ") :]) for b in r.text.strip().split("\n\n")]
    assert [e["type"] for e in events] == ["speech.audio.delta", "error"]
    assert "secret" not in r.text and events[1]["error"]["type"] == "server_error"


async def test_stream_audio_chunks(make_app):
    async with (
        client(make_app()) as c,
        c.stream(
            "POST",
            "/v1/audio/speech",
            json={
                "input": "one. two. three.",
                "voice": "alpha",
                "response_format": "pcm",
                "stream_format": "audio",
            },
        ) as r,
    ):
        chunks = [x async for x in r.aiter_raw()]
    assert sum(map(len, chunks)) == 3 * round(0.1 * 24000) * 2


async def test_stream_audio_requires_pcm(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/speech", json={"input": "hi", "stream_format": "audio", "response_format": "wav"}
        )
        assert r.status_code == 400 and error(r)["param"] == "stream_format"
        default = await c.post("/v1/audio/speech", json={"input": "hi", "stream_format": "audio"})
        assert default.status_code == 400


async def test_speech_validation(make_app):
    async with client(make_app()) as c:
        empty = await c.post("/v1/audio/speech", json={"input": "   "})
        assert empty.status_code == 400 and error(empty)["param"] == "input"
        long = await c.post("/v1/audio/speech", json={"input": "a" * 4097})
        assert long.status_code == 400 and error(long)["param"] == "input"
        speed = await c.post("/v1/audio/speech", json={"input": "a", "speed": 5})
        assert speed.status_code == 400 and error(speed)["param"] == "speed"
        mp3 = await c.post("/v1/audio/speech", json={"input": "a", "response_format": "mp3"})
        assert error(mp3)["code"] == "unsupported_response_format" and "pcm" in error(mp3)["message"]
        junk = await c.post("/v1/audio/speech", content=b"{", headers={"content-type": "application/json"})
        assert junk.status_code == 400
        e = error(empty)
        assert set(e) == {"message", "type", "param", "code"}


async def test_voice_resolution(make_app):
    seen = []

    class Spy(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            seen.append((voice, speed, language))
            return super().synthesize(text, voice)

    async with client(make_app(tts=Spy())) as c:
        for v in ("bravo", "nova", "onyx", "default"):
            r = await c.post(
                "/v1/audio/speech", json={"input": "hi", "voice": v, "language": "zh", "speed": 1.5}
            )
            assert r.status_code == 200
        missing = await c.post("/v1/audio/speech", json={"input": "hi", "voice": "nope"})
    assert [s[0] for s in seen] == ["bravo", "alpha", "bravo", "alpha"]
    assert seen[0][1:] == (1.5, "zh")
    assert missing.status_code == 404 and error(missing)["code"] == "voice_not_found"
    assert "alpha" in error(missing)["message"]


async def test_models_voices_and_discovery(make_app):
    async with client(make_app()) as c:
        models = (await c.get("/v1/models")).json()
        ids = {m["id"] for m in models["data"]}
        assert {"fake", "tts-1", "tts-1-hd", "gpt-4o-mini-tts", "whisper-1", "gpt-4o-transcribe"} <= ids
        assert models["object"] == "list" and len(ids) == len(models["data"])
        one = await c.get("/v1/models/whisper-1")
        assert one.json()["owned_by"] == "max-speech"
        assert (await c.get("/v1/models/nope")).status_code == 404
        assert error(await c.get("/v1/models/nope"))["code"] == "model_not_found"
        voices = (await c.get("/v1/audio/voices")).json()["voices"]
        assert voices[0] == {"id": "alpha", "name": "Alpha", "languages": ["en"], "gender": "female"}
        d = (await c.get("/.well-known/max-speech")).json()
        assert d["protocol"] == "max-speech.v1" and d["ready"] is True and d["profile"] == "cpu"
        assert d["engines"] == {
            "stt": {"id": "fake", "model": "fake-stt"},
            "tts": {"id": "fake", "model": "fake-tts"},
        }
        assert d["attributions"] == []
        assert d["features"]["streaming_tts"] is True and d["features"]["session_ws"] is False


async def test_discovery_attributions_from_registry(make_app):
    class Kokoro(FakeTts):
        id = "kokoro"
        model_id = "kokoro-v1.0"

    async with client(make_app(tts=Kokoro())) as c:
        d = (await c.get("/.well-known/max-speech")).json()
    assert d["attributions"][0]["model"] == "kokoro-v1.0"
    assert d["attributions"][0]["weights_license"] == "Apache-2.0"
    assert "Kokoro" in d["attributions"][0]["text"]


async def test_discovery_session_ws_needs_every_live_engine(make_app):
    class Named:
        def __init__(self, model_id):
            self.id, self.model_id = "x", model_id

    def features(**live):
        app = make_app()
        for name, value in live.items():
            setattr(app.state.slots, name, value)
        return app

    full = {
        "vad": Named("silero-vad-v6.2"),
        "turn": Named("smart-turn-v3.2"),
        "stt_stream": Named("x-asr-zh-en-480ms"),
    }
    async with client(features(**full)) as c:
        d = (await c.get("/.well-known/max-speech")).json()
    assert d["features"]["session_ws"] is True
    assert [a["model"] for a in d["attributions"]] == [
        "silero-vad-v6.2",
        "smart-turn-v3.2",
        "x-asr-zh-en-480ms",
    ]
    for missing in full:
        async with client(features(**{**full, missing: None})) as c:
            assert (await c.get("/.well-known/max-speech")).json()["features"]["session_ws"] is False
    async with client(make_app(tts=None)) as c:
        assert (await c.get("/.well-known/max-speech")).json()["features"]["session_ws"] is False


async def test_discovery_attributions_include_the_zh_model(make_app):
    class Kokoro(FakeTts):
        id = "kokoro"
        model_id = "kokoro-v1.0"
        extra_model_ids = ("kokoro-v1.1-zh",)

    async with client(make_app(tts=Kokoro())) as c:
        d = (await c.get("/.well-known/max-speech")).json()
    assert [a["model"] for a in d["attributions"]] == ["kokoro-v1.0", "kokoro-v1.1-zh"]


async def test_engine_disabled(make_app):
    async with client(make_app(stt=None, tts=None)) as c:
        for r in (
            await c.post("/v1/audio/speech", json={"input": "hi"}),
            await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav_16k())}),
            await c.get("/v1/audio/voices"),
        ):
            assert r.status_code == 503 and error(r)["code"] == "engine_disabled"
        assert (await c.get("/v1/models")).status_code == 200
        assert (await c.get("/.well-known/max-speech")).json()["engines"] == {"stt": None, "tts": None}


async def test_loading_then_ready(make_app):
    import threading

    ready = threading.Event()
    app = make_app(ready=ready)
    async with client(app) as c:
        r = await c.get("/v1/models")
        assert r.status_code == 503
        assert error(r) == {
            "message": "models are still loading",
            "type": "server_error",
            "param": None,
            "code": "loading",
        }
        assert (await c.get("/healthz")).json() == {"ok": True, "ready": False}
        assert (await c.get("/.well-known/max-speech")).json()["ready"] is False
        ready.set()
        assert (await c.get("/v1/models")).status_code == 200
        assert (await c.get("/healthz")).json() == {"ok": True, "ready": True}


async def test_engine_slots_set_after_start(make_app):
    from max_speech.engines.fake import FakeStt

    app = make_app(stt=None, tts=None, ready=__import__("threading").Event())
    slots = app.state.slots
    async with client(app) as c:
        assert (await c.get("/v1/models")).status_code == 503
        slots.tts = FakeTts()
        slots.stt = FakeStt()
        slots.mark_ready()
        assert (await c.post("/v1/audio/speech", json={"input": "hi"})).status_code == 200


async def test_load_failure_message(make_app):
    import threading

    app = make_app(ready=threading.Event())
    app.state.slots.fail("model kokoro-v1.0 failed to download")
    async with client(app) as c:
        r = await c.get("/v1/models")
    assert r.status_code == 503
    assert error(r)["message"] == "model kokoro-v1.0 failed to download"
    assert error(r)["code"] == "load_failed"


async def test_unhandled_error_is_generic(make_app):
    class Boom(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            raise RuntimeError("secret detail")

    async with client(make_app(tts=Boom())) as c:
        r = await c.post("/v1/audio/speech", json={"input": "hi", "voice": "alpha"})
    assert r.status_code == 500 and error(r)["type"] == "server_error"
    assert "secret" not in r.text


async def test_inference_does_not_block_loop_and_is_serialized(make_app):
    import threading
    import time

    active = 0
    peak = 0
    guard = threading.Lock()

    class Slow(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            time.sleep(0.15)
            with guard:
                active -= 1
            return super().synthesize(text, voice)

    import asyncio

    async with client(make_app(tts=Slow())) as c:
        t0 = time.perf_counter()
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        task = asyncio.create_task(ticker())
        rs = await asyncio.gather(*[c.post("/v1/audio/speech", json={"input": "hi"}) for _ in range(3)])
        task.cancel()
    assert all(r.status_code == 200 for r in rs)
    assert peak == 1
    assert ticks > 10  # the loop kept running while the engine slept
    assert time.perf_counter() - t0 >= 0.45


def multi_channel_wav(channels: int, rate: int, frames: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros((frames, channels), dtype=np.float32), rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


async def test_transcription_rejects_more_than_two_channels(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/transcriptions", files={"file": ("a.wav", multi_channel_wav(8, 16000, 1600))}
        )
    assert r.status_code == 400 and error(r)["code"] == "audio_too_large"


async def test_transcription_rejects_audio_that_decodes_too_large(make_app, monkeypatch):
    monkeypatch.setattr(openai_routes, "MAX_DURATION_S", 1)
    # Under the 1 s duration cap, but frames * channels (300k) exceeds 1 * 48_000 * 2.
    data = multi_channel_wav(2, 192000, 150000)  # 0.78 s, 300k samples > 96k
    async with client(make_app()) as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", data)})
    assert r.status_code == 400 and error(r)["code"] == "audio_too_large"


async def test_transcription_language_normalised(make_app):
    seen = []
    app = make_app()
    real = app.state.slots.stt.transcribe

    def spy(audio, rate, *, language=None, prompt=None):
        seen.append(language)
        return real(audio, rate, language=language, prompt=prompt)

    app.state.slots.stt.transcribe = spy
    async with client(app) as c:
        for lang in ("zh-CN", "en_US", "EN", "de"):
            r = await c.post(
                "/v1/audio/transcriptions", files={"file": ("a.wav", wav_16k())}, data={"language": lang}
            )
            assert r.status_code == 200, lang
    assert seen == ["zh", "en", "en", "de"]


async def test_transcription_unknown_language_rejected(make_app):
    async with client(make_app()) as c:
        r = await c.post(
            "/v1/audio/transcriptions", files={"file": ("a.wav", wav_16k())}, data={"language": "xx-YY"}
        )
    assert r.status_code == 400
    assert error(r)["code"] == "invalid_language" and error(r)["param"] == "language"


async def test_speech_language_normalised_and_unknown_ignored(make_app):
    seen = []

    class Spy(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            seen.append(language)
            return super().synthesize(text, voice, speed=speed, language=language)

    async with client(make_app(tts=Spy())) as c:
        for lang in ("zh-CN", "klingon", None):
            body = {"input": "hello there", "voice": "alpha"}
            if lang:
                body["language"] = lang
            assert (await c.post("/v1/audio/speech", json=body)).status_code == 200
    assert seen == ["zh", None, None]


async def test_custom_voice_works_through_speech(make_app, tmp_path):
    from voice_helpers import STATEMENT, good_wav

    from max_speech.engines.fake_cloning import FakeCloningTts
    from max_speech.settings import Settings

    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    voice = app.state.slots.voices.create(
        audio=good_wav(),
        name="Ava",
        transcript="hello there",
        consent=True,
        consent_statement=STATEMENT,
        consent_speaker="Ava Lee",
    )
    async with client(app) as c:
        r = await c.post(
            "/v1/audio/speech",
            json={"voice": voice.id, "input": "Hello there. Second one.", "response_format": "pcm"},
        )
        streamed = await c.post(
            "/v1/audio/speech",
            json={
                "voice": voice.id,
                "input": "Hello there.",
                "response_format": "pcm",
                "stream_format": "audio",
            },
        )
    assert r.status_code == 200 and r.headers["x-max-speech-engine"] == "fake-cloning"
    assert len(r.content) == 2 * round(0.2 * 24000) * 2  # cloned audio comes back at 24 kHz
    assert streamed.status_code == 200 and len(streamed.content) == round(0.2 * 24000) * 2
    assert [call[1] for call in cloning.calls] == [voice.id] * 3  # one call per sentence


async def test_healthz_reports_a_failed_load_with_503(make_app):
    import threading

    app = make_app(ready=threading.Event())
    app.state.slots.fail("ModelDownloadError: disk full")
    async with client(app) as c:
        r = await c.get("/healthz")
    assert r.status_code == 503
    assert r.json() == {"ok": False, "ready": False, "error": "ModelDownloadError: disk full"}


async def test_healthz_stays_200_while_loading_but_shows_a_retry_error(make_app):
    import threading

    app = make_app(ready=threading.Event())
    app.state.slots.retry_error = "ModelDownloadError: timeout (attempt 1 of 4, retrying in 5 s)"
    async with client(app) as c:
        r = await c.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {
        "ok": True,
        "ready": False,
        "error": "ModelDownloadError: timeout (attempt 1 of 4, retrying in 5 s)",
    }


async def test_discovery_publishes_the_live_languages_and_limits(make_app):
    class Stream:
        id, model_id = "sherpa-onnx", "x-asr-zh-en-480ms"
        languages = ("zh", "en")
        keyterms = False

    app = make_app()
    app.state.slots.stt_stream = Stream()
    async with client(app) as c:
        d = (await c.get("/.well-known/max-speech")).json()
    assert d["live"] == {
        "languages": ["zh", "en"],
        "keyterms": False,
        "max_sessions": 2,
        "idle_timeout_s": None,
    }
    app = make_app(Settings(session_idle_timeout_s=120))
    app.state.slots.stt_stream = Stream()
    async with client(app) as c:
        assert (await c.get("/.well-known/max-speech")).json()["live"]["idle_timeout_s"] == 120
    async with client(make_app()) as c:
        assert "live" not in (await c.get("/.well-known/max-speech")).json()
