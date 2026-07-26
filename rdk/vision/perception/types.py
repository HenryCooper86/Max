"""Shared value types for the perception and ADAS pipeline.

Every box in this module is expressed as a fraction of the source frame, in
[0, 1] — never pixels. Two reasons: the suppression constants
(CORRIDOR_WIDTH_FRAC, TAILGATE_HEIGHT_FRAC) are then resolution-independent,
and a clip replayed at a different resolution than it was captured cannot
silently produce different alerts.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Detection:
    cls: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2.0


@dataclass(frozen=True)
class BoxSample:
    """One observation of a track, stamped with the frame's own capture time."""

    t_ms: int
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0


@dataclass
class Track:
    track_id: int
    cls: str
    samples: list[BoxSample] = field(default_factory=list)
    #: Consecutive frames this track was not matched. Drives ageing out.
    misses: int = 0

    @property
    def last(self) -> BoxSample:
        return self.samples[-1]

    @property
    def frames(self) -> int:
        return len(self.samples)


@dataclass(frozen=True)
class EgoState:
    moving: bool
    #: Coarse, unitless. Optical flow magnitude, not a calibrated speed.
    speed_scale: float


@dataclass(frozen=True)
class Candidate:
    threat_id: str
    severity: str
    camera: str
    track_id: int
    t_ms: int
    #: None when the track is not closing. Absence is a category, not a big number.
    ttc_s: float | None
