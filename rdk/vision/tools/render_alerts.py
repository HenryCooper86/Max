"""Render the alert clips once, through Doubao TTS.

Pre-rendered rather than synthesised on demand: zero synthesis latency against a
2-second TTC budget, identical wording every time so the rider learns the sound,
and no network dependency at all. An ADAS alert that needs WiFi is not an ADAS
alert.

Direct TTS rather than capturing a realtime session, because the model
paraphrases — and a sound the rider is supposed to recognise cannot drift
between renders.

    DOUBAO_TTS_APPID=... DOUBAO_TTS_TOKEN=... \\
      python3 tools/render_alerts.py --out /opt/max/rdk/audio/alerts
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.catalog import CATALOG

#: alert-player.ts rejects any other rate: playback.write consumes 24 kHz.
RATE = 24_000
ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts"


def wav_bytes(pcm: bytes, rate: int = RATE) -> bytes:
    """Wrap raw mono PCM16 in a WAV header alert-player.ts will accept."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def render(synth: Callable[[str], bytes], out_dir: Path | str) -> list[Path]:
    """Write one WAV per catalog entry. `synth` returns raw PCM16 at RATE.

    Filenames are the threat ids, because that is what alert-player.ts opens.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for threat, entry in CATALOG.items():
        pcm = synth(entry["message"])
        path = out / f"{threat}.wav"
        path.write_bytes(wav_bytes(pcm))
        written.append(path)
    return written


def doubao_synth(text: str) -> bytes:
    """Call Doubao TTS and return raw PCM16 at RATE.

    These credentials are separate from the relay's: the relay only ever uses
    TTS inside a realtime session, and has no standalone synthesis path.
    """
    token = os.environ.get("DOUBAO_TTS_TOKEN")
    appid = os.environ.get("DOUBAO_TTS_APPID")
    voice = os.environ.get("DOUBAO_TTS_VOICE", "zh_female_qingxin")
    if not token or not appid:
        raise SystemExit("set DOUBAO_TTS_APPID and DOUBAO_TTS_TOKEN")

    payload = {
        "app": {"appid": appid, "token": token, "cluster": "volcano_tts"},
        "user": {"uid": "max-adas"},
        "audio": {"voice_type": voice, "encoding": "pcm", "rate": RATE},
        "request": {"reqid": text[:16] or "alert", "text": text, "operation": "query"},
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer;{token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.loads(response.read().decode())
    if "data" not in body:
        raise SystemExit(f"TTS failed: {body}")
    return base64.b64decode(body["data"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/opt/max/rdk/audio/alerts")
    args = parser.parse_args()
    for path in render(doubao_synth, args.out):
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
