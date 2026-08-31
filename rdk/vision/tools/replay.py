"""Offline harness: a clip in, an alert sequence out.

This is the instrument M1 exists to build. It runs the identical modules the
on-bike runtime will run, differing only in where frames come from — which is
the whole reason for the FrameSource seam.

Detections are cached because tuning means many passes over one corpus and
re-running BPU inference each time would make the loop unusable. The cache is
keyed on (clip, model hash, confidence threshold), so changing the detector or
its threshold invalidates it automatically rather than silently tuning against
detections from a different model.

    python3 tools/replay.py ride.mp4 --camera front --out /tmp/replay
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ego_motion import estimate
from adas.suppress import Suppressor
from adas.threat import evaluate
from adas.tuning import DEFAULT, fingerprint
from perception.frame_source import FileSource
from perception.tracker import Tracker
from perception.types import Candidate, Detection, EgoState


@dataclass
class ReplayResult:
    alerts: list[Candidate] = field(default_factory=list)
    frames: int = 0
    detections: dict[int, list[Detection]] = field(default_factory=dict)
    latency_ms: list[float] = field(default_factory=list)


def cache_key(clip: str, model_hash: str, conf_threshold: float) -> str:
    raw = f"{Path(clip).name}|{model_hash}|{conf_threshold:.4f}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def run_clip(source, detect, camera: str, ego_moving: bool | None = None) -> ReplayResult:
    """Drive one clip through the full pipeline.

    `detect(frame, index) -> list[Detection]` is injected so the harness is
    testable without a BPU, and so a cached-detection run uses the identical
    code path as a live one.

    `ego_moving` forces the ego state; leave it None to estimate from the video.
    """
    tracker = Tracker()
    suppressor = Suppressor()
    result = ReplayResult()
    prev_y: bytes | None = None
    prev_t_ms: int | None = None

    for index, frame in enumerate(source.frames()):
        started = time.monotonic()
        dets = detect(frame, index)
        result.detections[index] = dets

        if ego_moving is None:
            if prev_y is None:
                ego = EgoState(moving=False, speed_scale=0.0)
            else:
                ego = estimate(
                    prev_y,
                    frame.nv12,
                    frame.width,
                    frame.height,
                    dt_ms=(frame.t_ms - prev_t_ms) if prev_t_ms is not None else None,
                    min_flow_px_per_s=DEFAULT.min_flow_px_per_s,
                )
            prev_y = frame.nv12
            prev_t_ms = frame.t_ms
        else:
            ego = EgoState(moving=ego_moving, speed_scale=1.0 if ego_moving else 0.0)

        tracks = tracker.update(dets, frame.t_ms)
        candidates = evaluate(tracks, ego, frame.t_ms, camera)
        track_frames = {t.track_id: t.frames for t in tracks}
        result.alerts.extend(suppressor.admit(candidates, track_frames, frame.t_ms))
        result.frames += 1
        result.latency_ms.append((time.monotonic() - started) * 1000.0)

    return result


def write_outputs(result: ReplayResult, out_dir: Path, clip: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    with (out_dir / "alerts.jsonl").open("w", encoding="utf-8") as fh:
        for alert in result.alerts:
            fh.write(json.dumps(asdict(alert), ensure_ascii=False) + "\n")

    latencies = sorted(result.latency_ms)
    duration_h = (result.frames / 10.0) / 3600.0 if result.frames else 0.0
    summary = {
        "clip": clip,
        "frames": result.frames,
        "alerts": len(result.alerts),
        "alerts_per_hour": (len(result.alerts) / duration_h) if duration_h else 0.0,
        "latency_ms_p50": statistics.median(latencies) if latencies else 0.0,
        "latency_ms_p95": latencies[int(len(latencies) * 0.95)] if latencies else 0.0,
        "by_threat": {
            threat: sum(1 for a in result.alerts if a.threat_id == threat)
            for threat in {a.threat_id for a in result.alerts}
        },
        "tuning_fingerprint": fingerprint(),
        # Stated plainly so no reader mistakes a clean run for a validated one.
        "tuning_status": "constants are untuned starting values; see the M1 spec",
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("clip")
    parser.add_argument("--camera", choices=["front", "rear"], required=True)
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--cache", default="/tmp/replay-cache")
    parser.add_argument("--out", default="/tmp/replay")
    args = parser.parse_args()

    model_hash = hashlib.sha256(Path(args.model).read_bytes()).hexdigest()[:16]
    cache_path = Path(args.cache) / f"{cache_key(args.clip, model_hash, args.conf)}.jsonl"

    if cache_path.exists():
        cached = [
            [Detection(**d) for d in json.loads(line)]
            for line in cache_path.read_text(encoding="utf-8").splitlines()
        ]
        print(f"using cached detections: {cache_path}")

        def detect(frame, index):
            return cached[index] if index < len(cached) else []

    else:
        from perception.detector import Detector

        detector = Detector(args.model, conf_threshold=args.conf)

        def detect(frame, index):
            return detector.infer(frame.nv12, frame.width, frame.height)

    source = FileSource(args.clip, camera=args.camera, fps=args.fps)
    result = run_clip(source, detect, camera=args.camera)

    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as fh:
            for index in sorted(result.detections):
                fh.write(json.dumps([asdict(d) for d in result.detections[index]]) + "\n")

    write_outputs(result, Path(args.out), clip=args.clip)
    print(f"{result.frames} frames, {len(result.alerts)} alerts -> {args.out}/summary.json")


if __name__ == "__main__":
    main()
