import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera import CameraPair
from gallery import Gallery


class FakeSensor:
    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def get_img(self):
        if not self.works:
            raise RuntimeError("sensor offline")
        self.frames += 1
        return b"\xff\xd8fake-jpeg\xff\xd9"


@pytest.fixture()
def pair():
    cameras = CameraPair(front_port="0", rear_port="1")
    cameras.front = FakeSensor()
    cameras.rear = FakeSensor()
    cameras.opened = True
    return cameras


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


def test_photo_captures_both_cameras(pair, gallery):
    result = pair.capture_photo(gallery)
    assert result["status"] == "ok"
    assert pair.front.frames == 1
    assert pair.rear.frames == 1


def test_photo_is_refused_when_space_is_low(pair, tmp_path):
    full = Gallery(str(tmp_path), min_free_mb=10**9)
    result = pair.capture_photo(full)
    assert result["status"] == "failed"
    assert result["reason"] == "storage.full"


def test_photo_survives_one_dead_camera(pair, gallery):
    pair.rear = FakeSensor(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "ok"
    assert "degraded" in result["detail"]


def test_photo_fails_when_both_cameras_are_dead(pair, gallery):
    pair.front = FakeSensor(works=False)
    pair.rear = FakeSensor(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "capture.failed"


def test_double_start_is_refused(pair, gallery):
    assert pair.start_recording(gallery)["status"] == "ok"
    result = pair.start_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.recording"


def test_stop_without_start_is_refused(pair, gallery):
    result = pair.stop_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.notRecording"


def test_start_then_stop_succeeds(pair, gallery):
    pair.start_recording(gallery)
    assert pair.stop_recording(gallery)["status"] == "ok"


def test_recording_is_refused_when_space_is_low(pair, tmp_path):
    full = Gallery(str(tmp_path), min_free_mb=10**9)
    result = pair.start_recording(full)
    assert result["status"] == "failed"
    assert result["reason"] == "storage.full"


def test_recording_manifest_names_only_the_sides_that_recorded(pair, gallery):
    pair.rear = FakeSensor(works=False)
    started = pair.start_recording(gallery)
    assert started["status"] == "ok"
    stopped = pair.stop_recording(gallery)
    assert stopped["status"] == "ok"
    assert "degraded" in stopped["detail"]

    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["front"] == "front.h264"
    assert manifest["rear"] is None
    assert manifest["degraded"] is True


def test_recording_names_both_sides_when_both_cameras_work(pair, gallery):
    started = pair.start_recording(gallery)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["front"] == "front.h264"
    assert manifest["rear"] == "rear.h264"
    assert manifest["degraded"] is False


def test_recording_fails_when_both_cameras_are_dead(pair, gallery):
    pair.front = FakeSensor(works=False)
    pair.rear = FakeSensor(works=False)
    result = pair.start_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "capture.failed"
