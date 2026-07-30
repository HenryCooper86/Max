"""Score a ride's live shadow log against its hazard labels — the M1 gate,
measured. The log already holds what the deployed pipeline did; no re-run, no
reconstruction. Numbers are only ever computed from inputs that exist.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowRecord
from corpus.labels import HazardWindow


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
