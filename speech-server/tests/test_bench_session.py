import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_session_ws import FakeStreamingStt, FakeTurn, FakeVad

from bench import latency, session
from max_speech.engines.fake import FakeTts


@pytest.fixture
def server(make_app):
    app = make_app(vad=FakeVad(), turn=FakeTurn(), stt_stream=FakeStreamingStt(), tts=FakeTts())
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not srv.started and time.time() < deadline:
        time.sleep(0.01)
    yield f"ws://127.0.0.1:{srv.servers[0].sockets[0].getsockname()[1]}/v1/speech/session"
    srv.should_exit = True
    thread.join(timeout=5)


def test_http_base():
    assert session.http_base("ws://localhost:8790/v1/speech/session") == "http://localhost:8790/v1"
    assert session.http_base("wss://h.example/v1/speech/session") == "https://h.example/v1"


def test_resample_24k_to_16k_length():
    out = session.resample_24k_to_16k(bytes(2 * 2400))
    assert len(out) == 2 * 1600


async def test_listen_and_speak_against_a_real_server(server):
    phrase = latency.Phrase("en", "Hi there.")
    report = await session.run(server, runs=1, phrases=[phrase], voice="alpha", lead_s=0.1, trail_s=0.6)
    row = report["listen"][0]
    assert row["final_text"].startswith("final")
    assert 0 < row["final_after_end_s"] < 3
    assert row["first_partial_s"] is not None and row["first_partial_s"] > 0
    assert row["ms_turn"] >= 0 and row["ms_stt"] >= 0
    assert "wer" in row and "cer" not in row
    assert row["m1_s"] == pytest.approx(0.7 + row["stt_s"])
    spoken = report["speak"][0]
    assert 0 < spoken["first_audio_s"] <= spoken["done_s"]
    assert spoken["audio_s"] == pytest.approx(0.2, abs=0.05)
    table = session.format_table(report)
    assert "speech end -> transcript.final" in table and "p95" in table


async def test_zh_uses_cer(server):
    phrase = latency.Phrase("zh", "你好。")
    report = await session.run(server, runs=1, phrases=[phrase], voice="bravo", lead_s=0.1, trail_s=0.6)
    assert "cer" in report["listen"][0] and "wer" not in report["listen"][0]


def test_main_parses_args():
    args = session.parse_args(["--url", "ws://x/v1/speech/session", "--runs", "2", "--api-key", "k"])
    assert args.runs == 2 and args.api_key == "k"
