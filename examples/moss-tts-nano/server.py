#!/usr/bin/env python3
"""
MOSS-TTS-Nano behind an OpenAI-compatible speech API, for Max's `local` voice pipeline.

MOSS-TTS-Nano (https://github.com/OpenMOSS/MOSS-TTS-Nano, Apache-2.0) is a
0.1B-parameter multilingual text-to-speech model from OpenMOSS that runs on a
CPU through ONNX Runtime. Its own demo server has no OpenAI-style endpoint;
this file adds one, so the relay can use it like any other speech server:

    POST /v1/audio/speech   {"model": "moss-tts-nano", "input": "Hello!", "voice": "Junhao",
                             "response_format": "wav" | "pcm"}
    GET  /v1/audio/voices   the built-in voices and your cloned ones
    GET  /v1/models
    GET  /health

Run it from a MOSS-TTS-Nano checkout (see README.md next to this file):

    python /path/to/Max/examples/moss-tts-nano/server.py --voices-dir ./my-voices

`voice` is a built-in voice name, or the name of a WAV file in --voices-dir
(`--voices-dir ./my-voices` + `"voice": "ava"` clones ./my-voices/ava.wav).
Anything else falls back to the default voice, so voice names meant for
another server (Kokoro's af_heart) still produce speech.

Only the Python standard library is used here; MOSS-TTS-Nano brings numpy.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import re
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MODEL_ID = "moss-tts-nano"
MAX_INPUT_CHARS = 4000
MAX_BODY_BYTES = 64 * 1024
VOICE_FILE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PCM_RATE = 24_000

log = logging.getLogger("moss-tts-nano-server")


def to_int16_frames(waveform: Any) -> tuple[bytes, int]:
    """(interleaved PCM16 little-endian bytes, channel count) from a float waveform shaped
    (samples,) or (samples, channels)."""
    import numpy as np

    data = np.asarray(waveform, dtype=np.float32)
    if data.ndim == 1:
        data = data[:, None]
    if data.ndim != 2:
        raise ValueError(f"unexpected waveform shape {data.shape}")
    # Some codecs return (channels, samples); a speech clip is never 1-2 samples long.
    if data.shape[0] <= 2 < data.shape[1]:
        data = data.T
    clipped = np.clip(data, -1.0, 1.0)
    return (clipped * 32767.0).round().astype("<i2").tobytes(), int(data.shape[1])


def wav_bytes(pcm: bytes, channels: int, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm)
    return buffer.getvalue()


def mono_pcm_24k(waveform: Any, sample_rate: int) -> bytes:
    """Raw 24 kHz mono PCM16, for servers asked for response_format "pcm"."""
    import numpy as np

    data = np.asarray(waveform, dtype=np.float32)
    if data.ndim == 2:
        if data.shape[0] <= 2 < data.shape[1]:
            data = data.T
        data = data.mean(axis=1)
    if sample_rate != PCM_RATE and data.size:
        count = max(1, int(round(data.size * PCM_RATE / sample_rate)))
        data = np.interp(np.linspace(0, data.size - 1, count), np.arange(data.size), data)
    return (np.clip(data, -1.0, 1.0) * 32767.0).round().astype("<i2").tobytes()


class Speaker:
    """The model, its voices and a lock: ONNX sessions here are not shared between requests."""

    def __init__(self, runtime: Any, voices_dir: Path | None, default_voice: str | None) -> None:
        self.runtime = runtime
        self.voices_dir = voices_dir
        self.lock = threading.Lock()
        self.builtin = [str(item["voice"]) for item in runtime.list_builtin_voices()]
        self.default_voice = default_voice if default_voice in self.builtin else (self.builtin or [None])[0]

    def cloned(self) -> list[str]:
        if not self.voices_dir or not self.voices_dir.is_dir():
            return []
        return sorted(path.stem for path in self.voices_dir.glob("*.wav") if VOICE_FILE.match(path.stem))

    def resolve(self, voice: str) -> tuple[str | None, Path | None]:
        """(built-in voice, reference clip) for a requested voice name."""
        if voice in self.builtin:
            return voice, None
        if self.voices_dir and VOICE_FILE.match(voice):
            clip = self.voices_dir / f"{voice}.wav"
            if clip.is_file():
                return None, clip
        if voice:
            log.info("unknown voice %r: using %s", voice, self.default_voice)
        return self.default_voice, None

    def speak(self, text: str, voice: str) -> tuple[Any, int]:
        builtin, clip = self.resolve(voice)
        with self.lock, tempfile.TemporaryDirectory() as scratch:
            result = self.runtime.synthesize(
                text=text,
                voice=builtin,
                prompt_audio_path=str(clip) if clip else None,
                output_audio_path=str(Path(scratch) / "speech.wav"),
                streaming=True,
            )
        return result["waveform"], int(result["sample_rate"])


def make_handler(speaker: Speaker) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "moss-tts-nano-openai/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quieter than the default
            log.debug("%s %s", self.address_string(), fmt % args)

        def send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def fail(self, status: int, message: str) -> None:
            self.send_json(status, {"error": {"message": message, "type": "invalid_request_error"}})

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            path = self.path.split("?", 1)[0].rstrip("/")
            if path in ("/health", ""):
                self.send_json(200, {"status": "ok", "model": MODEL_ID})
            elif path == "/v1/models":
                self.send_json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})
            elif path == "/v1/audio/voices":
                self.send_json(200, {"voices": speaker.builtin + speaker.cloned(), "default": speaker.default_voice})
            else:
                self.fail(404, "Not found")

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0].rstrip("/") != "/v1/audio/speech":
                self.fail(404, "Not found")
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self.fail(413 if length > MAX_BODY_BYTES else 400, "Send a JSON body.")
                return
            try:
                request = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.fail(400, "The body is not JSON.")
                return
            if not isinstance(request, dict):
                self.fail(400, "The body must be a JSON object.")
                return
            text = request.get("input")
            if not isinstance(text, str) or not text.strip():
                self.fail(400, "`input` must be non-empty text.")
                return
            if len(text) > MAX_INPUT_CHARS:
                self.fail(400, f"`input` must be at most {MAX_INPUT_CHARS} characters.")
                return
            response_format = request.get("response_format") or "wav"
            if response_format not in ("wav", "pcm"):
                self.fail(400, "`response_format` must be wav or pcm.")
                return
            voice = request.get("voice") if isinstance(request.get("voice"), str) else ""
            started = time.monotonic()
            try:
                waveform, sample_rate = speaker.speak(text.strip(), voice)
            except Exception as error:  # the model's own errors, reported to the caller
                log.exception("synthesis failed")
                self.fail(500, f"Synthesis failed: {error}")
                return
            if response_format == "pcm":
                body, content_type = mono_pcm_24k(waveform, sample_rate), "audio/pcm"
            else:
                pcm, channels = to_int16_frames(waveform)
                body, content_type = wav_bytes(pcm, channels, sample_rate), "audio/wav"
            log.info("spoke %d chars in %.2fs", len(text), time.monotonic() - started)
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1", help="Address to listen on (default 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8890, help="Port (default 8890).")
    parser.add_argument("--repo", default=".", help="MOSS-TTS-Nano checkout (default: the current folder).")
    parser.add_argument("--model-dir", default=None, help="ONNX model folder; downloaded on first run if omitted.")
    parser.add_argument("--voices-dir", default=None, help="Folder of WAV clips to clone, one voice per file.")
    parser.add_argument("--default-voice", default=None, help="Built-in voice for unknown names.")
    parser.add_argument("--cpu-threads", type=int, default=4, help="ONNX Runtime threads (default 4).")
    parser.add_argument("--execution-provider", default="cpu", help="cpu (default) or cuda.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    sys.path.insert(0, str(Path(args.repo).expanduser().resolve()))
    try:
        from onnx_tts_runtime import OnnxTtsRuntime  # type: ignore[import-not-found]
    except ImportError as error:
        raise SystemExit(
            f"Could not import MOSS-TTS-Nano ({error}). Run this from a MOSS-TTS-Nano checkout with its "
            "requirements installed, or pass --repo /path/to/MOSS-TTS-Nano."
        ) from error

    runtime = OnnxTtsRuntime(
        model_dir=args.model_dir,
        thread_count=args.cpu_threads,
        execution_provider=args.execution_provider,
    )
    voices_dir = Path(args.voices_dir).expanduser().resolve() if args.voices_dir else None
    speaker = Speaker(runtime, voices_dir, args.default_voice)
    log.info("built-in voices: %s", ", ".join(speaker.builtin) or "none")
    if voices_dir:
        log.info("cloned voices in %s: %s", voices_dir, ", ".join(speaker.cloned()) or "none yet")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(speaker))
    log.info("MOSS-TTS-Nano speech API on http://%s:%d/v1", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
