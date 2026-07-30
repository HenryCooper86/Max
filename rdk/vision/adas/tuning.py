"""Every alert-affecting constant, in one frozen dataclass with a fingerprint.

Two shadow logs are comparable iff their fingerprints match. Before this
module, the constants lived spread across threat.py, ttc.py, suppress.py and
the Tracker defaults, and a ride recorded before a threshold change was
indistinguishable from one recorded after — the exact comparison the M1 gate
needs. The dataclass is also the injection seam threat.py's docstring always
promised: a sweep passes a Tuning, it does not edit source.

The fingerprint is not a complete provenance record: it does not cover the
detector's confidence/NMS thresholds, or the model binary's identity, so two
rides that differ only in one of those are not distinguished by fingerprint.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Tuning:
    # threat.py
    ttc_forward_collision_s: float = 2.0
    ttc_pedestrian_ahead_s: float = 2.5
    ttc_rear_approach_s: float = 3.0
    closing_rate_min: float = 0.08
    tailgate_height_frac: float = 0.45
    tailgate_dwell_s: float = 4.0
    corridor_width_frac: float = 0.5
    # ttc.py
    smoothing_tau_ms: float = 200.0
    ttc_window_ms: int = 300
    # adas/ego_motion.py
    #: Moving/stopped gate, in WORK_WIDTH pixels per second. 6.0 px/s equals
    #: the pre-time-basing 0.6 px per frame at the nominal 10 fps, so behavior
    #: at nominal rate is unchanged; a dropped frame no longer doubles
    #: apparent motion. This is the single most load-bearing suppression
    #: constant, previously outside the fingerprint.
    min_flow_px_per_s: float = 6.0
    # suppress.py
    min_track_frames: int = 3
    min_ttc_frames: int = 3
    threat_cooldown_s: float = 8.0
    global_gap_s: float = 4.0
    #: Consecutive-run grace: a candidate absent for up to this many frames
    #: keeps its stability-run credit. One detector flicker at 10 fps used to
    #: re-arm the 3-frame gate and blind the pipeline ~600 ms. 0 restores the
    #: strict consecutive rule.
    run_grace_frames: int = 1
    # perception/tracker.py
    iou_threshold: float = 0.3
    max_misses: int = 3
    max_gap_ms: int = 500
    #: Sliding window on Track.samples. Must exceed tailgate_dwell_s — the
    #: longest look-back any rule makes — because the window caps observable
    #: dwell, and a cap at or below the threshold means tailgating can never
    #: fire. The 300 ms TTC window is trivially inside. EMA at tau=200 ms
    #: weights anything older than 1 s below one percent, so trimming here
    #: changes smoothed heights by less than measurement noise.
    track_window_ms: int = 6_000

    def __post_init__(self) -> None:
        if self.track_window_ms <= self.tailgate_dwell_s * 1000:
            raise ValueError(
                "track_window_ms must exceed tailgate_dwell_s * 1000: the "
                "window caps observable dwell, and a cap at or below the "
                "threshold can never fire tailgating"
            )


DEFAULT = Tuning()


def fingerprint(tuning: Tuning = DEFAULT) -> str:
    """12 hex chars identifying a constant set. Stable across processes."""
    payload = json.dumps(asdict(tuning), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
