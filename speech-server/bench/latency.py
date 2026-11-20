"""Latency benchmark for any OpenAI-compatible speech server.

Only httpx and the stdlib: it must run against Kokoro-FastAPI or Max Speech alike, so it
makes no assumption that the server honours `stream_format`.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import time
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path

import httpx

PCM_RATE = 24000
PCM_BYTES_PER_S = PCM_RATE * 2


@dataclass
class Phrase:
    lang: str  # "en" or "zh"
    text: str


@dataclass
class Sample:
    name: str
    wav: bytes
    lang: str | None = None
    reference: str | None = None


PHRASES = [
    Phrase("en", "Hello there."),
    Phrase("en", "The weather is nice today."),
    Phrase("en", "Please remind me to call the dentist tomorrow morning."),
    Phrase(
        "en",
        "When you are ready, tell me what you would like to do next, and I will walk you through "
        "each step one at a time so nothing gets lost.",
    ),
    Phrase("en", "Thank you very much for your help."),
    Phrase("zh", "你好。"),
    Phrase("zh", "今天天气很好。"),
    Phrase("zh", "请提醒我明天早上给牙医打电话。"),
    Phrase(
        "zh",
        "准备好之后，请告诉我你接下来想做什么，我会一步一步地带你完成，这样就不会遗漏任何内容。",
    ),
    Phrase("zh", "非常感谢你的帮助。"),
]


def _normalize_words(text: str) -> list[str]:
    kept = "".join(" " if unicodedata.category(c).startswith("P") else c for c in text.lower())
    return kept.split()


def _edit_distance(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str) -> float:
    ref = _normalize_words(reference)
    if not ref:
        return 0.0 if not _normalize_words(hypothesis) else 1.0
    return _edit_distance(ref, _normalize_words(hypothesis)) / len(ref)


def _chars(text: str) -> list[str]:
    return [c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P")]


def cer(reference: str, hypothesis: str) -> float:
    ref = _chars(reference)
    if not ref:
        return 0.0 if not _chars(hypothesis) else 1.0
    return _edit_distance(ref, _chars(hypothesis)) / len(ref)


def percentile(values: list[float], p: float) -> float:
    """Linear interpolation between ranks, so p95 of a few runs is still meaningful."""
    xs = sorted(values)
    k = (len(xs) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def wav_duration(data: bytes) -> float:
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getnframes() / w.getframerate()


def pcm_to_wav(pcm: bytes, rate: int = PCM_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def make_client(base_url: str, api_key: str | None = None, timeout: float = 120.0) -> httpx.AsyncClient:
    # Trailing slash so relative paths like "audio/speech" keep the /v1 prefix.
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return httpx.AsyncClient(base_url=base_url.rstrip("/") + "/", headers=headers, timeout=timeout)


async def bench_tts(
    client: httpx.AsyncClient,
    phrases: list[Phrase],
    *,
    voice: str = "default",
    model: str = "tts-1",
    runs: int = 5,
    fmt: str = "pcm",
) -> list[dict]:
    rows = []
    for phrase in phrases:
        for _ in range(runs):
            body = {"model": model, "input": phrase.text, "voice": voice, "response_format": fmt}
            if fmt == "pcm":
                body["stream_format"] = "audio"
            chunks: list[bytes] = []
            ttfb = None
            start = time.perf_counter()
            async with client.stream("POST", "audio/speech", json=body) as r:
                if r.status_code != 200:
                    await r.aread()
                    raise RuntimeError(f"/audio/speech returned {r.status_code}: {r.text[:200]}")
                async for chunk in r.aiter_bytes():
                    if chunk and ttfb is None:
                        ttfb = time.perf_counter() - start
                    chunks.append(chunk)
            total = time.perf_counter() - start
            data = b"".join(chunks)
            if fmt == "wav":
                audio_s = wav_duration(data)
                pcm = data
                ttfb = total  # one body, no streaming to observe
            else:
                audio_s = len(data) / PCM_BYTES_PER_S
                pcm = data
            # A server that buffers the whole body ends up with ttfb ~ total, which is the honest number.
            ttfb = total if ttfb is None else ttfb
            rows.append(
                {
                    "lang": phrase.lang,
                    "text": phrase.text,
                    "ttfb_s": ttfb,
                    "total_s": total,
                    "audio_s": audio_s,
                    "rtf": total / audio_s if audio_s else float("inf"),
                    "audio": pcm,
                    "format": fmt,
                }
            )
    return rows


def load_fixtures(directory: Path) -> list[Sample]:
    samples = []
    for path in sorted(directory.glob("*.wav")):
        ref = path.with_suffix(".txt")
        text = ref.read_text(encoding="utf-8").strip() if ref.exists() else None
        samples.append(Sample(path.name, path.read_bytes(), None, text))
    return samples


def samples_from_tts(rows: list[dict]) -> list[Sample]:
    seen: dict[str, Sample] = {}
    for i, r in enumerate(rows):
        if r["text"] in seen:
            continue
        wav = r["audio"] if r["format"] == "wav" else pcm_to_wav(r["audio"])
        seen[r["text"]] = Sample(f"tts-{i}.wav", wav, r["lang"], r["text"])
    return list(seen.values())


async def bench_stt(
    client: httpx.AsyncClient, samples: list[Sample], *, model: str = "whisper-1", runs: int = 5
) -> list[dict]:
    rows = []
    for s in samples:
        for _ in range(runs):
            data = {"model": model, "response_format": "json"}
            if s.lang:
                data["language"] = s.lang
            start = time.perf_counter()
            r = await client.post(
                "audio/transcriptions", data=data, files={"file": (s.name, s.wav, "audio/wav")}
            )
            elapsed = time.perf_counter() - start
            if r.status_code != 200:
                raise RuntimeError(f"/audio/transcriptions returned {r.status_code}: {r.text[:200]}")
            text = r.json().get("text", "")
            row = {"name": s.name, "latency_s": elapsed, "text": text}
            if s.reference is not None:
                if s.lang == "zh":
                    row["cer"] = cer(s.reference, text)
                else:
                    row["wer"] = wer(s.reference, text)
            rows.append(row)
    return rows


async def run(
    client: httpx.AsyncClient,
    *,
    voice: str = "default",
    tts_model: str = "tts-1",
    stt_model: str = "whisper-1",
    runs: int = 5,
    fmt: str = "pcm",
    fixtures: Path | None = None,
    phrases: list[Phrase] | None = None,
) -> dict:
    tts_rows = await bench_tts(client, phrases or PHRASES, voice=voice, model=tts_model, runs=runs, fmt=fmt)
    fixture_samples = load_fixtures(fixtures) if fixtures else []
    samples = fixture_samples or samples_from_tts(tts_rows)
    stt_rows = await bench_stt(client, samples, model=stt_model, runs=runs)
    for r in tts_rows:
        del r["audio"]  # bulky and useless in the report
    return {"tts": tts_rows, "stt": stt_rows}


def _stat_lines(title: str, rows: list[dict], metrics: list[str]) -> list[str]:
    lines = [title, f"  {'metric':<10}{'n':>5}{'p50':>12}{'p95':>12}"]
    for m in metrics:
        vals = [r[m] for r in rows if m in r and r[m] != float("inf")]
        if vals:
            lines.append(f"  {m:<10}{len(vals):>5}{percentile(vals, 50):>12.4f}{percentile(vals, 95):>12.4f}")
    return lines


def format_table(report: dict) -> str:
    lines = _stat_lines("TTS", report["tts"], ["ttfb_s", "total_s", "audio_s", "rtf"])
    lines.append("")
    lines += _stat_lines("STT", report["stt"], ["latency_s", "wer", "cer"])
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m bench.latency", description=__doc__)
    p.add_argument("--base-url", default="http://localhost:8790/v1")
    p.add_argument("--api-key")
    p.add_argument("--voice", default="default")
    p.add_argument("--tts-model", default="tts-1")
    p.add_argument("--stt-model", default="whisper-1")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument(
        "--format", choices=["pcm", "wav"], default="pcm", help="wav for servers that only return wav"
    )
    p.add_argument("--fixtures", type=Path, help="directory of .wav files (optional .txt reference each)")
    p.add_argument("--json", type=Path, help="write the full report here")
    return p.parse_args(argv)


async def _amain(args: argparse.Namespace) -> None:
    async with make_client(args.base_url, args.api_key) as client:
        report = await run(
            client,
            voice=args.voice,
            tts_model=args.tts_model,
            stt_model=args.stt_model,
            runs=args.runs,
            fmt=args.format,
            fixtures=args.fixtures,
        )
    print(format_table(report))
    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> None:
    asyncio.run(_amain(parse_args(argv)))


if __name__ == "__main__":
    main()
