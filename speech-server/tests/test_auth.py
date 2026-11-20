import httpx

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
