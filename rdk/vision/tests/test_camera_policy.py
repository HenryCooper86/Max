import json
import sys
import threading
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

    def jpeg(self, max_age_ms=None):
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


def test_a_disk_error_stops_the_recording_with_a_finished_manifest(pair, gallery):
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "ok"
    pair_id = pair.recording_id

    pair.write_recording_frame()  # one healthy write first

    def refuse(path, data):
        raise OSError(28, "No space left on device")

    pair._append_frame = refuse
    pair.write_recording_frame()

    # The writer stopped itself cleanly: no recording in flight, and the
    # manifest describes a finished clip rather than staying "recording": true
    # until the next restart's reconcile.
    assert pair.recording_id is None
    manifest = json.loads((gallery.pair_dir(pair_id) / "manifest.json").read_text())
    assert manifest["recording"] is False


def test_stop_stamps_a_wall_clock_duration(pair, gallery):
    # Wall clock, not frames ÷ fps: the writer measurably falls behind nominal
    # fps, and the truth about a clip is how long the rider recorded.
    started = pair.start_recording(gallery, drive=False)
    time.sleep(0.05)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["duration_s"] >= 0.0


def test_recording_encodes_both_sides_concurrently(pair, gallery):
    # Sequential encodes are why dual recording measured 4-7 fps against a
    # front-only 9.98: two ~60-100 ms 1080p encodes per 100 ms tick. cv2
    # releases the GIL, so running the sides in parallel costs max() rather
    # than sum(). The barrier proves it: both sides must be inside jpeg() at
    # the same moment, or it times out and neither frame is written.
    barrier = threading.Barrier(2, timeout=2.0)

    class MeetingCamera:
        def jpeg(self, max_age_ms=None):
            if max_age_ms is None:
                # The start-recording probe grabs each side sequentially and
                # bare; only the paced write passes a staleness budget.
                return b"\xff\xd8probe\xff\xd9"
            barrier.wait()
            return b"\xff\xd8met\xff\xd9"

        def stop(self):
            pass

    pair.front = MeetingCamera()
    pair.rear = MeetingCamera()
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "ok"
    pair.write_recording_frame()
    pair.stop_recording(gallery)
    directory = gallery.pair_dir(result["detail"])
    assert (directory / "front.mjpeg").read_bytes() == b"\xff\xd8met\xff\xd9"
    assert (directory / "rear.mjpeg").read_bytes() == b"\xff\xd8met\xff\xd9"


def test_stop_stamps_the_achieved_fps(pair, gallery):
    # The measured 2026-08-01 clip: 1820 frames over 498.5 s — 3.65 fps
    # achieved against 10 nominal — so playback at the nominal rate compressed
    # an 8.3-minute ride into a 3-minute timelapse. The manifest must carry
    # the rate the writer actually achieved, or the viewer cannot tell time.
    started = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.write_recording_frame()
    pair.write_recording_frame()
    time.sleep(0.15)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["fps"] == round(3 / manifest["duration_s"], 2)


def test_an_instant_stop_stamps_no_fps(pair, gallery):
    # A zero-length clip has no rate; a made-up one would divide by zero or
    # claim precision the clock cannot back.
    started = pair.start_recording(gallery, drive=False)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert "fps" not in manifest


def test_achieved_fps_counts_the_side_that_recorded(pair, gallery):
    # A degraded clip still has a true rate: the side that wrote.
    pair.rear = FakeCamera(works=False)
    started = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.write_recording_frame()
    time.sleep(0.15)
    pair.stop_recording(gallery)
    manifest = json.loads((gallery.pair_dir(started["detail"]) / "manifest.json").read_text())
    assert manifest["fps"] == round(2 / manifest["duration_s"], 2)


def test_a_photo_manifest_has_no_duration(pair, gallery):
    pair.capture_photo(gallery)
    directory = next(p for p in Path(gallery.root).iterdir() if p.is_dir())
    manifest = json.loads((directory / "manifest.json").read_text())
    assert "duration_s" not in manifest


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


def test_open_records_a_detected_camera_that_failed_to_start(monkeypatch):
    # The measured 2026-08-01 boot: i2c saw the OV5647, its open failed (the
    # documented ISP stall), and the sidecar ran rear-only until a human
    # restarted it. A camera the bus can see but the ISP cannot stream is a
    # boot race, and the pair must say so rather than degrade in silence.
    import mipi_camera
    import sensors

    monkeypatch.setattr(mipi_camera, "reap_orphans", lambda: None)

    class FakeMipi:
        def __init__(self, channel, sensor, camera, width, height):
            self.camera = camera

        def start(self):
            if self.camera == "front":
                raise RuntimeError("no frame on /front/image_raw within 8s")

        def stop(self):
            pass

    monkeypatch.setattr(mipi_camera, "MipiCamera", FakeMipi)
    monkeypatch.setattr(sensors, "discover", lambda: {0: "OV5647", 2: "IMX219"})

    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.open()
    assert pair.failed == ["front"]
    assert pair.front is None
    assert pair.opened is True  # the rear still serves


def test_an_absent_channel_is_not_a_failed_camera(monkeypatch):
    # Front-only is normal on this hardware: an empty connector must not put
    # the sidecar in a retry loop chasing a camera that was never attached.
    import mipi_camera
    import sensors

    monkeypatch.setattr(mipi_camera, "reap_orphans", lambda: None)

    class FakeMipi:
        def __init__(self, channel, sensor, camera, width, height):
            pass

        def start(self):
            pass

        def stop(self):
            pass

    monkeypatch.setattr(mipi_camera, "MipiCamera", FakeMipi)
    monkeypatch.setattr(sensors, "discover", lambda: {0: "OV5647"})

    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.open()
    assert pair.failed == []
    assert pair.opened is True


def test_open_reaps_exactly_once_before_the_first_camera(monkeypatch):
    import mipi_camera
    import sensors

    calls = []
    monkeypatch.setattr(mipi_camera, "reap_orphans", lambda: calls.append("reap"))

    class FakeMipi:
        def __init__(self, channel, sensor, camera, width, height):
            self.camera = camera

        def start(self):
            calls.append(f"start-{self.camera}")

        def stop(self):
            pass

    monkeypatch.setattr(mipi_camera, "MipiCamera", FakeMipi)
    monkeypatch.setattr(sensors, "discover", lambda: {0: "IMX219", 2: "IMX219"})

    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.open()

    # One reap, before any camera starts — the per-camera reap is what made
    # the rear camera SIGKILL the front one's just-started mipi_cam.
    assert calls == ["reap", "start-front", "start-rear"]


def test_a_stop_racing_a_start_cannot_leak_a_writer_thread(pair, gallery, monkeypatch):
    """A stop landing between "recording_id is set" and "the writer's stop
    Event exists" used to set the *previous* Event, find no thread to join, and
    return — leaving start to install a fresh Event and launch a writer nothing
    would ever stop. That thread spins at 10 Hz for the life of the process,
    writing nothing, because the stop already cleared _recording_dir.
    """
    import camera as camera_module

    real_event = threading.Event
    racing = []

    def event_that_races_a_stop():
        # Fires once, on the first Event start_recording builds after releasing
        # the lock — the exact instant the window used to open. The slot is
        # claimed before constructing anything, because Thread.__init__ builds
        # an Event of its own and would otherwise re-enter this forever.
        if not racing:
            racing.append(None)
            thread = threading.Thread(target=lambda: pair.stop_recording(gallery), name="racing-stop")
            racing[0] = thread
            thread.start()
            time.sleep(0.05)  # long enough for it to reach the lock
        return real_event()

    monkeypatch.setattr(camera_module.threading, "Event", event_that_races_a_stop)
    pair.start_recording(gallery)
    monkeypatch.setattr(camera_module.threading, "Event", real_event)

    racing[0].join(timeout=5.0)
    assert not racing[0].is_alive()

    # Whoever won, nothing may be left writing. A leaked writer is named
    # record-<pair id> and is a daemon, so only this assertion catches it.
    pair.stop_recording(gallery)
    time.sleep(0.2)
    leaked = [t.name for t in threading.enumerate() if t.name.startswith("record-") and t.is_alive()]
    assert leaked == []
