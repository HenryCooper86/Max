"""Cut the clip around a shadow alert out of the ride recording.

Shadow mode stores a timestamp, not frames. The recorder is already writing
continuous segments, so a rolling in-memory buffer would spend ~310 MB per
camera duplicating what is on disk — on a board whose memory and thermal
headroom are both tight.

The clips this produces are the same H.264 the corpus is made of, so reviewing
a false alarm and growing the tuning corpus are the same action.

    python3 tools/clip.py shadow.jsonl --index 0 --segments /var/lib/max/corpus/ride-001
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import read_shadow

BEFORE_S = 5.0
AFTER_S = 3.0


def clip_window(
    offset_ms: int, before_s: float = BEFORE_S, after_s: float = AFTER_S
) -> tuple[float, float]:
    """Return (start_seconds, duration_seconds), clamped to the segment start."""
    centre = offset_ms / 1000.0
    start = max(0.0, centre - before_s)
    duration = (centre - start) + after_s
    return start, duration


def extract(
    segment_path: Path | str,
    offset_ms: int,
    out_path: Path | str,
    before_s: float = BEFORE_S,
    after_s: float = AFTER_S,
) -> Path:
    segment = Path(segment_path)
    if not segment.exists():
        # Raise rather than write nothing: a zero-byte clip looks like an alert
        # with nothing to see, which is indistinguishable from a false alarm
        # nobody can explain.
        raise FileNotFoundError(segment)
    start, duration = clip_window(offset_ms, before_s, after_s)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(segment),
            "-t", f"{duration:.3f}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-y", str(out),
        ],
        check=True,
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("shadow")
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--segments", required=True)
    parser.add_argument("--out", default="/tmp/alert.mp4")
    args = parser.parse_args()

    records = read_shadow(args.shadow)
    if not 0 <= args.index < len(records):
        raise SystemExit(f"index {args.index} out of range; the log holds {len(records)}")
    record = records[args.index]
    out = extract(Path(args.segments) / record.segment, record.segment_offset_ms, args.out)
    print(f"{record.threat_id} @ {record.t_ms} ms -> {out}")


if __name__ == "__main__":
    main()
