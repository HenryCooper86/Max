import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.library import scan_ride
from recorder.metadata import read_metadata
from recorder.session import CameraSlot, RideRecorder


class FakeCamera:
    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def read(self):
        if not self.works:
            raise RuntimeError("sensor gone")
        self.frames += 1
        return b"\x00\x00\x00\x01frame"


def make_recorder(tmp_path, front_ok=True, rear_ok=True):
    cams = {"front": FakeCamera(front_ok), "rear": FakeCamera(rear_ok)}

    def open_fn(slot: CameraSlot):
        cam = cams[slot.name]
        if not cam.works:
            raise RuntimeError(f"{slot.name} failed to open")
        return cam

    def encode_fn(cam, out_path: Path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("ab") as fh:
            fh.write(cam.read())

    return RideRecorder(
        root=tmp_path,
        slots=[CameraSlot("front", 2), CameraSlot("rear", 3)],
        open_fn=open_fn,
        encode_fn=encode_fn,
    )


def test_start_records_only_the_cameras_that_opened(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    rec.start(now_wall_ms=1700)
    assert rec.active_cameras == ["front"]
    rec.stop()


def test_a_dead_camera_does_not_abort_the_ride(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    assert info.cameras == ["front"]
    assert info.segments


def test_both_cameras_record_when_both_open(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.stop()
    assert sorted(scan_ride(Path(tmp_path) / ride).cameras) == ["front", "rear"]


def test_raises_when_no_camera_opens_at_all(tmp_path):
    rec = make_recorder(tmp_path, front_ok=False, rear_ok=False)
    with pytest.raises(RuntimeError):
        rec.start(now_wall_ms=1700)


def test_tick_writes_one_metadata_record_per_camera(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=0.1, now_wall_ms=1800)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    assert [s.frame_count for s in info.segments] == [2, 2]


def test_frame_index_increases_within_a_segment(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    for i in range(3):
        rec.tick(now_s=i * 0.1, now_wall_ms=1700 + i * 100)
    rec.stop()
    metas = read_metadata(Path(tmp_path) / ride / "front" / "seg-000000.jsonl")
    assert [m.frame_index for m in metas] == [0, 1, 2]


def test_rolls_to_a_new_segment_after_the_interval(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=61.0, now_wall_ms=62700)
    rec.stop()
    names = [s.name for s in scan_ride(Path(tmp_path) / ride).segments]
    assert names == ["seg-000000", "seg-000001"]


def test_frame_index_resets_each_segment(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=61.0, now_wall_ms=62700)
    rec.stop()
    metas = read_metadata(Path(tmp_path) / ride / "front" / "seg-000001.jsonl")
    assert [m.frame_index for m in metas] == [0]


def test_a_camera_failing_mid_ride_drops_only_that_camera(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec._cameras["rear"].works = False  # sensor dies mid-ride
    rec.tick(now_s=0.1, now_wall_ms=1800)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    front = [s for s in info.segments if s.camera == "front"][0]
    rear = [s for s in info.segments if s.camera == "rear"][0]
    assert front.frame_count == 2
    assert rear.frame_count == 1
