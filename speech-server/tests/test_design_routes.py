import asyncio
import io
import json
import re
import threading

import httpx
import pytest
import soundfile as sf
from voice_helpers import CONSENT, good_wav

from max_speech.engines.fake_cloning import FakeCloningTts
from max_speech.engines.fake_design import FakeDesignEngine
from max_speech.settings import Settings
from max_speech.voices.candidates import CandidateCache

CID = re.compile(r"^c_[0-9a-f]{12}$")
EN_DEFAULT = "Hello! This is how I sound when I read a few sentences aloud, so you can hear my voice."
ZH_DEFAULT = "你好！这是我朗读一小段话时的声音，你可以听听看。"


def client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://localhost"
    )


@pytest.fixture
def design():
    return FakeDesignEngine()


@pytest.fixture
def app(make_app, tmp_path, design):
    return make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts(), design=design)


def err(r):
    return r.json()["error"]


async def make(c, **over):
    body = {"description": "A deep, low-pitched older male voice", **over}
    return await c.post("/v1/voices/design", json=body)


async def test_design_makes_three_distinct_candidates_by_default(app, design):
    async with client(app) as c:
        r = await make(c)
    assert r.status_code == 200
    cands = r.json()["candidates"]
    assert len(cands) == 3 and len({x["id"] for x in cands}) == 3
    for x in cands:
        assert CID.match(x["id"]) and x["text"] == EN_DEFAULT and x["language"] == "en"
        assert x["description"] == "A deep, low-pitched older male voice" and x["expires_at"].endswith("Z")
    seeds = [call[3] for call in design.calls]
    assert len(set(seeds)) == 3
    assert all(
        call[:3] == ("A deep, low-pitched older male voice", EN_DEFAULT, "en") for call in design.calls
    )


async def test_language_defaults_from_the_script_of_the_text_or_description(app, design):
    async with client(app) as c:
        zh = (await make(c, description="低沉的老年男声", count=1)).json()["candidates"][0]
        assert zh["language"] == "zh" and zh["text"] == ZH_DEFAULT
        zh2 = (await make(c, text="今天天气很好，我们一起出去走走吧。", count=1)).json()["candidates"][0]
        assert zh2["language"] == "zh" and zh2["text"] == "今天天气很好，我们一起出去走走吧。"
        explicit = (
            await make(c, text="Hi there, how are you doing today?", language="en-US", count=1)
        ).json()["candidates"][0]
        assert explicit["language"] == "en"


@pytest.mark.parametrize(
    ("over", "code"),
    [
        ({"description": ""}, "invalid_field"),
        ({"description": "   "}, "invalid_field"),
        ({"description": "x" * 301}, "invalid_field"),
        ({"text": "x" * 301}, "invalid_field"),
        ({"count": 0}, "invalid_field"),
        ({"count": 4}, "invalid_field"),
        ({"language": "fr"}, "invalid_language"),
        ({"description": "bad\x00char"}, "invalid_field"),
    ],
)
async def test_bad_requests_are_400(app, design, over, code):
    async with client(app) as c:
        r = await make(c, **over)
    assert r.status_code == 400 and err(r)["code"] == code
    assert design.calls == []


@pytest.mark.parametrize("body", [{}, {"description": 5}, {"description": "calm", "count": "2"}])
async def test_malformed_bodies_are_rejected(app, body):
    async with client(app) as c:
        r = await c.post("/v1/voices/design", json=body)
    assert r.status_code in (400, 422)


REFUSED = [
    "deep and gravelly like Morgan Freeman",
    "Speak as Taylor Swift",
    "Sounds like Morgan Freeman",
    "a voice that will sound like my boss",
    "the voice of Barack Obama",
    "Taylor Swift's voice",
    "Morgan Freeman voice, but younger",
    "Imitate a famous actor",
    "impersonating the president",
    "mimic my teacher",
    "a clone of my neighbour's voice, cloning him",
    "in the style of David Attenborough",
    "模仿某位明星",
    "冒充我的老板",
    "像周杰伦的声音",
    "听起来像周杰伦",
    "雷军的声音",
    "像马云一样说话",
    "学刘德华说话",
]
ALLOWED = [
    "A young woman's voice, warm and clear",
    "an old man's voice",
    "A child's voice",
    "The voice of a cheerful young girl",
    "a deep voice from the south",
    "A warm, calm middle-aged female voice, slightly husky",
    "A bright young girl, cheerful, speaking quickly",
    "A deep, low-pitched older male voice",
    "A British radio announcer, crisp and formal",
    "a voice like a wise grandmother",
    "sounds like a friendly teacher",
    "A Southern American accent, relaxed",
    "Mom's voice, soft and gentle",
    "the voice of reason, calm and steady",
    "low-pitched, raspy, like an old pirate",
    "低沉的老年男声",
    "温柔的女人的声音",
    "年轻女孩的声音，活泼可爱",
    "听起来像个年轻女人",
    "像老人一样说话",
    "清脆的声音",
    "沙哑低沉的男人的声音",
    "播音员的声音",
    "像主持人一样说话，语速适中",
]


@pytest.mark.parametrize("description", REFUSED)
async def test_describing_a_real_person_is_refused(app, design, description):
    async with client(app) as c:
        r = await make(c, description=description)
    assert r.status_code == 400 and err(r)["code"] == "design_refused"
    assert err(r)["param"] == "description" and design.calls == []


@pytest.mark.parametrize("description", ALLOWED)
async def test_ordinary_descriptions_pass_the_guard(app, description):
    async with client(app) as c:
        assert (await make(c, description=description, count=1)).status_code == 200


async def test_design_is_unavailable_without_the_engine_or_cloning(make_app, tmp_path):
    for kw in ({"cloning": FakeCloningTts()}, {"design": FakeDesignEngine()}, {}):
        async with client(make_app(Settings(data_dir=tmp_path), **kw)) as c:
            r = await make(c)
        assert r.status_code == 409 and err(r)["code"] == "design_unavailable"


async def test_audio_is_a_wav_and_unknown_ids_are_404(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        r = await c.get(f"/v1/voices/design/{cid}/audio")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        data, rate = sf.read(io.BytesIO(r.content))
        assert rate == 24000 and len(data) == 96000
        for bad in ("c_000000000000", "c_XYZ", "v_0123456789", "..%2Fx"):
            assert (await c.get(f"/v1/voices/design/{bad}/audio")).status_code == 404


async def test_expired_candidates_are_gone_and_eviction_keeps_thirty(app):
    clock = [0.0]
    app.state.slots.candidates = CandidateCache(clock=lambda: clock[0])
    async with client(app) as c:
        first = (await make(c, count=3)).json()["candidates"][0]["id"]
        for _ in range(10):
            await make(c, count=3)
        assert len(app.state.slots.candidates) == 30
        assert (await c.get(f"/v1/voices/design/{first}/audio")).status_code == 404  # evicted
        last = (await make(c, count=1)).json()["candidates"][0]["id"]
        clock[0] = 15 * 60 + 1
        assert (await c.get(f"/v1/voices/design/{last}/audio")).status_code == 404  # expired
        r = await c.post(f"/v1/voices/design/{last}/save", json={"name": "x"})
        assert r.status_code == 404


async def test_save_makes_a_designed_custom_voice(app, design):
    async with client(app) as c:
        cand = (await make(c, count=2)).json()["candidates"][1]
        r = await c.post(
            f"/v1/voices/design/{cand['id']}/save",
            json={"name": "Grandpa", "gender": "male", "created_by": "admin"},
        )
        assert r.status_code == 201
        v = r.json()
        assert r.headers["location"] == f"/v1/voices/{v['id']}"
        assert v["kind"] == "custom" and v["origin"] == "designed" and v["created_by"] == "admin"
        assert v["name"] == "Grandpa" and v["gender"] == "male" and v["languages"] == ["en"]
        assert v["transcript"] == EN_DEFAULT and "consent" not in v
        assert v["design"]["description"] == "A deep, low-pitched older male voice"
        assert v["design"]["model"] == "fake-design-tts" and v["design"]["text"] == EN_DEFAULT
        assert v["design"]["seed"] == design.calls[1][3]
        ref = await c.get(f"/v1/voices/{v['id']}/reference")
        assert ref.status_code == 200
        listing = (await c.get("/v1/voices")).json()
    entry = next(x for x in listing["voices"] if x["id"] == v["id"])
    assert (
        entry["origin"] == "designed"
        and "consent" not in entry
        and entry["design"]["seed"] == v["design"]["seed"]
    )
    assert listing["design"] is True


async def test_save_validates_the_name_and_extra_fields(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        for body in (
            {},
            {"name": ""},
            {"name": "x" * 65},
            {"name": "ok", "gender": "robot"},
            {"name": "ok", "origin": "recorded"},
        ):
            r = await c.post(f"/v1/voices/design/{cid}/save", json=body)
            assert r.status_code in (400, 422), body
        voices = (await c.get("/v1/voices")).json()["voices"]
    assert all(v["kind"] == "preset" for v in voices)


async def test_post_voices_cannot_create_a_designed_voice(app):
    fields = {
        "name": "Sneaky",
        "transcript": "hello there this is me",
        "origin": "designed",
        "description": "calm",
    }
    async with client(app) as c:
        r = await c.post("/v1/voices", data=fields, files={"audio": ("r.wav", good_wav(), "audio/wav")})
        assert r.status_code == 400 and err(r)["code"] == "consent_required"
        ok = await c.post(
            "/v1/voices", data={**fields, **CONSENT}, files={"audio": ("r.wav", good_wav(), "audio/wav")}
        )
        assert ok.status_code == 201 and ok.json()["origin"] == "recorded" and "design" not in ok.json()


async def test_recorded_voices_list_origin_and_consent_but_no_design(app):
    async with client(app) as c:
        await c.post(
            "/v1/voices",
            data={"name": "Rec", "transcript": "hello there this is me", **CONSENT},
            files={"audio": ("r.wav", good_wav(), "audio/wav")},
        )
        voices = [v for v in (await c.get("/v1/voices")).json()["voices"] if v["kind"] == "custom"]
    assert voices[0]["origin"] == "recorded" and "consent" in voices[0] and "design" not in voices[0]


async def test_a_designed_voice_speaks_through_cloning(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        v = (await c.post(f"/v1/voices/design/{cid}/save", json={"name": "D"})).json()
        r = await c.post(
            "/v1/audio/speech",
            json={"model": "x", "input": "Hello there.", "voice": v["id"], "response_format": "wav"},
        )
    assert r.status_code == 200
    assert app.state.slots.cloning.calls and app.state.slots.cloning.calls[0][1] == v["id"]


async def test_each_candidate_takes_the_tts_lock_separately(app):
    slots = app.state.slots
    held_between = []
    original = app.state.slots.design.design

    def watch(description, text, language, seed):
        held_between.append(slots.tts_lock.locked())
        return original(description, text, language, seed)

    slots.design.design = watch
    async with client(app) as c:
        await make(c, count=3)
    assert held_between == [True, True, True] and not slots.tts_lock.locked()


async def test_live_speech_can_interleave_between_candidates(app):
    slots = app.state.slots
    order = []
    started = threading.Event()
    release = threading.Event()
    original = slots.design.design

    def slow(description, text, language, seed):
        order.append("design")
        if len(order) == 1:
            started.set()
            release.wait(5)  # hold the lock until the speech request is queued behind it
        return original(description, text, language, seed)

    slots.design.design = slow

    async def speech():
        await asyncio.to_thread(started.wait, 5)
        async with slots.tts_lock:
            order.append("speech")

    async with client(app) as c:
        job = asyncio.create_task(make(c, count=3))
        waiter = asyncio.create_task(speech())
        while not slots.tts_lock.locked() or not started.is_set():
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.05)  # the speech task is now waiting on the lock
        release.set()
        await asyncio.wait_for(asyncio.gather(job, waiter), 10)
    assert order == ["design", "speech", "design", "design"]


async def test_discovery_reports_design_and_its_attribution(make_app, tmp_path):
    class Real(FakeDesignEngine):
        model_id = "qwen3-tts-1.7b-voicedesign-mlx"

    async with client(make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts())) as c:
        off = (await c.get("/.well-known/max-speech")).json()
    async with client(make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts(), design=Real())) as c:
        on = (await c.get("/.well-known/max-speech")).json()
    async with client(make_app(Settings(data_dir=tmp_path), design=Real())) as c:
        no_clone = (await c.get("/.well-known/max-speech")).json()
    assert off["features"]["voice_design"] is False and on["features"]["voice_design"] is True
    assert no_clone["features"]["voice_design"] is False
    assert any(
        a["model"] == "qwen3-tts-1.7b-voicedesign-mlx" and "Qwen" in a["text"] for a in on["attributions"]
    )
    json.dumps(on)


async def test_a_second_save_of_the_same_candidate_is_404(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        first = await c.post(f"/v1/voices/design/{cid}/save", json={"name": "One"})
        second = await c.post(f"/v1/voices/design/{cid}/save", json={"name": "Two"})
        audio = await c.get(f"/v1/voices/design/{cid}/audio")
        voices = [v for v in (await c.get("/v1/voices")).json()["voices"] if v["kind"] == "custom"]
    assert first.status_code == 201
    assert second.status_code == 404 and err(second)["code"] == "candidate_not_found"
    assert audio.status_code == 404 and len(voices) == 1


async def test_concurrent_saves_make_one_voice(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        rs = await asyncio.gather(
            *(c.post(f"/v1/voices/design/{cid}/save", json={"name": f"V{i}"}) for i in range(4))
        )
    assert sorted(r.status_code for r in rs) == [201, 404, 404, 404]


async def test_a_failed_save_keeps_the_candidate_for_a_retry(app):
    async with client(app) as c:
        cid = (await make(c, count=1)).json()["candidates"][0]["id"]
        # An invalid gender passes the model but fails in the store.
        bad = await c.post(f"/v1/voices/design/{cid}/save", json={"name": "ok", "gender": "robot"})
        assert bad.status_code in (400, 422)
        ok = await c.post(f"/v1/voices/design/{cid}/save", json={"name": "ok"})
    assert ok.status_code == 201


@pytest.mark.parametrize(
    ("text", "language"),
    [
        ("Hi there.", None),
        ("x" * 24, "en"),
        ("你好吗", None),
        ("你好，今天天气", "zh"),
        ("Hello" + "好" * 5, "zh"),
    ],
)
async def test_a_too_short_sample_text_is_400(app, design, text, language):
    over = {"text": text, **({"language": language} if language else {})}
    async with client(app) as c:
        r = await make(c, **over)
    assert r.status_code == 400 and err(r)["code"] == "sample_text_too_short" and err(r)["param"] == "text"
    assert design.calls == []


@pytest.mark.parametrize(
    ("text", "language"),
    [("x" * 25, "en"), ("今天天气很好我们出去走走", None), ("Fine day, isn't it, today?", None)],
)
async def test_a_long_enough_sample_text_is_accepted(app, text, language):
    over = {"text": text, **({"language": language} if language else {})}
    async with client(app) as c:
        assert (await make(c, count=1, **over)).status_code == 200


async def test_the_default_samples_are_long_enough_to_save(app):
    from max_speech.api.voice_routes import DESIGN_TEXT, MIN_SAMPLE_HAN, MIN_SAMPLE_LATIN

    assert (
        len(DESIGN_TEXT["en"]) >= MIN_SAMPLE_LATIN
        and sum(c > "\u4e00" for c in DESIGN_TEXT["zh"]) >= MIN_SAMPLE_HAN
    )


async def test_the_model_loads_before_the_speech_lock_and_never_blocks_speech(make_app, tmp_path):
    loading = threading.Event()
    release = threading.Event()
    order = []

    class SlowLoad(FakeDesignEngine):
        def ensure_loaded(self):
            order.append("load-start")
            loading.set()
            release.wait(5)
            order.append("load-end")

    app = make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts(), design=SlowLoad())
    slots = app.state.slots

    async def speech():
        await asyncio.to_thread(loading.wait, 5)
        async with asyncio.timeout(2):  # would time out if the load held the lock
            async with slots.tts_lock:
                order.append("speech")
        release.set()

    async with client(app) as c:
        job = asyncio.create_task(make(c, count=1))
        await asyncio.wait_for(speech(), 5)
        r = await asyncio.wait_for(job, 10)
    assert r.status_code == 200
    assert order == ["load-start", "speech", "load-end"]


async def test_a_failed_model_load_is_design_unavailable(make_app, tmp_path):
    class Broken(FakeDesignEngine):
        def ensure_loaded(self):
            raise OSError("no weights")

    app = make_app(Settings(data_dir=tmp_path), cloning=FakeCloningTts(), design=Broken())
    async with client(app) as c:
        r = await make(c)
    assert r.status_code == 503 and err(r)["code"] == "design_unavailable"
