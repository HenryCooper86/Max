"""Score a ride's live shadow log against its hazard labels — the M1 gate,
measured. The log already holds what the deployed pipeline did; no re-run, no
reconstruction. Numbers are only ever computed from inputs that exist.

    python3 -m tools.evaluate ./corpus/ride-20260725-141900
    python3 -m tools.evaluate ./corpus/ride-20260725-141900 --tolerance-ms 1500 --json score.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowRecord, read_shadow, read_tuning
from corpus.labels import HazardWindow, read_labels
from recorder.metadata import read_metadata


@dataclass(frozen=True)
class ThreatScore:
    threat: str
    camera: str
    hits: int          # windows with >= 1 matching alert
    missed: int        # windows with none
    false_alerts: int  # alerts matching no window


@dataclass(frozen=True)
class RideScore:
    duration_h: float
    per_threat: list[ThreatScore]
    false_alerts_total: int
    false_criticals: int
    false_alerts_per_hour: float
    fingerprints: list[str]
    gate_false_rate_ok: bool       # false_alerts_per_hour < 1.0
    gate_false_criticals_ok: bool  # false_criticals == 0


def score_ride(
    records: list[ShadowRecord],
    windows: list[HazardWindow],
    ride_start_wall_ms: int,
    duration_h: float,
    fingerprints: list[str],
    tolerance_ms: int = 1000,
) -> RideScore:
    window_hits = [0] * len(windows)
    false_alerts: list[ShadowRecord] = []
    for rec in records:
        rel = rec.wall_ms - ride_start_wall_ms
        matched = False
        for i, w in enumerate(windows):
            if (
                rec.threat_id == w.threat
                and rec.camera == w.camera
                and w.start_ms - tolerance_ms <= rel <= w.end_ms + tolerance_ms
            ):
                window_hits[i] += 1
                matched = True
                break
        if not matched:
            false_alerts.append(rec)

    keys = sorted({(w.threat, w.camera) for w in windows} | {(r.threat_id, r.camera) for r in false_alerts})
    per_threat = []
    for threat, camera in keys:
        hit = sum(1 for w, n in zip(windows, window_hits) if w.threat == threat and w.camera == camera and n > 0)
        missed = sum(1 for w, n in zip(windows, window_hits) if w.threat == threat and w.camera == camera and n == 0)
        false_n = sum(1 for r in false_alerts if r.threat_id == threat and r.camera == camera)
        per_threat.append(ThreatScore(threat=threat, camera=camera, hits=hit, missed=missed, false_alerts=false_n))

    false_total = len(false_alerts)
    false_criticals = sum(1 for r in false_alerts if r.severity == "critical")
    per_hour = (false_total / duration_h) if duration_h > 0 else float("inf")
    return RideScore(
        duration_h=duration_h,
        per_threat=per_threat,
        false_alerts_total=false_total,
        false_criticals=false_criticals,
        false_alerts_per_hour=per_hour,
        fingerprints=list(fingerprints),
        gate_false_rate_ok=per_hour < 1.0,
        gate_false_criticals_ok=false_criticals == 0,
    )


def load_ride(ride_dir: Path) -> tuple[list[ShadowRecord], list[str], int, float]:
    """Read everything score_ride needs from a recorded ride, failing loud (and
    actionably) the moment an input the ride is supposed to have is missing.

    Returns (records, fingerprints, ride_start_wall_ms, duration_h). Hazard
    labels are validated here too — a ride cannot be scored without them — but
    are not part of the return value; callers re-read them via read_labels
    once load_ride has confirmed they exist.
    """
    ride = Path(ride_dir)

    shadow_paths = sorted(ride.glob("shadow-*.jsonl"))
    if not shadow_paths:
        print(f"no shadow logs found (expected {ride}/shadow-*.jsonl)", file=sys.stderr)
        raise SystemExit(1)

    records: list[ShadowRecord] = []
    fingerprints: list[str] = []
    for path in shadow_paths:
        records.extend(read_shadow(path))
        for header in read_tuning(path):
            fp = header.get("fingerprint", "")
            if fp and fp not in fingerprints:
                fingerprints.append(fp)

    sidecar_paths = sorted(ride.glob("*/seg-*.jsonl"))
    if not sidecar_paths:
        print("no metadata sidecars (<camera>/seg-*.jsonl) — cannot measure ride duration", file=sys.stderr)
        raise SystemExit(1)

    wall = [m.wall_ms for p in sidecar_paths for m in read_metadata(p)]
    if not wall:
        print(
            f"metadata sidecars under {ride} contained no frames — cannot measure ride duration",
            file=sys.stderr,
        )
        raise SystemExit(1)

    start = min(wall)
    duration_h = (max(wall) - start) / 3_600_000

    if not read_labels(ride):
        print(
            f"no hazard labels for {ride} — label it before scoring:\n"
            f"  python3 -m tools.label add --ride {ride} threat:camera:start_ms:end_ms[:note]",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return records, fingerprints, start, duration_h


def _print_report(score: RideScore) -> None:
    header = f"{'threat':20} {'camera':6} {'hits':>5} {'missed':>7} {'false':>6}"
    print(header)
    for t in score.per_threat:
        print(f"{t.threat:20} {t.camera:6} {t.hits:>5} {t.missed:>7} {t.false_alerts:>6}")
    print()
    print(
        f"{score.false_alerts_total} false alert(s), {score.false_criticals} false critical(s) "
        f"over {score.duration_h:.2f}h — {score.false_alerts_per_hour:.2f} false alerts/hour"
    )
    print(f"tuning fingerprint(s): {', '.join(score.fingerprints) if score.fingerprints else '(none)'}")
    print(f"gate — false-alert rate < 1/hour: {'PASS' if score.gate_false_rate_ok else 'FAIL'}")
    print(f"gate — zero false criticals: {'PASS' if score.gate_false_criticals_ok else 'FAIL'}")
    print(
        "note: this only measures false alerts on this ride; missed-hazard "
        "regression needs a second corpus to compare against — record more rides."
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("ride", help="ride directory to score")
    parser.add_argument("--tolerance-ms", type=int, default=1000, help="match window slack in milliseconds")
    parser.add_argument("--json", dest="json_path", metavar="PATH", help="also write the score as JSON to PATH")
    args = parser.parse_args(argv)

    ride = Path(args.ride)
    records, fingerprints, start, duration_h = load_ride(ride)
    windows = read_labels(ride)

    score = score_ride(records, windows, start, duration_h, fingerprints, tolerance_ms=args.tolerance_ms)

    _print_report(score)

    if args.json_path:
        Path(args.json_path).write_text(json.dumps(asdict(score), indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
