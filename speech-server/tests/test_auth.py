import httpx
import pytest

from max_speech.settings import Settings


def client(app, host="127.0.0.1"):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(host, 5000)), base_url="http://test"
    )


async def test_key_required_when_set(make_app):
    app = make_app(Settings(api_key="secret"))
    async with client(app) as c:
        no = await c.get("/v1/models")
        wrong = await c.get("/v1/models", headers={"Authorization": "Bearer nope"})
        ok = await c.get("/v1/models", headers={"Authorization": "Bearer secret"})
    assert no.status_code == wrong.status_code == 401
    assert no.json()["error"]["code"] == "invalid_api_key"
    assert ok.status_code == 200


async def test_key_set_allows_remote_with_key(make_app):
    app = make_app(Settings(api_key="secret"))
    async with client(app, "10.1.2.3") as c:
        r = await c.get("/v1/models", headers={"Authorization": "Bearer secret"})
    assert r.status_code == 200


async def test_no_key_loopback_only(make_app):
    app = make_app()
    for host in ("127.0.0.1", "127.5.5.5", "::1", "::ffff:127.0.0.1"):
        async with client(app, host) as c:
            assert (await c.get("/v1/models")).status_code == 200, host
    for host in ("10.1.2.3", "192.168.1.5", "2001:db8::1", "not-an-ip"):
        async with client(app, host) as c:
            r = await c.get("/v1/models")
            assert r.status_code == 401, host
            assert r.json()["error"]["code"] == "api_key_required"
            assert "SPEECH_API_KEY" in r.json()["error"]["message"]


async def test_health_and_discovery_need_no_auth(make_app):
    app = make_app(Settings(api_key="secret"))
    async with client(app, "10.1.2.3") as c:
        assert (await c.get("/healthz")).status_code == 200
        assert (await c.get("/.well-known/max-speech")).status_code == 200


async def test_auth_before_loading(make_app):
    import threading

    app = make_app(Settings(api_key="secret"), ready=threading.Event())
    async with client(app) as c:
        assert (await c.get("/v1/models")).status_code == 401


async def test_unauthenticated_upload_is_refused_without_reading_the_body(make_app):
    app = make_app(Settings(api_key="secret"))
    reads = []

    async def receive():
        reads.append(1)
        return {"type": "http.request", "body": b"x" * 1000, "more_body": True}

    sent = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/v1/audio/transcriptions",
        "headers": [(b"content-type", b"multipart/form-data; boundary=x"), (b"content-length", b"99999999")],
        "client": ("10.1.2.3", 5000),
        "query_string": b"",
        "http_version": "1.1",
        "scheme": "http",
        "server": ("test", 80),
    }
    await app(scope, receive, send)
    assert sent[0]["status"] == 401
    assert not reads


async def test_testclient_host_is_not_trusted(make_app):
    async with client(make_app(), "testclient") as c:
        assert (await c.get("/v1/models")).status_code == 401


async def _ws_scope(path, headers=(), host="127.0.0.1"):
    return {
        "type": "websocket",
        "path": path,
        "headers": list(headers),
        "client": (host, 5000),
        "query_string": b"",
        "scheme": "ws",
        "server": ("test", 80),
        "subprotocols": [],
    }


async def test_websocket_is_refused_before_accept(make_app):
    app = make_app(Settings(api_key="secret"))
    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        raise AssertionError("the app must not be reached")

    await app(await _ws_scope("/v1/speech/session"), receive, send)
    assert [m["type"] for m in sent] == ["websocket.close"] and sent[0]["code"] == 1008


async def test_websocket_without_key_is_loopback_only(make_app):
    app = make_app()
    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        raise AssertionError("the app must not be reached")

    await app(await _ws_scope("/v1/speech/session", host="10.1.2.3"), receive, send)
    assert sent[0]["type"] == "websocket.close" and sent[0]["code"] == 1008


async def _ws_close_code(app, headers=()):
    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "websocket.connect"}

    await app(await _ws_scope("/v1/speech/session", headers=headers), receive, send)
    return sent[0]


async def test_websocket_without_origin_is_allowed(make_app):
    first = await _ws_close_code(make_app())
    assert first.get("code") != 1008  # reached the app, which accepts or answers on its own


@pytest.mark.parametrize(
    "origin", ["http://localhost:5173", "https://localhost", "http://127.0.0.1:3000", "http://[::1]:8080"]
)
async def test_websocket_from_a_localhost_origin_is_allowed(make_app, origin):
    first = await _ws_close_code(make_app(), [(b"origin", origin.encode())])
    assert first.get("code") != 1008


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://localhost.evil.example", "null", "file://x"]
)
async def test_websocket_from_a_foreign_origin_is_refused_before_accept(make_app, origin):
    first = await _ws_close_code(make_app(), [(b"origin", origin.encode())])
    assert first["type"] == "websocket.close" and first["code"] == 1008


async def test_foreign_origin_is_refused_even_with_the_right_key(make_app):
    app = make_app(Settings(api_key="secret"))
    headers = [(b"authorization", b"Bearer secret"), (b"origin", b"https://evil.example")]
    assert (await _ws_close_code(app, headers))["code"] == 1008
    ok = await _ws_close_code(app, [(b"authorization", b"Bearer secret")])
    assert ok.get("code") != 1008


async def test_a_listed_origin_is_allowed(make_app):
    app = make_app(Settings(api_key="secret", allowed_origins=("https://studio.example",)))
    headers = [(b"authorization", b"Bearer secret"), (b"origin", b"https://studio.example")]
    assert (await _ws_close_code(app, headers)).get("code") != 1008


def test_allowed_origins_setting_is_parsed():
    s = Settings.from_env({"SPEECH_ALLOWED_ORIGINS": "https://A.example/, http://b.example:81 ,"})
    assert s.allowed_origins == ("https://a.example", "http://b.example:81")
    assert Settings.from_env({}).allowed_origins == ()
