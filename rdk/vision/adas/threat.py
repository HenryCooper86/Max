"""The four threat rules. Pure — no camera, no BPU, no I/O, no clock of its own.

This purity is the point. The offline harness and the on-bike runtime import
this same module, so a threshold tuned against recorded rides is literally the
code that fires on the road.

Every constant here is a STARTING VALUE from the parent spec, not a measured
result. They are conservative by design: a false alert at 100 km/h can cause the
crash it was meant to prevent, so thresholds loosen only against measured data,
never a hunch. The constants themselves now live in `tuning.py`; the names
below are aliases of `DEFAULT`'s fields kept for existing imports.
"""

from __future__ import annotations

from perception.types import Candidate, EgoState, Track

from .ttc import height_rate, time_to_contact
from .tuning import DEFAULT, Tuning

TTC_FORWARD_COLLISION = DEFAULT.ttc_forward_collision_s
TTC_PEDESTRIAN_AHEAD = DEFAULT.ttc_pedestrian_ahead_s
TTC_REAR_APPROACH = DEFAULT.ttc_rear_approach_s

#: Box-height fraction per second separating "approaching" from "just close".
CLOSING_RATE_MIN = DEFAULT.closing_rate_min
TAILGATE_HEIGHT_FRAC = DEFAULT.tailgate_height_frac
TAILGATE_DWELL_S = DEFAULT.tailgate_dwell_s

#: Fraction of frame width, centred, that counts as the rider's path.
CORRIDOR_WIDTH_FRAC = DEFAULT.corridor_width_frac

VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck", "bicycle"}


def in_corridor(track: Track, tuning: Tuning = DEFAULT) -> bool:
    """Is the box centre inside the centred path corridor?

    Centre rather than any overlap: a wide truck in the next lane clips the
    corridor edge constantly, and alerting on that trains the rider to ignore us.
    """
    half = tuning.corridor_width_frac / 2.0
    return abs(track.last.cx - 0.5) <= half


def _dwell_s(track: Track, min_height: float) -> float:
    """How long the box has been continuously at or above `min_height`."""
    dwell_from = None
    for sample in reversed(track.samples):
        if sample.height < min_height:
            break
        dwell_from = sample.t_ms
    if dwell_from is None:
        return 0.0
    return (track.last.t_ms - dwell_from) / 1000.0


def evaluate(
    tracks: list[Track], ego: EgoState, t_ms: int, camera: str, tuning: Tuning = DEFAULT
) -> list[Candidate]:
    """Threat candidates for one frame. Suppression is a separate stage."""
    # Stage 1 of the suppression stack, applied here because a stopped bike has
    # no threats by definition rather than suppressed ones.
    if not ego.moving:
        return []

    out: list[Candidate] = []
    for track in tracks:
        if not in_corridor(track, tuning):
            continue
        ttc = time_to_contact(track, window_ms=tuning.ttc_window_ms, tau_ms=tuning.smoothing_tau_ms)
        rate = height_rate(track, window_ms=tuning.ttc_window_ms, tau_ms=tuning.smoothing_tau_ms)

        if camera == "front":
            if (
                track.cls in VEHICLE_CLASSES
                and ttc is not None
                and ttc < tuning.ttc_forward_collision_s
            ):
                out.append(_candidate("forward_collision", "critical", camera, track, t_ms, ttc))
            elif (
                track.cls == "person" and ttc is not None and ttc < tuning.ttc_pedestrian_ahead_s
            ):
                out.append(_candidate("pedestrian_ahead", "critical", camera, track, t_ms, ttc))
            continue

        # Rear camera. The two rear threats are separated by closing rate, not
        # distance: without that, every normally-following car fires the
        # critical alert.
        closing = rate is not None and rate > tuning.closing_rate_min
        if (
            track.cls in VEHICLE_CLASSES
            and closing
            and ttc is not None
            and ttc < tuning.ttc_rear_approach_s
        ):
            out.append(_candidate("rear_approach", "critical", camera, track, t_ms, ttc))
        elif (
            track.cls in VEHICLE_CLASSES
            and not closing
            and track.last.height > tuning.tailgate_height_frac
            and _dwell_s(track, tuning.tailgate_height_frac) > tuning.tailgate_dwell_s
        ):
            out.append(_candidate("tailgating", "caution", camera, track, t_ms, ttc))

    return out


def _candidate(
    threat_id: str, severity: str, camera: str, track: Track, t_ms: int, ttc: float | None
) -> Candidate:
    return Candidate(
        threat_id=threat_id,
        severity=severity,
        camera=camera,
        track_id=track.track_id,
        t_ms=t_ms,
        ttc_s=ttc,
    )
