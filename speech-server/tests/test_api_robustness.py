import asyncio
import json
import socket
import threading
import time

import httpx
import numpy as np
import pytest
import uvicorn

from max_speech.api import openai_routes
from max_speech.engines.fake import FakeStt, FakeTts
from max_speech.settings import Settings


@pytest.fixture
def live(make_app):
    servers = []

    def start(**kw):
        server = uvicorn.Server(
            uvicorn.Config(make_app(Settings(), **kw), host="127.0.0.1", port=0, log_level="error")
        )
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.time() + 10
        while not server.started and time.time() < deadline:
            time.sleep(0.01)
        servers.append((server, thread))
        return server.servers[0].sockets[0].getsockname()[1]

    yield start
    for server, thread in servers:
        server.should_exit = True
        thread.join(timeout=5)


class Counting(FakeTts):
    """Each sentence takes `delay` seconds and is recorded, so tests can see what the engine ran."""

    def __init__(self, delay=0.0, chunk_samples=100):
        self.delay = delay
        self.chunk_samples = chunk_samples
        self.produced = 0
        self.started: list[str] = []

    def synthesize(self, text, voice, *, speed=1.0, language=None):
        self.started.append(text)
        for _ in text.split("."):
            time.sleep(self.delay)
            self.produced += 1
            yield np.zeros(self.chunk_samples, dtype=np.float32)


async def test_stalled_streaming_client_does_not_block_other_requests(live):
    tts = Counting(chunk_samples=24000)
    port = live(tts=tts)
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    sock.connect(("127.0.0.1", port))
    body = b'{"input":"' + b"a." * 200 + b'","voice":"alpha","response_format":"pcm","stream_format":"audio"}'
    sock.sendall(
        b"POST /v1/audio/speech HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )  # and never read the response
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=5) as c:
            await asyncio.sleep(0.3)
            r = await asyncio.wait_for(c.post("/v1/audio/speech", json={"input": "hi"}), 4)
        assert r.status_code == 200
    finally:
        sock.close()


async def test_disconnect_cancels_running_synthesis_and_frees_engine(live):
    tts = Counting(delay=0.1)
    port = live(tts=tts)
    text = "a." * 40  # ~4 s of work if it ran to the end
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as c:
        with pytest.raises(httpx.ReadTimeout):
            await c.post("/v1/audio/speech", json={"input": text}, timeout=0.5)
        t0 = time.perf_counter()
        r = await c.post("/v1/audio/speech", json={"input": "hi"}, timeout=3)
    assert r.status_code == 200
    assert time.perf_counter() - t0 < 1.0
    assert tts.produced < 20


async def test_request_cancelled_while_queued_never_runs(live):
    tts = Counting(delay=0.1)
    port = live(tts=tts)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as c:
        first = asyncio.create_task(c.post("/v1/audio/speech", json={"input": "first. " * 5}, timeout=5))
        await asyncio.sleep(0.1)
        with pytest.raises(httpx.ReadTimeout):
            await c.post("/v1/audio/speech", json={"input": "queued"}, timeout=0.3)
        assert (await first).status_code == 200
        await asyncio.sleep(0.2)
    assert not any(t == "queued" for t in tts.started)


async def test_content_length_over_cap_rejected_before_handler(make_app, monkeypatch):
    monkeypatch.setattr(openai_routes, "MAX_UPLOAD_BYTES", 1000)
    app = make_app()
    calls = []
    app.state.slots.stt.transcribe = lambda *a, **k: calls.append(1)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", b"0" * (1024 * 1024 + 5000))})
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
    assert not calls


async def test_chunked_body_over_cap_aborted(make_app, monkeypatch):
    monkeypatch.setattr(openai_routes, "MAX_UPLOAD_BYTES", 1000)

    async def body():
        yield b'--x\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'
        for _ in range(40):
            yield b"0" * 65536
        yield b"\r\n--x--\r\n"

    transport = httpx.ASGITransport(app=make_app(), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        r = await c.post(
            "/v1/audio/transcriptions",
            content=body(),
            headers={"content-type": "multipart/form-data; boundary=x"},
        )
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"


async def test_audio_too_long(make_app, monkeypatch):
    import io

    import soundfile as sf

    monkeypatch.setattr(openai_routes, "MAX_DURATION_S", 1)
    buf = io.BytesIO()
    sf.write(buf, np.zeros(32000, dtype=np.float32), 16000, format="WAV")
    transport = httpx.ASGITransport(app=make_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", buf.getvalue())})
    assert r.status_code == 400 and r.json()["error"]["code"] == "audio_too_long"


async def test_docs_disabled(make_app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app()), base_url="http://localhost"
    ) as c:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert (await c.get(path)).status_code == 404


async def test_early_stream_end_is_logged(make_app, caplog):
    class Boom(FakeTts):
        def synthesize(self, text, voice, *, speed=1.0, language=None):
            yield np.zeros(10, dtype=np.float32)
            raise RuntimeError("x")

    transport = httpx.ASGITransport(app=make_app(tts=Boom()), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        await c.post(
            "/v1/audio/speech", json={"input": "a", "response_format": "pcm", "stream_format": "audio"}
        )
    assert any("ended early" in r.message and "fake" in r.message for r in caplog.records)


class SlowStt:
    id = "slow"
    model_id = "slow-stt"

    def __init__(self, delay=0.5):
        self.delay = delay
        self.calls = 0

    def transcribe(self, audio, rate, *, language=None, prompt=None):
        from max_speech.engines.base import Transcript

        self.calls += 1
        time.sleep(self.delay)
        return Transcript(text="ok", language=language, duration_s=1.0)

    def warm_up(self):
        pass


async def test_stt_request_disconnected_while_queued_never_runs(live):
    import io

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.zeros(16000, dtype=np.float32), 16000, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()
    stt = SlowStt(delay=0.6)
    port = live(stt=stt)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as c:
        first = asyncio.create_task(
            c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav)}, timeout=5)
        )
        await asyncio.sleep(0.15)
        with pytest.raises(httpx.ReadTimeout):
            await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav)}, timeout=0.2)
        assert (await first).status_code == 200
        await asyncio.sleep(0.3)
    assert stt.calls == 1


# ---- body caps: every JSON body is bounded before it is read whole ------------------------------------------------
BIG = b'{"entries": {"a": "' + b"x" * (300 * 1024) + b'"}}'


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/v1/voices/design"),
        ("PATCH", "/v1/voices/anything"),
        ("POST", "/v1/audio/speech"),
        ("POST", "/v1/voices/anything/preview"),
    ],
)
async def test_an_oversized_json_body_is_refused_before_the_handler(make_app, method, path):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app(), raise_app_exceptions=False), base_url="http://localhost"
    ) as c:
        r = await c.request(method, path, content=BIG, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "request_too_large"


async def test_a_chunked_json_body_over_the_cap_is_aborted(make_app):
    async def body():
        for _ in range(24):  # 1.5 MB: over even the lexicon's larger cap
            yield b" " * 65536

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app(), raise_app_exceptions=False), base_url="http://localhost"
    ) as c:
        r = await c.put("/v1/lexicon", content=body(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "request_too_large"


async def test_a_normal_json_body_still_passes(make_app, tmp_path):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app(Settings(data_dir=tmp_path))), base_url="http://localhost"
    ) as c:
        r = await c.put("/v1/lexicon", json={"entries": {"Max": "Macks"}})
    assert r.status_code == 200 and r.json() == {"entries": {"Max": "Macks"}}


_CJK = "".join(chr(0x4E00 + i) for i in range(40))
_CJK_EXT_B = "".join(chr(0x20000 + i) for i in range(40))


def _max_lexicon(chars: str) -> dict[str, str]:
    """MAX_ENTRIES entries, each key and value at its length limit, drawn from `chars` (keys distinct)."""
    from max_speech.voices.lexicon import MAX_ENTRIES, MAX_KEY_CHARS, MAX_VALUE_CHARS

    entries = {}
    for i in range(MAX_ENTRIES):
        tag = chars[i % len(chars)] + chars[i // len(chars)]  # distinct for every entry
        entries[tag + chars[0] * (MAX_KEY_CHARS - 2)] = chars[1] * MAX_VALUE_CHARS
    return entries


@pytest.mark.parametrize(
    "chars,ensure_ascii",
    [
        (_CJK, False),  # CJK as UTF-8: 3 bytes a character, about 282 KB
        (_CJK, True),  # escaped: 6 bytes a character, about 560 KB
        (
            _CJK_EXT_B,
            True,
        ),  # outside the BMP, escaped as surrogate pairs: 12 bytes a character, the worst case
    ],
    ids=["cjk-utf8", "cjk-escaped", "cjk-ext-b-escaped"],
)
async def test_a_largest_valid_lexicon_is_accepted(make_app, tmp_path, chars, ensure_ascii):
    entries = _max_lexicon(chars)
    body = json.dumps({"entries": entries}, ensure_ascii=ensure_ascii).encode()
    assert len(body) > 256 * 1024  # over the cap of every other JSON body
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app(Settings(data_dir=tmp_path))), base_url="http://localhost"
    ) as c:
        r = await c.put("/v1/lexicon", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 200, r.text[:200]
    assert r.json()["entries"] == entries


async def test_a_lexicon_body_one_byte_over_its_cap_is_refused(make_app, tmp_path):
    from max_speech.api.limits import MAX_LEXICON_BYTES

    worst = json.dumps({"entries": _max_lexicon(_CJK_EXT_B)}).encode()
    assert len(worst) <= MAX_LEXICON_BYTES
    at_cap = worst[:-1] + b" " * (MAX_LEXICON_BYTES - len(worst)) + b"}"  # valid JSON, padded with spaces
    over = at_cap[:-1] + b" }"
    assert (len(at_cap), len(over)) == (MAX_LEXICON_BYTES, MAX_LEXICON_BYTES + 1)
    app = make_app(Settings(data_dir=tmp_path))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://localhost"
    ) as c:
        ok = await c.put("/v1/lexicon", content=at_cap, headers={"content-type": "application/json"})
        r = await c.put("/v1/lexicon", content=over, headers={"content-type": "application/json"})
        other = await c.post(
            "/v1/voices/design", content=b" " * (256 * 1024 + 1), headers={"content-type": "application/json"}
        )
    assert ok.status_code == 200
    assert r.status_code == 413 and r.json()["error"]["code"] == "request_too_large"
    assert other.status_code == 413  # every other JSON body keeps 256 KB


async def test_voice_uploads_keep_their_own_larger_cap(make_app):
    # a 300 KB reference clip is a normal multipart upload, not a JSON body
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app(), raise_app_exceptions=False), base_url="http://localhost"
    ) as c:
        r = await c.post("/v1/voices", files={"audio": ("a.wav", b"0" * (300 * 1024))}, data={"name": "x"})
    assert r.status_code != 413


# ---- transcription: bounded in-flight work and bounded decoding ----------------------------------------------------
def _wav() -> bytes:
    import io

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.zeros(16000, dtype=np.float32), 16000, format="WAV", subtype="PCM_16")
    return buf.getvalue()


async def test_transcriptions_beyond_the_cap_get_429_with_retry_after(make_app):
    stt = SlowStt(delay=0.5)
    app = make_app(Settings(max_transcriptions=1), stt=stt)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        first = asyncio.create_task(c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())}))
        await asyncio.sleep(0.15)
        refused = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())})
        assert refused.status_code == 429
        assert refused.headers["retry-after"].isdigit()
        assert refused.json()["error"]["code"] == "too_many_requests"
        assert (await first).status_code == 200
        again = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())})
        assert again.status_code == 200  # the place was freed
    assert stt.calls == 2


async def test_a_failed_transcription_frees_its_place(make_app):
    app = make_app(Settings(max_transcriptions=1))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        for _ in range(3):
            bad = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", b"not audio")})
            assert bad.status_code == 400


async def test_decoding_runs_at_most_a_few_at_a_time(make_app, monkeypatch):
    active, peak = 0, 0
    lock = threading.Lock()
    real = openai_routes.decode_audio

    def slow_decode(data):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.1)
        with lock:
            active -= 1
        return real(data)

    monkeypatch.setattr(openai_routes, "decode_audio", slow_decode)
    app = make_app(Settings(max_transcriptions=8))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        results = await asyncio.gather(
            *(c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())}) for _ in range(6))
        )
    assert [r.status_code for r in results] == [200] * 6
    assert 1 <= peak <= openai_routes.MAX_CONCURRENT_DECODES


def _multipart(wav: bytes) -> tuple[bytes, bytes]:
    boundary = b"maxspeechboundary"
    body = (
        b"--" + boundary + b'\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
        b"Content-Type: audio/wav\r\n\r\n" + wav + b"\r\n--" + boundary + b"--\r\n"
    )
    return body, b"multipart/form-data; boundary=" + boundary


def _scope(content_type: bytes, length: int) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/audio/transcriptions",
        "raw_path": b"/v1/audio/transcriptions",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"localhost"),
            (b"content-type", content_type),
            (b"content-length", str(length).encode()),
        ],
        "client": ("127.0.0.1", 5000),
        "server": ("127.0.0.1", 8790),
    }


async def _call(app, scope, receive) -> tuple[int, dict, bytes]:
    sent = []

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}, body


async def test_a_transcription_over_the_cap_is_refused_before_its_body_is_read(make_app):
    """The four places are taken by uploads in progress; a fifth is refused at once, without reading a byte of its
    (up to 26 MB) body, so a flood cannot make the server spool uploads it will refuse anyway."""
    gate = threading.Event()

    class Blocking(FakeStt):
        def transcribe(self, audio, rate, **kw):
            gate.wait(5)
            return super().transcribe(audio, rate, **kw)

    app = make_app(Settings(max_transcriptions=4), stt=Blocking())
    slots = app.state.slots
    body, content_type = _multipart(_wav())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        running = [
            asyncio.create_task(c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())}))
            for _ in range(4)
        ]
        while slots.transcriptions < 4:
            await asyncio.sleep(0.01)
        reads = 0

        async def receive():
            nonlocal reads
            reads += 1
            return {"type": "http.request", "body": body, "more_body": False}

        status, headers, raw = await asyncio.wait_for(_call(app, _scope(content_type, len(body)), receive), 2)
        gate.set()
        done = await asyncio.gather(*running)
    assert status == 429 and reads == 0
    assert headers["retry-after"].isdigit() and json.loads(raw)["error"]["code"] == "too_many_requests"
    assert [r.status_code for r in done] == [200] * 4
    assert slots.transcriptions == 0


async def test_a_client_that_disconnects_mid_upload_frees_its_place(make_app):
    app = make_app(Settings(max_transcriptions=1))
    slots = app.state.slots
    body, content_type = _multipart(_wav())
    messages = [
        {"type": "http.request", "body": body[:1000], "more_body": True},
        {"type": "http.disconnect"},
    ]
    seen = []

    async def receive():
        seen.append(slots.transcriptions)
        if messages:
            return messages.pop(0)
        await asyncio.sleep(3600)  # nothing more is coming

    sent = []

    async def send(message):
        sent.append(message)

    await asyncio.wait_for(app(_scope(content_type, len(body)), receive, send), 5)
    assert seen[0] == 1  # the place was taken while the body was being read
    assert slots.transcriptions == 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())})
    assert r.status_code == 200  # the place is free for the next client


# ---- batch work stops when its client leaves; uploads have a deadline ------------------------------------------------
class _FakeWhisperModel:
    windows = 0

    def decode(self, segment, options):
        type(self).windows += 1
        time.sleep(0.05)
        return "window"


def _windowed_stt(monkeypatch, windows):
    """WhisperMlxStt over a fake mlx-whisper whose transcribe() decodes `windows` windows of 0.05 s."""
    import sys
    from types import SimpleNamespace

    from max_speech.engines.whisper_mlx import WhisperMlxStt

    model = _FakeWhisperModel()
    _FakeWhisperModel.windows = 0
    holder = SimpleNamespace(get_model=lambda path, dtype: model)

    def transcribe(samples, **kw):
        m = holder.get_model(kw["path_or_hf_repo"], None)
        for _ in range(windows):
            m.decode(None, None)
        return {"text": "hi", "segments": [], "language": "en"}

    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=transcribe))
    monkeypatch.setitem(sys.modules, "mlx_whisper.transcribe", SimpleNamespace(ModelHolder=holder))
    return WhisperMlxStt("/models/w", "mlx-whisper-large-v3-turbo")


async def test_a_client_that_leaves_mid_transcription_stops_it_within_a_window(make_app, monkeypatch):
    from max_speech.engines.mlx_gate import MLX_GATE

    stt = _windowed_stt(monkeypatch, windows=100)  # 5 s of decoding
    app = make_app(Settings(max_transcriptions=1), stt=stt)
    slots = app.state.slots
    body, content_type = _multipart(_wav())
    sent_body = False
    gone_at = None

    async def receive():
        nonlocal sent_body, gone_at
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": body, "more_body": False}
        if gone_at is None and _FakeWhisperModel.windows >= 3:
            gone_at = time.monotonic()  # the client hangs up three windows in
        if gone_at is not None:
            return {"type": "http.disconnect"}
        await asyncio.sleep(3600)

    start = time.monotonic()
    sent = []

    async def send(message):
        sent.append(message)

    await asyncio.wait_for(app(_scope(content_type, len(body)), receive, send), 5)
    assert gone_at is not None and time.monotonic() - gone_at < 0.5
    assert _FakeWhisperModel.windows < 15 and time.monotonic() - start < 2
    assert slots.transcriptions == 0 and not slots.batch_stt_lock().locked() and not MLX_GATE.held


async def test_an_upload_that_does_not_arrive_in_time_gets_408_and_frees_its_place(make_app):
    app = make_app(Settings(max_transcriptions=1, upload_timeout_s=0.3))
    slots = app.state.slots
    body, content_type = _multipart(_wav())
    calls = 0

    async def receive():  # sends a first piece, then stalls
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"type": "http.request", "body": body[:500], "more_body": True}
        await asyncio.sleep(3600)

    start = time.monotonic()
    status, _, raw = await asyncio.wait_for(_call(app, _scope(content_type, len(body)), receive), 5)
    assert status == 408 and json.loads(raw)["error"]["code"] == "upload_timeout"
    assert time.monotonic() - start < 1.5
    assert slots.transcriptions == 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        r = await c.post("/v1/audio/transcriptions", files={"file": ("a.wav", _wav())})
    assert r.status_code == 200  # an upload that arrives in time is unaffected


def test_the_upload_deadline_has_a_default_and_a_setting():
    assert Settings().upload_timeout_s == 300
    assert Settings.from_env({"SPEECH_UPLOAD_TIMEOUT_S": "60"}).upload_timeout_s == 60


async def test_a_cancelled_batch_route_stops_its_thread_before_it_lets_go_of_its_lock():
    """Cancelling the route (server shutdown, a task cancelled) must abandon its batch work and wait for the thread:
    otherwise the engine lock (and a design request's place) is released while the thread still runs MLX work."""
    from max_speech.api.openai_routes import batch_ticket, run_for
    from max_speech.engines.mlx_gate import MLX_GATE, current_ticket

    class Request:
        async def is_disconnected(self):
            return False

    lock = asyncio.Lock()
    state = {"units": 0}

    def work():
        state["ticket"] = current_ticket()
        with MLX_GATE:
            for _ in range(20):  # 2 s of batch units with a yield point between them
                MLX_GATE.yield_point()
                time.sleep(0.1)
                state["units"] += 1
        state["done_at"] = time.monotonic()

    async def route():
        async with lock, batch_ticket(Request()) as ticket:
            await run_for(ticket, work)

    task = asyncio.create_task(route())
    await asyncio.sleep(0.25)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    returned = time.monotonic()
    assert state["ticket"].abandoned
    assert (
        "done_at" not in state or state["done_at"] <= returned
    )  # the thread had stopped before the route returned
    assert not lock.locked() and not MLX_GATE.held
    assert state["units"] <= 4  # it stopped at the next yield point, not after all 20 units
