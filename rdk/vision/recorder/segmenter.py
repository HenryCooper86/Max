"""Segment rotation for ride recording.

Rides are cut into fixed-length segments so a power cut costs at most one
segment, and so the corpus is made of files a human can actually review.
"""

from __future__ import annotations

import threading
from datetime import datetime

#: Bounds power-loss damage to one minute of footage.
SEGMENT_SECONDS = 60


def segment_name(index: int) -> str:
    """Zero-padded so lexical order matches capture order in any file browser."""
    return f"seg-{index:06d}"


def ride_id(now: datetime) -> str:
    return f"ride-{now:%Y%m%d-%H%M%S}"


class Segmenter:
    def __init__(self, segment_seconds: float = SEGMENT_SECONDS) -> None:
        self.segment_seconds = segment_seconds
        self._index = -1
        self._started_at: float | None = None

    @property
    def index(self) -> int:
        return self._index

    def should_roll(self, now_s: float) -> bool:
        if self._started_at is None:
            return False
        return (now_s - self._started_at) >= self.segment_seconds

    def roll(self, now_s: float) -> int:
        """Start the next segment and return its index. The clock rebases to the
        actual roll time rather than the ideal one, so a late roll does not
        immediately trigger another."""
        self._index += 1
        self._started_at = now_s
        return self._index


class SegmentClock:
    """The recorder's live answer to "which segment is being written right now,
    and when did it start?" — one writer (the recorder), many readers (the
    ADAS runtime at alert time). The recorder is the only component that knows
    real segment boundaries: Segmenter.roll rebases on late rolls, so anything
    computing boundaries arithmetically drifts from the files on disk."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._current: tuple[str, int] | None = None

    def update(self, segment_name: str, started_wall_ms: int) -> None:
        with self._lock:
            self._current = (segment_name, started_wall_ms)

    def current(self) -> tuple[str, int] | None:
        with self._lock:
            return self._current
