import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.rebase import RebasedSource
from perception.frame_source import Frame


class FakeSource:
    def __init__(self, stamps, camera="front"):
        self.stamps = stamps
        self.camera = camera

    def frames(self):
        for t_ms in self.stamps:
            yield Frame(nv12=b"xy", t_ms=t_ms, camera=self.camera, width=4, height=2)


def test_the_first_frame_becomes_time_zero():
    # A live camera reports board uptime — 2,992,848 ms when measured. run_camera
    # divides t_ms by the segment length to pick a segment, so unrebased stamps
    # name segment ~49,880, which will never exist.
    frames = list(RebasedSource(FakeSource([2_992_848])).frames())
    assert frames[0].t_ms == 0


def test_spacing_between_frames_is_preserved():
    frames = list(RebasedSource(FakeSource([2_992_848, 2_992_948, 2_993_048])).frames())
    assert [f.t_ms for f in frames] == [0, 100, 200]


def test_everything_except_the_stamp_passes_through():
    frame = next(iter(RebasedSource(FakeSource([500], camera="rear")).frames()))
    assert frame.nv12 == b"xy"
    assert frame.camera == "rear"
    assert (frame.width, frame.height) == (4, 2)


def test_a_set_stop_event_ends_the_stream():
    # Without this a ride cannot end: MipiCamera.frames() runs until the camera
    # stops, so an ADAS thread would outlive the ride that started it.
    stop = threading.Event()
    stop.set()
    assert list(RebasedSource(FakeSource([1, 2, 3]), stop=stop).frames()) == []


def test_setting_stop_midway_ends_the_stream_there():
    stop = threading.Event()
    source = RebasedSource(FakeSource([0, 100, 200, 300]), stop=stop)
    seen = []
    for frame in source.frames():
        seen.append(frame.t_ms)
        if len(seen) == 2:
            stop.set()
    assert seen == [0, 100]


def test_an_empty_source_yields_nothing():
    assert list(RebasedSource(FakeSource([])).frames()) == []
