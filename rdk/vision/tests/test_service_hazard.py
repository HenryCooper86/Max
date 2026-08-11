import subprocess
import sys
from pathlib import Path

VISION_DIR = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, VISION_DIR)

import pytest

from adas.launcher import start_adas
from adas.runtime import RuntimeConfig
from adas.shadow import read_shadow
from camera import CameraPair
from perception.frame_source import Frame
from perception.types import Detection
from service import require_cameras


def test_reaching_the_adas_launcher_does_not_load_a_second_service_module():
    """max-vision starts the sidecar as ``python3 service.py``, so that file is
    ``__main__``. Any downstream ``from service import ...`` then loads a
    second, independent copy of it — two VisionConfig classes, two of
    everything, and any module-level state silently split in half. The launcher
    lives outside that file so nothing on the ride path has to reach back into
    the module being run.
    """
    probe = (
        f"import sys; sys.path.insert(0, {VISION_DIR!r}); "
        "from adas.launcher import start_adas; "
        "print('service' in sys.modules)"
    )
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"


class FakeSource:
    def __init__(self, count=12, camera="front"):
        self.count, self.camera = count, camera
        self.width = self.height = 64
        self.fps = 10.0

    def frames(self):
        for i in range(self.count):
            yield Frame(
                nv12=bytes(64 * 64 * 3 // 2),
                t_ms=i * 100,
                camera=self.camera,
                width=64,
                height=64,
            )


def approaching(frame, i):
    h = 0.10 + 0.03 * i
    return [Detection(cls="car", score=0.9, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)]


def test_the_thread_writes_the_log_and_emits(tmp_path):
    path = tmp_path / "shadow.jsonl"
    emitted = []
    thread = start_adas(
        RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
        path,
        emitted.append,
        lambda: FakeSource(),
    )
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert len(read_shadow(path)) == 1
    assert emitted[0]["event"] == "hazard"


def test_a_thread_crash_does_not_propagate(tmp_path):
    # ADAS failing must cost hazard detection and nothing else. The sidecar
    # keeps serving preview and gallery; voice is a different process entirely.
    def explode(frame, i):
        raise RuntimeError("BPU fault")

    thread = start_adas(
        RuntimeConfig(ride_id="r1", camera="front", detect=explode),
        tmp_path / "shadow.jsonl",
        lambda _: None,
        lambda: FakeSource(),
    )
    thread.join(timeout=10)
    assert not thread.is_alive()


def test_refusing_to_run_without_recording_does_not_crash_the_sidecar(tmp_path):
    # RecordingRequired is a deliberate stop, not a bug. It must be logged and
    # contained like any other ADAS failure.
    thread = start_adas(
        RuntimeConfig(ride_id="r1", camera="front", recording=False, detect=approaching),
        tmp_path / "shadow.jsonl",
        lambda _: None,
        lambda: FakeSource(),
    )
    thread.join(timeout=10)
    assert not thread.is_alive()


def test_the_thread_is_a_daemon_so_it_cannot_hold_the_sidecar_open(tmp_path):
    thread = start_adas(
        RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
        tmp_path / "shadow.jsonl",
        lambda _: None,
        lambda: FakeSource(),
    )
    assert thread.daemon
    thread.join(timeout=10)


def test_a_pair_that_opened_no_cameras_exits_for_systemd_to_retry():
    # A boot can race the camera stack: discover() sees an empty bus, the
    # sidecar runs blind, and the staleness monitor never fires because it
    # only watches cameras that opened. Exiting hands the retry to systemd,
    # which keeps trying every 2 s until the stack is ready.
    pair = CameraPair(front_channel=0, rear_channel=2)  # nothing opened
    with pytest.raises(SystemExit):
        require_cameras(pair)


def test_one_open_camera_is_enough():
    # Front-only is normal on this hardware; self-heal must not demand both.
    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.opened = True
    require_cameras(pair)


def test_a_detected_camera_that_failed_to_open_exits_for_systemd_to_retry():
    # The 2026-08-01 boot: i2c saw the front OV5647, its open failed, and the
    # sidecar served rear-only for a whole boot — no retry, no monitor line,
    # because the monitor only watches cameras that opened. A sensor the bus
    # can see is a promise; exit and let systemd retry until it streams.
    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.opened = True
    pair.failed = ["front"]
    with pytest.raises(SystemExit):
        require_cameras(pair)
