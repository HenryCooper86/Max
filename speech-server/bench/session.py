"""Benchmark the live session (`/v1/speech/session`) against a running Max Speech server.

Listening: each built-in phrase is synthesized with the server's own `/v1/audio/speech`, resampled to 16 kHz, and
streamed over the session at real-time pace in 20 ms frames, with leading and trailing silence. Speaking: the phrase
is sent as a `speak` message. For comparison it also times the M1 pipeline equivalent: the relay's fixed 700 ms VAD
hangover plus one `POST /v1/audio/transcriptions` of the same utterance.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import numpy as np
import websockets

from bench.latency import PHRASES, Phrase, cer, make_client, pcm_to_wav, percentile, wer

IN_RATE = 16000
TTS_RATE = 24000
FRAME_S = 0.02
FRAME_BYTES = int(IN_RATE * FRAME_S) * 2
M1_HANGOVER_S = (
    0.7  # the relay's fixed VAD hangover before it sends the utterance to /v1/audio/transcriptions
)


def http_base(ws_url: str) -> str:
    """`ws://host:port/v1/speech/session` -> `http://host:port/v1`."""
    parts = urlsplit(ws_url)
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, "/v1", "", ""))


def resample_24k_to_16k(pcm: bytes) -> bytes:
    samples = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32)
    if len(samples) == 0:
        return b""
    # Average pairs of neighbours first so the 2:3 decimation does not alias.
    smooth = np.convolve(samples, [0.25, 0.5, 0.25], mode="same")
    out = np.interp(np.arange(0, len(smooth), TTS_RATE / IN_RATE), np.arange(len(smooth)), smooth)
    return np.clip(out, -32768, 32767).astype("<i2").tobytes()


async def synthesize(
    client: httpx.AsyncClient, text: str, *, voice: str = "default", model: str = "tts-1"
) -> bytes:
    body = {"model": model, "input": text, "voice": voice, "response_format": "pcm"}
    r = await client.post("audio/speech", json=body)
    if r.status_code != 200:
        raise RuntimeError(f"/audio/speech returned {r.status_code}: {r.text[:200]}")
    return r.content


async def measure_m1(
    client: httpx.AsyncClient, pcm24: bytes, phrase: Phrase, *, model: str = "whisper-1"
) -> dict:
    start = time.perf_counter()
    r = await client.post(
        "audio/transcriptions",
        data={"model": model, "response_format": "json", "language": phrase.lang},
        files={"file": ("utterance.wav", pcm_to_wav(pcm24, TTS_RATE), "audio/wav")},
    )
    elapsed = time.perf_counter() - start
    if r.status_code != 200:
        raise RuntimeError(f"/audio/transcriptions returned {r.status_code}: {r.text[:200]}")
    return {"stt_s": elapsed, "m1_s": M1_HANGOVER_S + elapsed, "m1_text": r.json().get("text", "")}


def _connect(url: str, api_key: str | None):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    return websockets.connect(url, additional_headers=headers, max_size=None)


async def _open(ws, languages: list[str], extra: dict | None = None) -> dict:
    await ws.send(json.dumps({"type": "session.update", "languages": languages, **(extra or {})}))
    while True:
        msg = await asyncio.wait_for(ws.recv(), 60)
        if isinstance(msg, bytes):
            continue
        event = json.loads(msg)
        if event["type"] == "ready":
            return event
        if event["type"] == "error":
            raise RuntimeError(f"session refused: {event}")


async def measure_listen(
    url: str,
    pcm16k: bytes,
    reference: str,
    lang: str,
    *,
    api_key: str | None = None,
    languages: list[str] | None = None,
    lead_s: float = 0.4,
    trail_s: float = 1.5,
    timeout_s: float = 5.0,
) -> dict:
    """Stream one utterance at real-time pace and time what the server says back."""
    silence = bytes(FRAME_BYTES)
    marks: dict[str, float] = {}
    events: list[tuple[float, dict]] = []
    async with _connect(url, api_key) as ws:
        await _open(ws, languages or ["en", "zh"])

        async def feed() -> None:
            frames = [silence] * round(lead_s / FRAME_S)
            lead = len(frames)
            frames += [
                pcm16k[i : i + FRAME_BYTES].ljust(FRAME_BYTES, b"\0")
                for i in range(0, len(pcm16k), FRAME_BYTES)
            ]
            speech_last = len(frames) - 1
            frames += [silence] * round(trail_s / FRAME_S)
            t0 = time.perf_counter()
            for i, frame in enumerate(frames):
                delay = t0 + i * FRAME_S - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
                await ws.send(frame)
                if i == lead:
                    marks["speech_start"] = time.perf_counter()
                if i == speech_last:
                    marks["speech_end"] = time.perf_counter()

        feeder = asyncio.create_task(feed())
        try:
            # The server may end a turn early, at a pause inside the utterance. Keep reading until a turn ends
            # after the last speech frame was sent; that is the one whose latency is measured.
            while not any(
                e["type"] == "transcript.final" and t > marks.get("speech_end", float("inf"))
                for t, e in events
            ):
                limit = (
                    timeout_s if feeder.done() else lead_s + len(pcm16k) / (IN_RATE * 2) + trail_s + timeout_s
                )
                msg = await asyncio.wait_for(ws.recv(), limit)
                if isinstance(msg, bytes):
                    continue
                event = json.loads(msg)
                events.append((time.perf_counter(), event))
                if event["type"] == "error":
                    raise RuntimeError(f"session error: {event}")
        finally:
            feeder.cancel()
            await asyncio.gather(feeder, return_exceptions=True)
    finals = [(t, e) for t, e in events if e["type"] == "transcript.final"]
    final_at, final = finals[-1]
    start = marks["speech_start"]
    partial_at = next((t for t, e in events if e["type"] == "transcript.partial"), None)
    started_at = next((t for t, e in events if e["type"] == "speech.started"), None)
    text = " ".join(e["text"] for _, e in finals if e["text"])
    row = {
        "lang": lang,
        "text": reference,
        "final_text": text,
        "final_after_end_s": final_at - marks["speech_end"],
        "first_partial_s": None if partial_at is None else partial_at - start,
        "speech_started_s": None if started_at is None else started_at - start,
        "turns": len(finals),
        "partials": sum(1 for _, e in events if e["type"] == "transcript.partial"),
        "ms_turn": final.get("ms", {}).get("turn"),
        "ms_stt": final.get("ms", {}).get("stt"),
    }
    row["cer" if lang == "zh" else "wer"] = (cer if lang == "zh" else wer)(reference, text)
    return row


async def measure_speak(
    url: str,
    text: str,
    lang: str,
    *,
    api_key: str | None = None,
    languages: list[str] | None = None,
    timeout_s: float = 60.0,
) -> dict:
    async with _connect(url, api_key) as ws:
        await _open(ws, languages or ["en", "zh"])
        sent = time.perf_counter()
        await ws.send(json.dumps({"type": "speak", "id": "bench", "text": text, "final": True}))
        first = None
        nbytes = 0
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout_s)
            now = time.perf_counter()
            if isinstance(msg, bytes):
                if first is None:
                    first = now - sent
                nbytes += len(msg)
                continue
            event = json.loads(msg)
            if event["type"] == "error":
                raise RuntimeError(f"session error: {event}")
            if event["type"] == "audio.done":
                return {
                    "lang": lang,
                    "text": text,
                    "first_audio_s": first if first is not None else now - sent,
                    "done_s": now - sent,
                    "audio_s": nbytes / (TTS_RATE * 2),
                }


async def run(
    url: str,
    *,
    api_key: str | None = None,
    runs: int = 3,
    phrases: list[Phrase] | None = None,
    voice: str = "default",
    tts_model: str = "tts-1",
    stt_model: str = "whisper-1",
    lead_s: float = 0.4,
    trail_s: float = 1.5,
    languages: list[str] | None = None,
) -> dict:
    listen, speak, m1 = [], [], []
    async with make_client(http_base(url), api_key) as client:
        for phrase in phrases or PHRASES:
            pcm24 = await synthesize(client, phrase.text, voice=voice, model=tts_model)
            pcm16 = resample_24k_to_16k(pcm24)
            for _ in range(runs):
                row = await measure_listen(
                    url, pcm16, phrase.text, phrase.lang, api_key=api_key, languages=languages,
                    lead_s=lead_s, trail_s=trail_s,
                )  # fmt: skip
                base = await measure_m1(client, pcm24, phrase, model=stt_model)
                row.update(base)
                row["m1_text"] = base["m1_text"]
                listen.append(row)
                m1.append({"lang": phrase.lang, "text": phrase.text, **base})
                speak.append(
                    await measure_speak(url, phrase.text, phrase.lang, api_key=api_key, languages=languages)
                )
    return {"listen": listen, "speak": speak, "m1": m1, "m1_hangover_s": M1_HANGOVER_S}


def _line(label: str, vals: list[float], unit: str = "") -> str:
    vals = [v for v in vals if v is not None]
    if not vals:
        return f"  {label:<34}{0:>5}{'-':>12}{'-':>12}"
    return f"  {label:<34}{len(vals):>5}{percentile(vals, 50):>12.3f}{percentile(vals, 95):>12.3f}{unit}"


def format_table(report: dict) -> str:
    listen, speak = report["listen"], report["speak"]
    lines = [f"  {'metric':<34}{'n':>5}{'p50':>12}{'p95':>12}", "Listening (seconds unless noted)"]
    lines.append(_line("speech end -> transcript.final", [r["final_after_end_s"] for r in listen]))
    lines.append(_line("M1 equivalent (700 ms + POST stt)", [r["m1_s"] for r in listen]))
    lines.append(_line("  POST /audio/transcriptions alone", [r["stt_s"] for r in listen]))
    lines.append(_line("first partial after speech start", [r["first_partial_s"] for r in listen]))
    lines.append(_line("server ms.turn (ms)", [r["ms_turn"] for r in listen]))
    lines.append(_line("server ms.stt (ms)", [r["ms_stt"] for r in listen]))
    lines.append(_line("WER (en)", [r["wer"] for r in listen if "wer" in r]))
    lines.append(_line("CER (zh)", [r["cer"] for r in listen if "cer" in r]))
    lines += ["Speaking", _line("speak -> first audio frame", [r["first_audio_s"] for r in speak])]
    lines.append(_line("speak -> audio.done", [r["done_s"] for r in speak]))
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m bench.session", description=__doc__)
    p.add_argument("--url", default="ws://localhost:8790/v1/speech/session")
    p.add_argument("--api-key")
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--voice", default="default")
    p.add_argument("--tts-model", default="tts-1")
    p.add_argument("--stt-model", default="whisper-1")
    p.add_argument("--lead", type=float, default=0.4, help="leading silence, seconds")
    p.add_argument("--trail", type=float, default=1.5, help="trailing silence, seconds")
    p.add_argument("--languages", default="en,zh", help="comma-separated, sent in session.update")
    p.add_argument("--json", type=Path, help="write the full report here")
    return p.parse_args(argv)


async def _amain(args: argparse.Namespace) -> None:
    report = await run(
        args.url,
        api_key=args.api_key,
        runs=args.runs,
        voice=args.voice,
        tts_model=args.tts_model,
        stt_model=args.stt_model,
        lead_s=args.lead,
        trail_s=args.trail,
        languages=[x.strip() for x in args.languages.split(",") if x.strip()],
    )
    print(format_table(report))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> None:
    asyncio.run(_amain(parse_args(argv)))


if __name__ == "__main__":
    main()
