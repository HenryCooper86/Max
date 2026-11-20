import asyncio
import socket
import threading
import time

import httpx
import numpy as np
import pytest
import uvicorn

from max_speech.api import openai_routes
from max_speech.engines.fake import FakeTts
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
