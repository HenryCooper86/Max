import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera import CameraPair
from gallery import Gallery


class FakeCamera:
    """Stands in for MipiCamera: the pair only ever asks it for a JPEG."""

    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def jpeg(self):
        if not self.works:
            return None
        self.frames += 1
        return b"\xff\xd8fake-jpeg\xff\xd9"

    def stop(self):
        pass


@pytest.fixture()
def pair():
    cameras = CameraPair(front_channel=0, rear_channel=2)
    cameras.front = FakeCamera()
    cameras.rear = FakeCamera()
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
    pair.rear = FakeCamera(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "ok"
    assert "degraded" in result["detail"]


def test_photo_fails_when_both_cameras_are_dead(pair, gallery):
    pair.front = FakeCamera(works=False)
    pair.rear = FakeCamera(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "capture.failed"


def test_double_start_is_refused(pair, gallery):
    assert pair.start_recording(gallery, drive=False)["status"] == "ok"
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.recording"


def test_stop_without_start_is_refused(pair, gallery):
    result = pair.stop_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.notRecording"


def test_start_then_stop_succeeds(pair, gallery):
    pair.start_recording(gallery, drive=False)
    assert pair.stop_recording(gallery)["status"] == "ok"


def test_recording_is_refused_when_space_is_low(pair, tmp_path):
    full = Gallery(str(tmp_path), min_free_mb=10**9)
    result = pair.start_recording(full, drive=False)
    assert result["status"] == "failed"
    assert result["reason"] == "storage.full"


def test_recording_manifest_names_only_the_sides_that_recorded(pair, gallery):
    pair.rear = FakeCamera(works=False)
    started = pair.start_recording(gallery, drive=False)
    assert started["status"] == "ok"
    stopped = pair.stop_recording(gallery)
    assert stopped["status"] == "ok"
    assert "degraded" in stopped["detail"]

    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["front"] == "front.mjpeg"
    assert manifest["rear"] is None
    assert manifest["degraded"] is True


def test_recording_names_both_sides_when_both_cameras_work(pair, gallery):
    started = pair.start_recording(gallery, drive=False)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["front"] == "front.mjpeg"
    assert manifest["rear"] == "rear.mjpeg"
    assert manifest["degraded"] is False


def test_recording_fails_when_both_cameras_are_dead(pair, gallery):
    pair.front = FakeCamera(works=False)
    pair.rear = FakeCamera(works=False)
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "failed"
    assert result["reason"] == "capture.failed"


def test_recording_writes_frames_to_the_segment(pair, gallery):
    # drive=False so the test owns the clock. With the writer thread running,
    # counting frames would race it and flake.
    result = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.write_recording_frame()
    pair.stop_recording(gallery)
    written = (gallery.pair_dir(result["detail"]) / "front.mjpeg").read_bytes()
    assert written.count(b"\xff\xd8") == 2


def test_recording_only_writes_cameras_the_manifest_claims(pair, gallery):
    pair.rear = FakeCamera(works=False)
    result = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.stop_recording(gallery)
    directory = gallery.pair_dir(result["detail"])
    assert (directory / "front.mjpeg").exists()
    assert not (directory / "rear.mjpeg").exists()


def test_writing_a_frame_outside_a_recording_does_nothing(pair, gallery):
    pair.write_recording_frame()
    assert list(Path(gallery.root).iterdir()) == []


def test_the_driven_recording_writes_without_being_asked(pair, gallery):
    # The one place the writer thread itself is exercised: everything else
    # drives write_recording_frame directly to stay deterministic.
    result = pair.start_recording(gallery)
    time.sleep(0.35)
    pair.stop_recording(gallery)
    written = (gallery.pair_dir(result["detail"]) / "front.mjpeg").read_bytes()
    assert written.count(b"\xff\xd8") >= 1


def test_stopping_a_recording_stops_the_writer_thread(pair, gallery):
    result = pair.start_recording(gallery)
    time.sleep(0.25)
    pair.stop_recording(gallery)
    settled = (gallery.pair_dir(result["detail"]) / "front.mjpeg").read_bytes()
    time.sleep(0.35)
    # A writer that outlives its recording would append to a finished segment,
    # and the manifest would describe a file that kept changing after the fact.
    assert (gallery.pair_dir(result["detail"]) / "front.mjpeg").read_bytes() == settled
