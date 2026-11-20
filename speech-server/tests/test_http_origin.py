"""Cross-site writes and DNS rebinding against the loopback-only (no key) server."""

import httpx
import pytest
from voice_helpers import CONSENT, good_wav

from max_speech.engines.fake_cloning import FakeCloningTts
from max_speech.settings import Settings

EVIL = "https://evil.example"


def client(app, host="localhost"):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000), raise_app_exceptions=False),
        base_url=f"http://{host}",
    )


def app_for(make_app, tmp_path, **kw):
    return make_app(Settings(data_dir=tmp_path, **kw), cloning=FakeCloningTts())


def voice_form():
    data = {"name": "Ava", "transcript": "hello there this is me", "gender": "female", **CONSENT}
    return {"data": data, "files": {"audio": ("ref.wav", good_wav(), "audio/wav")}}


async def make_voice(c):
    r = await c.post("/v1/voices", **voice_form())
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_cross_site_multipart_post_refused_and_creates_nothing(make_app, tmp_path):
    app = app_for(make_app, tmp_path)
    async with client(app) as c:
        before = (await c.get("/v1/voices")).json()["voices"]
        r = await c.post("/v1/voices", headers={"Origin": EVIL}, **voice_form())
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "forbidden_origin"
        assert (await c.get("/v1/voices")).json()["voices"] == before


@pytest.mark.parametrize("ctype", ["application/x-www-form-urlencoded", "text/plain"])
async def test_cross_site_simple_posts_refused(make_app, tmp_path, ctype):
    app = app_for(make_app, tmp_path)
    async with client(app) as c:
        r = await c.post("/v1/audio/speech", content=b"x=1", headers={"Origin": EVIL, "Content-Type": ctype})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden_origin"


async def test_rebinding_host_refused(make_app, tmp_path):
    app = app_for(make_app, tmp_path)
    async with client(app) as c:
        vid = await make_voice(c)
    async with client(app, "rebind.evil.example") as c:
        ref = await c.get(f"/v1/voices/{vid}/reference")
        speech = await c.post("/v1/audio/speech", json={"model": "m", "input": "hi", "voice": "alloy"})
        health = await c.get("/healthz")
    for r in (ref, speech, health):
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "forbidden_host"


@pytest.mark.parametrize(
    "host", ["localhost", "localhost:8790", "127.0.0.1", "127.0.0.1:8790", "[::1]", "[::1]:8790"]
)
async def test_local_hosts_ok(make_app, tmp_path, host):
    async with client(app_for(make_app, tmp_path), host) as c:
        assert (await c.get("/v1/models")).status_code == 200


async def test_configured_bind_host_ok(make_app, tmp_path):
    app = app_for(make_app, tmp_path, host="192.168.1.5")
    async with client(app, "192.168.1.5:8790") as c:
        assert (await c.get("/v1/models")).status_code == 200
    async with client(app, "192.168.1.6") as c:
        assert (await c.get("/v1/models")).status_code == 403


async def test_wildcard_bind_does_not_open_hosts(make_app, tmp_path):
    app = app_for(make_app, tmp_path, host="0.0.0.0")
    async with client(app, "0.0.0.0") as c:
        assert (await c.get("/v1/models")).status_code == 403


@pytest.mark.parametrize("origin", ["http://localhost:3000", "http://127.0.0.1:5173", "http://[::1]:8790"])
async def test_local_origin_ok(make_app, tmp_path, origin):
    async with client(app_for(make_app, tmp_path)) as c:
        assert (await c.get("/v1/models", headers={"Origin": origin})).status_code == 200


async def test_allowed_origin_ok(make_app, tmp_path):
    app = app_for(make_app, tmp_path, allowed_origins=("https://app.example",))
    async with client(app) as c:
        assert (await c.get("/v1/models", headers={"Origin": "https://app.example"})).status_code == 200
        assert (await c.get("/v1/models", headers={"Origin": EVIL})).status_code == 403


@pytest.mark.parametrize("origin", ["null", "", "http://localhost.evil.example"])
async def test_odd_origins_refused(make_app, tmp_path, origin):
    async with client(app_for(make_app, tmp_path)) as c:
        r = await c.get("/v1/models", headers={"Origin": origin})
    assert r.status_code == 403


async def test_no_origin_ok(make_app, tmp_path):
    async with client(app_for(make_app, tmp_path)) as c:
        assert (await c.get("/v1/models")).status_code == 200
        assert (await c.get("/healthz")).status_code == 200


async def test_key_mode_foreign_origin_refused_even_with_key(make_app, tmp_path):
    app = app_for(make_app, tmp_path, api_key="secret")
    async with client(app) as c:
        r = await c.get("/v1/models", headers={"Origin": EVIL, "Authorization": "Bearer secret"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden_origin"


async def test_key_mode_odd_host_ok(make_app, tmp_path):
    app = app_for(make_app, tmp_path, api_key="secret")
    async with client(app, "speech.internal.example") as c:
        r = await c.get("/v1/models", headers={"Authorization": "Bearer secret"})
    assert r.status_code == 200
