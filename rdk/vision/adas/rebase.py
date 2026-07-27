"""Ride-relative frame timestamps, and an end to the stream.

``run_camera`` picks a segment with ``frame.t_ms / 1000 / segment_seconds``,
which assumes t_ms starts near zero at ride start. ``FileSource`` satisfies that.
A live camera does not: frames carry the ROS header stamp, which is board uptime
— 2,992,848 ms measured on 2026-07-27. Unrebased, every shadow record would cite
a segment index in the tens of thousands and ``tools/clip.py`` would find nothing.

Rebasing here rather than in ``MipiCamera`` keeps the camera reporting absolute
capture time, which is what every other consumer wants.

The stop event is the other half: ``MipiCamera.frames()`` runs until the camera
itself stops, so without it an ADAS thread would outlive the ride that started it.
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
