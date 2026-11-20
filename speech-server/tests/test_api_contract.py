import io
import threading
import time
import wave

import httpx
import numpy as np
import openai
import pytest
import soundfile as sf
import uvicorn
from openai import AsyncOpenAI

from max_speech.settings import Settings


@pytest.fixture
def sdk(make_app):
    app = make_app(Settings(api_key="k"))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
    return AsyncOpenAI(base_url="http://test/v1", api_key="k", http_client=http)


def wav16k():
    buf = io.BytesIO()
    sf.write(buf, np.zeros(16000, dtype=np.float32), 16000, format="WAV")
    return ("a.wav", buf.getvalue(), "audio/wav")


async def test_speech_wav(sdk):
    r = await sdk.audio.speech.create(
        model="tts-1", voice="alloy", input="Hello there.", response_format="wav"
    )
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == 24000 and w.getnchannels() == 1 and w.getnframes() > 0


@pytest.fixture
def live_url(make_app):
    # httpx's ASGITransport buffers whole responses, so chunk boundaries are only visible over a real socket.
    server = uvicorn.Server(
        uvicorn.Config(make_app(Settings(api_key="k")), host="127.0.0.1", port=0, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}/v1"
    server.should_exit = True
    thread.join(timeout=5)


async def test_speech_streaming_pcm(live_url):
    sdk = AsyncOpenAI(base_url=live_url, api_key="k")
    chunks = []
    async with sdk.audio.speech.with_streaming_response.create(
        model="tts-1",
        voice="alloy",
        input="One two. Three four. Five six.",
        response_format="pcm",
        extra_body={"stream_format": "audio"},
    ) as r:
        async for c in r.iter_bytes():
            chunks.append(c)
    assert len(chunks) >= 2
    assert sum(map(len, chunks)) == 3 * round(0.2 * 24000) * 2


async def test_transcriptions(sdk):
    t = await sdk.audio.transcriptions.create(file=wav16k(), model="whisper-1")
    assert t.text == "heard 1.0s"
    v = await sdk.audio.transcriptions.create(
        file=wav16k(), model="whisper-1", response_format="verbose_json"
    )
    assert v.text == "heard 1.0s" and v.duration == 1.0


async def test_models(sdk):
    page = await sdk.models.list()
    assert "whisper-1" in {m.id for m in page.data}


async def test_errors(make_app):
    app = make_app(Settings(api_key="k"))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
    bad = AsyncOpenAI(base_url="http://test/v1", api_key="wrong", http_client=http, max_retries=0)
    with pytest.raises(openai.AuthenticationError):
        await bad.models.list()
    good = AsyncOpenAI(base_url="http://test/v1", api_key="k", http_client=http, max_retries=0)
    with pytest.raises(openai.NotFoundError):
        await good.audio.speech.create(model="tts-1", voice="nobody", input="hi")
    with pytest.raises(openai.BadRequestError, match="pcm"):
        await good.audio.speech.create(model="tts-1", voice="alloy", input="hi", response_format="mp3")
