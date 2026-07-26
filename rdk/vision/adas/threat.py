"""The four threat rules. Pure — no camera, no BPU, no I/O, no clock of its own.

This purity is the point. The offline harness and the on-bike runtime import
this same module, so a threshold tuned against recorded rides is literally the
code that fires on the road.

Every constant here is a STARTING VALUE from the parent spec, not a measured
result. They are conservative by design: a false alert at 100 km/h can cause the
crash it was meant to prevent, so thresholds loosen only against measured data,
never a hunch.
"""

from __future__ import annotations

from perception.types import Candidate, EgoState, Track

from .ttc import height_rate, time_to_contact

TTC_FORWARD_COLLISION = 2.0
TTC_PEDESTRIAN_AHEAD = 2.5
TTC_REAR_APPROACH = 3.0

#: Box-height fraction per second separating "approaching" from "just close".
CLOSING_RATE_MIN = 0.08
TAILGATE_HEIGHT_FRAC = 0.45
TAILGATE_DWELL_S = 4.0

#: Fraction of frame width, centred, that counts as the rider's path.
CORRIDOR_WIDTH_FRAC = 0.5

VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck", "bicycle"}


def in_corridor(track: Track, width_frac: float = CORRIDOR_WIDTH_FRAC) -> bool:
    """Is the box centre inside the centred path corridor?

    Centre rather than any overlap: a wide truck in the next lane clips the
    corridor edge constantly, and alerting on that trains the rider to ignore us.
    """
    half = width_frac / 2.0
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


def evaluate(tracks: list[Track], ego: EgoState, t_ms: int, camera: str) -> list[Candidate]:
    """Threat candidates for one frame. Suppression is a separate stage."""
    # Stage 1 of the suppression stack, applied here because a stopped bike has
    # no threats by definition rather than suppressed ones.
    if not ego.moving:
        return []

    out: list[Candidate] = []
    for track in tracks:
        if not in_corridor(track):
            continue
        ttc = time_to_contact(track)
        rate = height_rate(track)

        if camera == "front":
            if track.cls in VEHICLE_CLASSES and ttc is not None and ttc < TTC_FORWARD_COLLISION:
                out.append(_candidate("forward_collision", "critical", camera, track, t_ms, ttc))
            elif track.cls == "person" and ttc is not None and ttc < TTC_PEDESTRIAN_AHEAD:
                out.append(_candidate("pedestrian_ahead", "critical", camera, track, t_ms, ttc))
            continue

        # Rear camera. The two rear threats are separated by closing rate, not
        # distance: without that, every normally-following car fires the
        # critical alert.
        closing = rate is not None and rate > CLOSING_RATE_MIN
        if track.cls in VEHICLE_CLASSES and closing and ttc is not None and ttc < TTC_REAR_APPROACH:
            out.append(_candidate("rear_approach", "critical", camera, track, t_ms, ttc))
        elif (
            track.cls in VEHICLE_CLASSES
            and not closing
            and track.last.height > TAILGATE_HEIGHT_FRAC
            and _dwell_s(track, TAILGATE_HEIGHT_FRAC) > TAILGATE_DWELL_S
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
