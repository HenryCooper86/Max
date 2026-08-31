"""Ride-relative frame timestamps, and an end to the stream.

Segment citation no longer comes from frame-time arithmetic: ``run_camera``
now asks the recorder's ``SegmentClock`` (see ``recorder/segmenter.py``) which
segment is live and when it started, because the recorder is the only
component that knows real segment boundaries. ``RebasedSource`` still earns
its place for two other reasons:

(a) It gives ADAS ride-relative frame times whose ``t_ms`` starts near zero. A
live camera's frames carry the ROS header stamp, which is board uptime —
2,992,848 ms measured on 2026-07-27, not seconds since the ride began. Left
unrebased, that raw stamp would reach the tracker's gap logic (`max_gap_ms`
compares `t_ms` deltas) and every shadow record's `t_ms` field, both of which
assume a ride-relative clock. Rebasing here keeps both sane.

(b) The stop event ends the stream: ``MipiCamera.frames()`` runs until the
camera itself stops, so without it an ADAS thread would outlive the ride that
started it.

Rebasing here rather than in ``MipiCamera`` keeps the camera reporting absolute
capture time, which is what every other consumer wants.
"""

from __future__ import annotations

import threading
from dataclasses import replace
from typing import Iterator

from perception.frame_source import Frame


class RebasedSource:
    def __init__(self, source, stop: threading.Event | None = None) -> None:
        self.source = source
        self.stop = stop

    def frames(self) -> Iterator[Frame]:
        base: int | None = None
        for frame in self.source.frames():
            if self.stop is not None and self.stop.is_set():
                return
            if base is None:
                base = frame.t_ms
            yield replace(frame, t_ms=frame.t_ms - base)
