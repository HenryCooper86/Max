import asyncio
import io
import json
import os
import threading
import time
import wave

import httpx
import numpy as np
import pytest
from voice_helpers import CONSENT, STATEMENT, good_wav, speech_like, wav_of

from max_speech.engines.base import Transcript, UnknownVoiceError
from max_speech.engines.fake import FakeStt, FakeTts
from max_speech.engines.fake_cloning import FakeCloningTts
from max_speech.engines.mlx_gate import MLX_GATE, stepwise
from max_speech.settings import Settings


def client(app, **kw):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://localhost", **kw
    )


@pytest.fixture
def app(make_app, tmp_path):
    return make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts())


def form(**over):
    data = {"name": "Ava", "transcript": "hello there this is me", "gender": "female", **CONSENT}
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


async def post_voice(c, wav=None, **over):
    return await c.post(
        "/v1/voices", data=form(**over), files={"audio": ("ref.wav", wav or good_wav(), "audio/wav")}
    )


def err(r):
    return r.json()["error"]


# ---- create ------------------------------------------------------------------------------------------------------------
async def test_create_returns_the_voice_with_its_consent(app, tmp_path):
    async with client(app) as c:
        r = await post_voice(c, languages="en", created_by="admin")
    assert r.status_code == 201
    v = r.json()
    assert (
        v["kind"] == "custom" and v["name"] == "Ava" and v["languages"] == ["en"] and v["gender"] == "female"
    )
    assert v["transcript_source"] == "given" and v["created_by"] == "admin" and v["duration_s"] > 7
    assert v["consent"]["statement"] == STATEMENT and v["consent"]["speaker"] == "Ava Lee"
    assert r.headers["location"] == f"/v1/voices/{v['id']}"
    assert (tmp_path / "voices" / v["id"] / "voice.json").exists()


@pytest.mark.parametrize(
    "over",
    [
        {"consent": None},
        {"consent": "false"},
        {"consent": "yes"},
        {"consent": "1"},
        {"consent_statement": None},
        {"consent_statement": "short"},
        {"consent_speaker": None},
        {"consent_speaker": "  "},
        {"consent_statement": "x" * 1001},
    ],
)
async def test_consent_is_required_by_the_route(app, tmp_path, over):
    async with client(app) as c:
        r = await post_voice(c, **over)
    assert r.status_code == 400 and err(r)["code"] == "consent_required"
    assert not (tmp_path / "voices").exists()


async def test_consent_is_checked_before_the_audio(app):
    async with client(app) as c:
        r = await c.post(
            "/v1/voices", data=form(consent=None), files={"audio": ("x.wav", b"junk", "audio/wav")}
        )
    assert err(r)["code"] == "consent_required"


async def test_consent_true_is_case_insensitive(app):
    async with client(app) as c:
        assert (await post_voice(c, consent="True")).status_code == 201


@pytest.mark.parametrize(
    ("wav", "code"),
    [
        (good_wav(4.0), "reference_too_short"),
        (good_wav(31.0), "reference_too_long"),
        (wav_of(np.zeros(24000 * 8, np.float32)), "reference_silent"),
        (
            wav_of(np.where(np.sin(np.arange(24000 * 8) / 20.0) > 0, 1.0, -1.0).astype(np.float32)),
            "reference_clipped",
        ),
        (b"not audio at all", "invalid_audio"),
    ],
)
async def test_reference_errors(app, wav, code):
    async with client(app) as c:
        r = await post_voice(c, wav=wav)
    assert r.status_code == 400 and err(r)["code"] == code and err(r)["param"] == "audio"


async def test_missing_audio(app):
    async with client(app) as c:
        r = await c.post("/v1/voices", data=form())
    assert r.status_code == 400 and err(r)["code"] == "invalid_audio"


@pytest.mark.parametrize(
    "over",
    [
        {"name": None},
        {"name": "n" * 65},
        {"gender": "robot"},
        {"languages": "english"},
        {"created_by": "c" * 129},
    ],
)
async def test_invalid_fields(app, over):
    async with client(app) as c:
        r = await post_voice(c, **over)
    assert r.status_code == 400 and err(r)["code"] == "invalid_field"


async def test_transcript_too_long(app):
    async with client(app) as c:
        r = await post_voice(c, transcript="word " * 300)
    assert r.status_code == 400 and err(r)["code"] == "invalid_field"


async def test_blank_transcript_is_transcribed_by_stt(make_app, tmp_path):
    class Echo(FakeStt):
        def transcribe(self, audio, rate, *, language=None, prompt=None):
            return Transcript(
                text=f"  heard {len(audio) / rate:.0f}s at {rate}  ", language=language, duration_s=1
            )

    app = make_app(Settings(data_dir=tmp_path), stt=Echo(), cloning=FakeCloningTts())
    async with client(app) as c:
        r = await post_voice(c, transcript="  ")
    assert r.status_code == 201
    assert r.json()["transcript"] == "heard 8s at 16000" and r.json()["transcript_source"] == "stt"


async def test_blank_transcript_without_stt_is_refused(make_app, tmp_path):
    app = make_app(Settings(data_dir=tmp_path), stt=None, cloning=FakeCloningTts())
    async with client(app) as c:
        r = await post_voice(c, transcript=None)
    assert r.status_code == 400 and err(r)["code"] == "transcript_required"


async def test_empty_stt_result_is_refused(make_app, tmp_path):
    class Mute(FakeStt):
        def transcribe(self, audio, rate, *, language=None, prompt=None):
            return Transcript(text=" ", language=None, duration_s=1)

    app = make_app(Settings(data_dir=tmp_path), stt=Mute(), cloning=FakeCloningTts())
    async with client(app) as c:
        r = await post_voice(c, transcript=None)
    assert err(r)["code"] == "transcript_required"


async def test_cloning_unavailable(make_app, tmp_path):
    app = make_app(Settings(data_dir=tmp_path))
    async with client(app) as c:
        r = await post_voice(c)
        listing = await c.get("/v1/voices")
    assert r.status_code == 409 and err(r)["code"] == "cloning_unavailable"
    assert listing.json()["cloning"] is False
    assert not (tmp_path / "voices").exists()


async def test_oversized_upload_is_rejected_by_the_middleware(app):
    async with client(app) as c:
        r = await c.post(
            "/v1/voices", data=form(), files={"audio": ("big.wav", b"\0" * (27 * 1024 * 1024), "audio/wav")}
        )
    assert r.status_code == 413 and err(r)["code"] == "file_too_large"


# ---- read, list, patch, delete -------------------------------------------------------------------------------------------
async def test_list_and_get(app):
    async with client(app) as c:
        created = (await post_voice(c)).json()
        listing = (await c.get("/v1/voices")).json()
        one = await c.get(f"/v1/voices/{created['id']}")
    assert listing["cloning"] is True
    assert [v["id"] for v in listing["voices"]] == ["alpha", "bravo", created["id"]]
    assert listing["voices"][0] == {
        "id": "alpha",
        "name": "Alpha",
        "kind": "preset",
        "languages": ["en"],
        "gender": "female",
    }
    assert listing["voices"][2] == created and one.json() == created


async def test_get_unknown_voice(app):
    async with client(app) as c:
        r = await c.get("/v1/voices/v_0000000000")
    assert r.status_code == 404 and err(r)["code"] == "voice_not_found"


@pytest.mark.parametrize(
    "bad", ["..%2F..%2Fetc", "%2e%2e", "v_ZZZZZZZZZZ", "v_0123456789%2F..", "af_heart", "x" * 500]
)
async def test_malformed_ids_are_404_for_every_route(app, tmp_path, bad):
    async with client(app) as c:
        calls = [
            c.get(f"/v1/voices/{bad}"),
            c.patch(f"/v1/voices/{bad}", json={"name": "x"}),
            c.delete(f"/v1/voices/{bad}"),
            c.get(f"/v1/voices/{bad}/reference"),
            c.post(f"/v1/voices/{bad}/preview", json={}),
        ]
        for call in calls:
            r = await call
            assert r.status_code == 404, r.text
            if r.headers["content-type"].startswith("application/json"):
                assert err(r)["code"] in ("voice_not_found", None)


async def test_traversal_cannot_delete_other_directories(app, tmp_path):
    keep = tmp_path / "voices" / "keep"
    keep.mkdir(parents=True)
    (keep / "x").write_text("1")
    async with client(app) as c:
        r = await c.delete("/v1/voices/..%2Fkeep")
    assert r.status_code == 404 and (keep / "x").exists()


async def test_patch(app):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        r = await c.patch(
            f"/v1/voices/{v['id']}",
            json={"name": "Eve", "languages": ["zh", "en"], "gender": "male", "transcript": "new words here"},
        )
        again = await c.get(f"/v1/voices/{v['id']}")
        comma = await c.patch(f"/v1/voices/{v['id']}", json={"languages": "fr,de"})
    assert r.status_code == 200
    body = r.json()
    assert (body["name"], body["languages"], body["gender"], body["transcript"]) == (
        "Eve", ["zh", "en"], "male", "new words here",
    )  # fmt: skip
    assert body["consent"] == v["consent"] and again.json() == body
    assert comma.json()["languages"] == ["fr", "de"]


@pytest.mark.parametrize(
    "body",
    [
        {"name": ""},
        {"name": "n" * 65},
        {"gender": "x"},
        {"languages": []},
        {"languages": "bad!"},
        {"transcript": " "},
    ],
)
async def test_patch_validation(app, body):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        r = await c.patch(f"/v1/voices/{v['id']}", json=body)
    assert r.status_code == 400 and err(r)["code"] == "invalid_field"


async def test_patch_cannot_touch_consent_or_other_fields(app):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        for body in ({"consent": {"speaker": "x"}}, {"created_by": "x"}, {"id": "v_0000000000"}, {"name": 5}):
            r = await c.patch(f"/v1/voices/{v['id']}", json=body)
            assert r.status_code == 400, body
        assert (await c.get(f"/v1/voices/{v['id']}")).json() == v


async def test_patch_unknown_voice(app):
    async with client(app) as c:
        r = await c.patch("/v1/voices/v_0000000000", json={"name": "x"})
    assert r.status_code == 404 and err(r)["code"] == "voice_not_found"


async def test_patch_transcript_clears_the_engine_cache(make_app, tmp_path):
    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    async with client(app) as c:
        v = (await post_voice(c)).json()
        for _ in range(2):
            await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "hello"})
        assert cloning.analyses == 1
        await c.patch(f"/v1/voices/{v['id']}", json={"transcript": "something else"})
        await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "hello"})
    assert cloning.analyses == 2


async def test_delete_removes_the_files(app, tmp_path):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        r = await c.delete(f"/v1/voices/{v['id']}")
        gone = await c.get(f"/v1/voices/{v['id']}")
        again = await c.delete(f"/v1/voices/{v['id']}")
        ref = await c.get(f"/v1/voices/{v['id']}/reference")
    assert r.status_code == 204 and r.content == b""
    assert gone.status_code == 404 and again.status_code == 404 and ref.status_code == 404
    assert not (tmp_path / "voices" / v["id"]).exists()


async def test_reference_audio_can_be_downloaded(app):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        r = await c.get(f"/v1/voices/{v['id']}/reference")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert (w.getframerate(), w.getnchannels()) == (24000, 1)
        assert w.getnframes() / 24000 == pytest.approx(v["duration_s"], abs=0.01)


# ---- preview ---------------------------------------------------------------------------------------------------------------
async def test_preview_synthesizes_with_the_voice(make_app, tmp_path):
    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    async with client(app) as c:
        v = (await post_voice(c, languages="en")).json()
        r = await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "Hello there. Again."})
        default = await c.post(f"/v1/voices/{v['id']}/preview")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == 24000 and w.getnframes() == round(0.3 * 24000)
    # the router hands the engine one sentence at a time
    assert cloning.calls[:2] == [("Hello there.", v["id"], "en"), ("Again.", v["id"], "en")]
    assert default.status_code == 200 and cloning.calls[2][0] == "Hello, this is my voice."


async def test_preview_default_text_follows_the_language(make_app, tmp_path):
    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    async with client(app) as c:
        v = (await post_voice(c, languages="zh", transcript="你好这是我的声音")).json()
        await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "  "})
    assert cloning.calls[0][0] == "你好，这是我的声音。" and cloning.calls[0][2] == "zh"


async def test_preview_text_limit(app):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        ok = await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "a " * 150})
        long = await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "a" * 301})
    assert ok.status_code == 200 and long.status_code == 400 and err(long)["code"] == "text_too_long"


async def test_preview_applies_the_lexicon(make_app, tmp_path):
    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    async with client(app) as c:
        v = (await post_voice(c)).json()
        await c.put("/v1/lexicon", json={"entries": {"MAX": "Max speech"}})
        await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "hi MAX"})
    assert cloning.calls[0][0] == "hi Max speech"


async def test_preview_holds_the_cloning_lock_one_sentence_at_a_time(make_app, tmp_path):
    """A preview is batch work on the cloning engine: it never takes the preset voices' lock, and it lets a live cloned
    sentence in between two of its sentences rather than after the whole preview."""
    cloning = FakeCloningTts()
    app = make_app(Settings(data_dir=tmp_path), cloning=cloning)
    slots = app.state.slots
    seen = []
    inner = cloning.synthesize_cloned

    def watch(text, reference, **kw):
        seen.append((text, slots.cloning_lock.locked(), slots.tts_lock.locked()))
        yield from inner(text, reference, **kw)

    cloning.synthesize_cloned = watch
    async with client(app) as c:
        v = (await post_voice(c, languages="en")).json()
        released = []
        real_release = slots.cloning_lock.release

        def release():
            released.append(len(seen))
            real_release()

        slots.cloning_lock.release = release
        r = await c.post(f"/v1/voices/{v['id']}/preview", json={"text": "One two. Three four. Five six."})
    assert r.status_code == 200
    assert seen == [("One two.", True, False), ("Three four.", True, False), ("Five six.", True, False)]
    assert released == [1, 2, 3]  # let go after each sentence


class GatedCloning(FakeCloningTts):
    """Like the Qwen3 MLX engine: a sentence streams in 4 chunks, each computed under the MLX gate (0.02 s of work)."""

    def synthesize_cloned(self, text, reference, **kw):
        def chunks():
            for audio in FakeCloningTts.synthesize_cloned(self, text, reference, **kw):
                for piece in np.array_split(audio, 4):
                    time.sleep(0.02)
                    yield piece

        yield from stepwise(chunks())


class LongBatchOnGate:
    """A long batch call on the GPU (a transcription): 0.3 s units with a yield point before each, 3 s in all."""

    def __init__(self, units=10, unit_s=0.3):
        self.done = threading.Event()
        started = threading.Event()

        def run():
            with MLX_GATE:
                started.set()
                for _ in range(units):
                    MLX_GATE.yield_point()
                    time.sleep(unit_s)
            self.done.set()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        assert started.wait(5)


async def test_a_preview_does_not_make_live_cloned_speech_wait_for_a_batch_call(make_app, tmp_path):
    """The preview holds the cloning engine's lock while it synthesizes. If it waited at the GPU gate as batch work, a
    live cloned sentence queued on that lock (not at the gate) would wait for the whole batch call. It runs as live
    work, so the live sentence waits about one batch unit plus the preview's current sentence (4 chunks of 0.02 s);
    as batch work every chunk of the preview would wait for a batch unit (0.3 s) as well."""
    app = make_app(Settings(data_dir=tmp_path), cloning=GatedCloning())
    async with client(app) as c:
        v = (await post_voice(c, languages="en")).json()
        batch = LongBatchOnGate()
        preview = asyncio.create_task(
            c.post(f"/v1/voices/{v['id']}/preview", json={"text": "One two. Three four. Five six."})
        )
        await asyncio.sleep(0.1)  # the preview is in flight
        start = time.monotonic()
        r = await c.post(
            "/v1/audio/speech",
            json={"input": "Hello there.", "voice": v["id"], "response_format": "pcm"},
        )
        waited = time.monotonic() - start
        assert (await preview).status_code == 200
    assert r.status_code == 200 and r.content
    assert waited < 0.8, f"live cloned speech took {waited:.2f}s behind a 3 s batch call"
    assert not batch.done.is_set(), "the batch call ended first: the test proves nothing"
    batch.thread.join(10)


class HiRateCloning(FakeCloningTts):
    sample_rate = 48000  # above the preset rate, so the router's streaming DownResampler is in play


async def test_speech_in_a_custom_voice_holds_the_cloning_lock_one_sentence_at_a_time(make_app, tmp_path):
    """One long request must not hold the cloning engine for its whole input; the audio stays exactly what one
    synthesis of the whole input gives."""
    from max_speech.api import openai_routes

    app = make_app(Settings(data_dir=tmp_path), cloning=HiRateCloning())
    slots = app.state.slots
    text = "One two three. Four five six seven. Eight nine. Ten eleven twelve thirteen."
    async with client(app) as c:
        v = (await post_voice(c, languages="en")).json()
        expected = b"".join(openai_routes._pcm_chunks(slots.tts, text, v["id"], 1.0, None))
        acquired = []
        real_acquire = slots.cloning_lock.acquire

        async def acquire():
            acquired.append(len(slots.cloning.calls))
            return await real_acquire()

        slots.cloning_lock.acquire = acquire
        r = await c.post("/v1/audio/speech", json={"input": text, "voice": v["id"], "response_format": "pcm"})
        streamed = await c.post(
            "/v1/audio/speech",
            json={"input": text, "voice": v["id"], "response_format": "pcm", "stream_format": "audio"},
        )
    assert r.status_code == 200 and r.content == expected
    assert streamed.content == expected
    assert acquired[:4] == [4, 5, 6, 7]  # one lock hold per sentence (4 calls came from computing `expected`)


@pytest.mark.parametrize("stream_format", ["audio", "sse"])
async def test_a_voice_that_vanishes_before_streaming_starts_stops_every_sentence_job(
    make_app, tmp_path, stream_format
):
    """The first sentence finds the voice deleted (404); the jobs for the other sentences must be cancelled, not keep
    being created and run one after another."""
    app = make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts())
    slots = app.state.slots
    async with client(app) as c:
        v = (await post_voice(c, languages="en")).json()
        started = []
        real = slots.tts.synthesize

        def counting(text, voice, **kw):
            started.append(text)
            return real(text, voice, **kw)

        slots.tts.synthesize = counting

        def gone(voice_id):
            raise UnknownVoiceError(voice_id)

        slots.voices.get = gone
        body = {"input": "One. Two. Three. Four. Five. Six.", "voice": v["id"], "response_format": "pcm"}
        r = await c.post("/v1/audio/speech", json={**body, "stream_format": stream_format})
        await asyncio.sleep(0.2)
    assert r.status_code == 404
    assert len(started) <= 2, started  # only the jobs already in flight, none created after the error


# ---- lexicon ---------------------------------------------------------------------------------------------------------------
async def test_lexicon_roundtrip_and_persistence(make_app, tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = make_app(settings)
    async with client(app) as c:
        assert (await c.get("/v1/lexicon")).json() == {"entries": {}}
        r = await c.put("/v1/lexicon", json={"entries": {"MAX": "Max", "Dr": "Doctor"}})
        assert r.status_code == 200 and r.json() == {"entries": {"MAX": "Max", "Dr": "Doctor"}}
        r = await c.put("/v1/lexicon", json={"entries": {"GIF": "jiff"}})  # replaces the whole lexicon
        assert (await c.get("/v1/lexicon")).json() == {"entries": {"GIF": "jiff"}}
    assert json.loads((tmp_path / "lexicon.json").read_text()) == {"entries": {"GIF": "jiff"}}
    async with client(make_app(settings)) as c:  # a new server reads it back
        assert (await c.get("/v1/lexicon")).json() == {"entries": {"GIF": "jiff"}}


@pytest.mark.parametrize(
    "body",
    [
        {"entries": {"k": "v" * 129}},
        {"entries": {"k" * 65: "v"}},
        {"entries": {f"k{i}": "v" for i in range(501)}},
        {"entries": {"": "v"}},
    ],
)
async def test_lexicon_limits(app, body):
    async with client(app) as c:
        r = await c.put("/v1/lexicon", json=body)
    assert r.status_code == 400 and err(r)["code"] == "invalid_lexicon"


async def test_lexicon_bad_shape(app):
    async with client(app) as c:
        for body in ({"entries": ["a"]}, {"entries": {"a": 1}}, {}, {"entries": {}, "extra": 1}):
            assert (await c.put("/v1/lexicon", json=body)).status_code == 400


async def test_lexicon_changes_speech(make_app, tmp_path):
    seen = []

    class Spy(FakeTts):
        def synthesize(self, text, voice, **kw):
            seen.append(text)
            yield from super().synthesize(text, voice, **kw)

    app = make_app(Settings(data_dir=tmp_path), tts=Spy())
    async with client(app) as c:
        await c.put("/v1/lexicon", json={"entries": {"GIF": "jiff"}})
        await c.post("/v1/audio/speech", json={"voice": "alpha", "input": "a GIF here"})
    assert seen == ["a jiff here"]


# ---- auth, readiness, discovery ------------------------------------------------------------------------------------------------
async def test_routes_require_the_api_key(make_app, tmp_path):
    app = make_app(Settings(data_dir=tmp_path, api_key="secret"), cloning=FakeCloningTts())
    paths = [("GET", "/v1/voices"), ("POST", "/v1/voices"), ("GET", "/v1/lexicon"), ("PUT", "/v1/lexicon"),
             ("GET", "/v1/voices/v_0000000000"), ("DELETE", "/v1/voices/v_0000000000"),
             ("PATCH", "/v1/voices/v_0000000000"), ("GET", "/v1/voices/v_0000000000/reference"),
             ("POST", "/v1/voices/v_0000000000/preview")]  # fmt: skip
    async with client(app) as c:
        for method, path in paths:
            r = await c.request(method, path)
            assert r.status_code == 401, (method, path)
        ok = await c.get("/v1/voices", headers={"Authorization": "Bearer secret"})
    assert ok.status_code == 200


async def test_not_ready_is_503(make_app, tmp_path):
    import threading

    app = make_app(Settings(data_dir=tmp_path), ready=threading.Event())
    async with client(app) as c:
        assert (await c.get("/v1/voices")).status_code == 503


async def test_discovery_reports_cloning(make_app, tmp_path):
    async with client(make_app(Settings(data_dir=tmp_path))) as c:
        off = (await c.get("/.well-known/max-speech")).json()
    async with client(make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts())) as c:
        on = (await c.get("/.well-known/max-speech")).json()
    assert off["features"]["cloning"] is False and on["features"]["cloning"] is True


async def test_discovery_attributions_include_the_cloning_model(make_app, tmp_path, monkeypatch):
    from max_speech.licenses import load_registry

    entry = next(iter(load_registry().values()))

    class Cloner(FakeCloningTts):
        model_id = entry.id

    async with client(make_app(Settings(data_dir=tmp_path), cloning=Cloner())) as c:
        d = (await c.get("/.well-known/max-speech")).json()
    assert entry.id in [a["model"] for a in d["attributions"]]


async def test_audio_voices_lists_custom_voices_only_with_cloning(make_app, tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = make_app(settings, cloning=FakeCloningTts())
    async with client(app) as c:
        v = (await post_voice(c)).json()
        ids = [x["id"] for x in (await c.get("/v1/audio/voices")).json()["voices"]]
    assert ids == ["alpha", "bravo", v["id"]]
    async with client(make_app(settings)) as c:  # same data dir, no cloning engine loaded
        ids = [x["id"] for x in (await c.get("/v1/audio/voices")).json()["voices"]]
        speech = await c.post("/v1/audio/speech", json={"voice": v["id"], "input": "hi there"})
    assert ids == ["alpha", "bravo"]
    assert speech.status_code == 404 and err(speech)["code"] == "voice_not_found"


async def test_data_dir_files_are_private(app, tmp_path):
    async with client(app) as c:
        v = (await post_voice(c)).json()
        await c.put("/v1/lexicon", json={"entries": {"a": "b"}})
    assert oct(os.stat(tmp_path / "voices" / v["id"] / "reference.wav").st_mode & 0o777) == "0o600"
    assert oct(os.stat(tmp_path / "lexicon.json").st_mode & 0o777) == "0o600"


def test_speech_like_helper_is_valid():
    assert len(speech_like(1.0)) == 24000


# ---- provenance: who asked, from where ------------------------------------------------------------------------
async def test_the_consent_record_names_the_caller_and_the_audit_log_follows(make_app, tmp_path):
    app = make_app(Settings(data_dir=tmp_path, api_key="s3cret"), cloning=FakeCloningTts())
    async with client(app, headers={"Authorization": "Bearer s3cret"}) as c:
        v = (await post_voice(c)).json()
        assert (await c.delete(f"/v1/voices/{v['id']}")).status_code == 204
    consent = v["consent"]
    assert consent["auth"] == "api_key" and len(consent["key_id"]) == 12 and "s3cret" not in json.dumps(v)
    assert consent["client"] and len(consent["audio_sha256"]) == 64
    events = [json.loads(line) for line in (tmp_path / "voice-audit.log").read_text().splitlines()]
    assert [e["event"] for e in events] == ["create", "delete"]
    assert events[1]["auth"] == "api_key" and events[1]["voice_id"] == v["id"]


async def test_without_a_key_the_caller_is_recorded_as_loopback(app, tmp_path):
    async with client(app) as c:
        v = (await post_voice(c)).json()
    assert v["consent"]["auth"] == "loopback"
    assert "key_id" not in v["consent"]
