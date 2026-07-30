"""The on-bike loop. A thin driver around M1's pure modules.

It owns cameras, timing and bookkeeping; every decision belongs to threat.py
and suppress.py, imported unchanged. That is what makes a threshold tuned
against recorded rides the same code that fires on the road.

Nothing here plays audio. The agent decides that, and only when armed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from perception.tracker import Tracker
from perception.types import Detection, EgoState
from recorder.segmenter import SegmentClock

from .catalog import CATALOG
from .ego_motion import estimate
from .shadow import ShadowLog, ShadowRecord
from .suppress import Suppressor
from .threat import evaluate
from .ttc import height_rate
from .tuning import DEFAULT, Tuning, fingerprint


class RecordingRequired(RuntimeError):
    """Shadow mode without a recorder produces alerts nobody can review."""


@dataclass
class RuntimeConfig:
    ride_id: str
    camera: str
    #: Shadow mode is meaningless without clips to review; see the M2 spec.
    recording: bool = True
    #: Injected in tests; None means use the detector passed to run_camera.
    detect: Callable[[object, int], list[Detection]] | None = None
    #: The recorder's live view of which segment is being written and when it
    #: started. None (e.g. before the first roll) is a real, expected state —
    #: not a wiring error — so callers are not forced to supply one.
    segment_clock: SegmentClock | None = None
    tuning: Tuning = DEFAULT


def run_camera(
    source,
    config: RuntimeConfig,
    shadow: ShadowLog,
    emit: Callable[[dict], None],
    detector=None,
) -> int:
    """Drive one camera until its frames run out. Returns alerts fired."""
    if not config.recording:
        raise RecordingRequired(
            "shadow mode needs the recorder running: an unreviewable "
            "false-alarm rate is worse than none"
        )

    # Computed once per run rather than per record: the constants cannot
    # change mid-run, and re-hashing per alert would be wasted work.
    record_fingerprint = fingerprint(config.tuning)

    detect = config.detect
    if detect is None:
        if detector is None:
            raise ValueError("run_camera needs either config.detect or a detector")
        captured = detector

        def detect(frame, _index):
            return captured.infer(frame.nv12, frame.width, frame.height)

    tracker = Tracker(
        iou_threshold=config.tuning.iou_threshold,
        max_misses=config.tuning.max_misses,
        max_gap_ms=config.tuning.max_gap_ms,
    )
    suppressor = Suppressor(
        min_track_frames=config.tuning.min_track_frames,
        min_ttc_frames=config.tuning.min_ttc_frames,
        threat_cooldown_s=config.tuning.threat_cooldown_s,
        global_gap_s=config.tuning.global_gap_s,
    )
    previous_nv12: bytes | None = None
    fired = 0

    for index, frame in enumerate(source.frames()):
        dets = detect(frame, index)

        if previous_nv12 is None:
            ego = EgoState(moving=False, speed_scale=0.0)
        else:
            ego = estimate(previous_nv12, frame.nv12, frame.width, frame.height)
        previous_nv12 = frame.nv12

        tracks = tracker.update(dets, frame.t_ms)
        by_id = {t.track_id: t for t in tracks}
        candidates = evaluate(tracks, ego, frame.t_ms, config.camera, tuning=config.tuning)
        admitted = suppressor.admit(
            candidates, {t.track_id: t.frames for t in tracks}, frame.t_ms
        )

        for alert in admitted:
            track = by_id.get(alert.track_id)
            wall_ms = int(time.time() * 1000)
            current = config.segment_clock.current() if config.segment_clock else None
            if current is None:
                print(
                    f"[adas] {config.camera}: alert before any segment roll; segment unknown",
                    flush=True,
                )
                segment, segment_offset_ms = "", -1
            else:
                segment, started_wall_ms = current
                segment_offset_ms = wall_ms - started_wall_ms
            shadow.append(
                ShadowRecord(
                    threat_id=alert.threat_id,
                    severity=alert.severity,
                    camera=alert.camera,
                    t_ms=alert.t_ms,
                    wall_ms=wall_ms,
                    ttc_s=alert.ttc_s,
                    ride_id=config.ride_id,
                    segment=segment,
                    segment_offset_ms=segment_offset_ms,
                    track_id=alert.track_id,
                    box_height=track.last.height if track else 0.0,
                    closing_rate=height_rate(track) if track else None,
                    track_frames=track.frames if track else 0,
                    ego_moving=ego.moving,
                    tuning=record_fingerprint,
                )
            )
            entry = CATALOG.get(alert.threat_id, {})
            emit(
                {
                    "event": "hazard",
                    "threat": alert.threat_id,
                    "severity": alert.severity,
                    "direction": entry.get("direction", alert.camera),
                    "label": entry.get("label", alert.threat_id),
                    "message": entry.get("message", ""),
                    "advice": entry.get("advice", ""),
                    "ttcSeconds": alert.ttc_s,
                }
            )
            fired += 1

    return fired
