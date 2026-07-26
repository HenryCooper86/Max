"""Sustained inference, to find the thermal and throughput ceiling.

Run with the voice pipeline live. That is the only configuration that ships,
and idle is already 75.5 C with max-aec running — the parent spec's 71 C
predates the voice work, so ADAS has less headroom than it assumed.

    python3 tools/soak.py --clip ride.mp4 --minutes 10 --streams 2
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ego_motion import estimate
from perception.detector import Detector
from perception.frame_source import FileSource

MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def temps() -> dict[str, float]:
    out = subprocess.run(["hrut_somstatus"], capture_output=True).stdout.decode()
    found: dict[str, float] = {}
    for line in out.splitlines():
        stripped = line.strip()
        for key in ("CPU", "BPU", "DDR"):
            if stripped.startswith(key):
                try:
                    found[key] = float(stripped.split(":")[1].split("(")[0])
                except (IndexError, ValueError):
                    pass
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", required=True)
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--streams", type=int, default=2)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()

    detector = Detector(args.model)
    frames = list(FileSource(args.clip, camera="front", fps=10.0).frames())
    if not frames:
        raise SystemExit("clip yielded no frames")

    print(f"start temps: {temps()}", flush=True)
    started = time.monotonic()
    deadline = started + args.minutes * 60
    last_report = started
    count = 0
    index = 0
    peak = dict(temps())

    while time.monotonic() < deadline:
        frame = frames[index % len(frames)]
        previous = frames[(index - 1) % len(frames)]
        index += 1
        for _ in range(args.streams):
            detector.infer(frame.nv12, frame.width, frame.height)
            count += 1
        # Ego motion runs once per frame on the front camera only, exactly as
        # the pipeline does it. Leaving it out would understate the real load.
        estimate(previous.nv12, frame.nv12, frame.width, frame.height)

        if time.monotonic() - last_report >= 30:
            elapsed = time.monotonic() - started
            now = temps()
            for key, value in now.items():
                peak[key] = max(peak.get(key, value), value)
            print(
                f"{elapsed:6.0f}s  {count / elapsed:5.1f} inf/s  "
                f"({count / elapsed / args.streams:4.1f} fps/camera)  {now}",
                flush=True,
            )
            last_report = time.monotonic()

    elapsed = time.monotonic() - started
    print(f"\nsustained {count / elapsed:.1f} inferences/s over {elapsed / 60:.1f} min")
    print(f"that is {count / elapsed / args.streams:.1f} fps per camera with {args.streams} streams")
    print(f"end temps: {temps()}")
    print(f"peak temps: {peak}")


if __name__ == "__main__":
    main()
