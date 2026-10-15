#!/usr/bin/env python3
"""Render the exact ADAS catalog as bundled synthetic WAVs; no microphone or network.

Run from the repository root: python3 scripts/generate-adas-warning-audio.py
Requires macOS say, the listed installed voices, Node/tsx, and ffmpeg.
"""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
VOICES = {"female": "Tingting", "male": "Eddy (Chinese (China mainland))"}


def main():
    for tool in ("node", "say", "ffmpeg"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is required")
    catalog = json.loads(subprocess.check_output([
        "node", "--import", "tsx", "--input-type=module", "-e",
        "import { ADAS_SCENARIOS } from './shared/adas.ts'; console.log(JSON.stringify(ADAS_SCENARIOS))"
    ], cwd=ROOT, text=True))
    output = ROOT / "public/audio/adas"
    assets = []
    with tempfile.TemporaryDirectory(prefix="max-warning-audio-") as temporary:
        source = Path(temporary) / "warning.aiff"
        for gender, voice in VOICES.items():
            (output / gender).mkdir(parents=True, exist_ok=True)
            for scenario in catalog:
                text = f"{scenario['message']} {scenario['advice']}"
                relative = f"{gender}/{scenario['threat']}.wav"
                target = output / relative
                subprocess.run(["say", "-v", voice, "-r", "210", "-o", str(source), text], check=True)
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                    "-map_metadata", "-1", "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
                    "-fflags", "+bitexact", "-flags:a", "+bitexact", str(target)
                ], check=True)
                data = target.read_bytes()
                with wave.open(io.BytesIO(data)) as wav:
                    samples = wav.getnframes()
                    pcm = wav.readframes(samples)
                wav_sha256 = hashlib.sha256(data).hexdigest()
                assets.append({
                    "threat": scenario["threat"], "gender": gender, "text": text,
                    "file": relative, "url": f"/audio/adas/{relative}?v={wav_sha256[:16]}", "voice": voice,
                    "samples": samples, "durationSeconds": samples / 24000,
                    "sha256": wav_sha256,
                    "pcmSha256": hashlib.sha256(pcm).hexdigest()
                })
    manifest = {
        "version": 1, "sampleRate": 24000, "channels": 1, "sampleFormat": "s16le",
        "attribution": "Synthetic speech rendered with Apple say; no microphone audio captured",
        "assets": assets
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Rendered {len(assets)} exact warning clips ({sum((output / a['file']).stat().st_size for a in assets)} bytes).")


if __name__ == "__main__":
    main()
