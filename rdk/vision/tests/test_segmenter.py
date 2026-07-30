import sys
import threading
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recorder.segmenter import SEGMENT_SECONDS, Segmenter, SegmentClock, ride_id, segment_name


def test_segment_length_bounds_power_loss_damage():
    assert SEGMENT_SECONDS == 60


def test_segment_names_sort_lexicographically():
    names = [segment_name(i) for i in (0, 1, 10, 100)]
    assert names == ["seg-000000", "seg-000001", "seg-000010", "seg-000100"]
    assert names == sorted(names)


def test_ride_id_is_sortable_and_timestamped():
    assert ride_id(datetime(2026, 7, 25, 14, 19, 0)) == "ride-20260725-141900"


def test_does_not_roll_before_the_interval_elapses():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    assert seg.should_roll(now_s=1059.9) is False


def test_rolls_once_the_interval_elapses():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    assert seg.should_roll(now_s=1060.0) is True


def test_roll_advances_the_index():
    seg = Segmenter()
    assert seg.roll(now_s=0.0) == 0
    assert seg.roll(now_s=60.0) == 1
    assert seg.index == 1


def test_roll_rebases_the_clock_so_segments_are_evenly_spaced():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    seg.roll(now_s=1065.0)  # 5 s late
    # Next roll is measured from 1065, not from 1060 — no compounding drift and
    # no immediate double-roll.
    assert seg.should_roll(now_s=1120.0) is False
    assert seg.should_roll(now_s=1125.0) is True


def test_should_roll_is_false_before_the_first_roll():
    assert Segmenter().should_roll(now_s=99999.0) is False


def test_clock_is_none_before_any_roll():
    assert SegmentClock().current() is None


def test_clock_returns_the_latest_update():
    clock = SegmentClock()
    clock.update("front/seg-000000.mjpeg", 1_000)
    clock.update("front/seg-000001.mjpeg", 61_500)
    assert clock.current() == ("front/seg-000001.mjpeg", 61_500)


def test_clock_survives_concurrent_readers():
    clock = SegmentClock()
    stop = threading.Event()

    def hammer():
        i = 0
        while not stop.is_set():
            clock.update(f"front/seg-{i:06d}.mjpeg", i)
            i += 1

    writer = threading.Thread(target=hammer, daemon=True)
    writer.start()
    for _ in range(10_000):
        current = clock.current()
        assert current is None or current[0].endswith(".mjpeg")
    stop.set()
    writer.join(timeout=2.0)
