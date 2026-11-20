import io
import sys
import wave
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bench import latency


def client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://localhost/v1/"
    )


def test_wer_exact_match_is_zero():
    assert latency.wer("Hello, World!", "hello world") == 0.0


def test_wer_counts_word_edits():
    assert latency.wer("the cat sat", "the dog sat") == pytest.approx(1 / 3)
    assert latency.wer("a b", "a b c d") == 1.0


def test_cer_ignores_punctuation_and_space():
    assert latency.cer("你好，世界。", "你好 世界") == 0.0
    assert latency.cer("你好世界", "你好世间") == pytest.approx(0.25)


def test_percentile():
    assert latency.percentile([1, 2, 3, 4, 5], 50) == 3
    assert latency.percentile([1.0], 95) == 1.0
    assert latency.percentile([0, 10], 95) == pytest.approx(9.5)


def test_wav_duration():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\0\0" * 12000)
    assert latency.wav_duration(buf.getvalue()) == pytest.approx(0.5)


async def test_tts_metrics(make_app):
    phrases = [latency.Phrase("en", "Hello there. Second one.")]
    async with client(make_app()) as c:
        rows = await latency.bench_tts(c, phrases, voice="alpha", runs=2)
    assert len(rows) == 2
    for r in rows:
        assert 0 < r["ttfb_s"] <= r["total_s"]
        assert r["audio_s"] == pytest.approx(0.4, abs=0.05)
        assert r["rtf"] == pytest.approx(r["total_s"] / r["audio_s"])
        assert r["audio"]


async def test_tts_wav_format_ttfb_equals_total(make_app):
    async with client(make_app()) as c:
        rows = await latency.bench_tts(
            c, [latency.Phrase("en", "Hello there.")], voice="alpha", runs=1, fmt="wav"
        )
    assert rows[0]["ttfb_s"] == rows[0]["total_s"]
    assert rows[0]["audio_s"] == pytest.approx(0.2, abs=0.05)


async def test_stt_with_reference_wer(make_app):
    async with client(make_app()) as c:
        tts = await latency.bench_tts(c, [latency.Phrase("en", "Hello there.")], voice="alpha", runs=1)
        samples = [latency.Sample("x.wav", latency.pcm_to_wav(tts[0]["audio"]), "en", "heard 0.2s")]
        rows = await latency.bench_stt(c, samples, runs=1)
    assert rows[0]["latency_s"] > 0
    assert rows[0]["wer"] == 0.0
    assert "cer" not in rows[0]


async def test_run_all_and_summary(make_app, tmp_path):
    async with client(make_app()) as c:
        report = await latency.run(c, voice="alpha", runs=1, phrases=[latency.Phrase("en", "Hi there.")])
    assert report["tts"] and report["stt"]
    table = latency.format_table(report)
    assert "ttfb_s" in table and "p95" in table
    assert "audio" not in report["tts"][0]


def test_main_parses_args():
    args = latency.parse_args(["--base-url", "http://x/v1", "--runs", "2", "--format", "wav"])
    assert args.runs == 2 and args.format == "wav"
