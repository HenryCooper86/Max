#!/usr/bin/env python3
"""Generate private synthetic 16 kHz PCM fixtures; requires macOS say and ffmpeg."""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import subprocess

PROMPTS = {
    "baseline": "Max，你好。请用一句话回答，你叫什么名字。",
    "wake-background": "今天的晚饭很好吃。大家一起聊聊天。",
    "wake-addressed": "Max，你在吗？请简单回答。",
    "emergency": "Max，前面突然有危险，我很紧张，现在应该怎么办？",
    "adas": "Max，请连续详细说明安全骑行的注意事项，至少讲二十秒。",
    "wind-clean": "Max，横风很大，还有风噪，我应该怎么办？",
    "network": "Max，刚才网络信号不好，连接恢复以后我应该注意什么？",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/tmp/max-synthetic-qa"))
    args = parser.parse_args()
    for program in ("say", "ffmpeg"):
        if not shutil.which(program):
            parser.error(f"{program} is required")
    root = args.output
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    fixtures = {}
    for name, text in PROMPTS.items():
        aiff, pcm = root / f"{name}.aiff", root / f"{name}.pcm"
        subprocess.run(["say", "-v", "Tingting", "-r", "190", "-o", str(aiff), text], check=True)
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(aiff),
            "-ar", "16000", "-ac", "1", "-f", "s16le", str(pcm)
        ], check=True)
        data = pcm.read_bytes()
        fixtures[name] = {
            "file": pcm.name, "text": text, "durationSeconds": len(data) / 32000,
            "sha256": hashlib.sha256(data).hexdigest()
        }
    samples = array.array("h")
    samples.frombytes((root / "wind-clean.pcm").read_bytes())
    rng, previous, noise = random.Random(20261014), 0.0, []
    for _ in samples:
        previous = 0.96 * previous + 0.04 * rng.uniform(-1, 1)
        noise.append(previous)
    voice_rms = math.sqrt(sum(x * x for x in samples) / len(samples))
    noise_rms = math.sqrt(sum(x * x for x in noise) / len(noise))
    scale = voice_rms / (10 ** (12 / 20) * noise_rms)
    mixed = array.array("h", (round(max(-32768, min(32767, x + scale * w)))
                              for x, w in zip(samples, noise)))
    data = mixed.tobytes()
    (root / "wind.pcm").write_bytes(data)
    fixtures["wind"] = {
        "file": "wind.pcm", "text": PROMPTS["wind-clean"], "durationSeconds": len(data) / 32000,
        "sha256": hashlib.sha256(data).hexdigest(), "syntheticWindSeed": 20261014,
        "snrDb": 12, "filter": "one-pole low-pass alpha 0.04"
    }
    manifest = {
        "version": 1, "sampleRate": 16000, "channels": 1, "sampleFormat": "s16le",
        "fixtures": fixtures, "attribution": "Synthetic generated speech; no microphone audio captured"
    }
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Generated {len(fixtures)} PCM fixtures in {root}; synthetic wind SNR 12 dB.")


if __name__ == "__main__":
    main()
