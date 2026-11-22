"""On-board smoke tests. Every test here is marked ``hardware``.

Off the board they are collected and deselected by ``-m "not hardware"`` (the
CI and ``npm run test:rdk-vision`` selection). Run explicitly with
``-m hardware`` on a machine without the vendor stack and each one skips with
the name of the module that is missing, so a skip is never read as a pass.

Run on the board with the TROS environment sourced. The camera tests need the
camera free (``systemctl stop max-vision``: one process may hold a camera); the
control-socket test needs the sidecar running, so run it as a second pass
(``-k control_socket``) after ``systemctl start max-vision``:

    source /opt/tros/humble/setup.bash
    cd /opt/max && python3 -m pytest -c rdk/vision/pytest.ini -m hardware \
        --strict-markers rdk/vision/tests/test_hardware_smoke.py -v
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

pytestmark = pytest.mark.hardware

MODEL = os.environ.get(
    "MAX_VISION_MODEL",
    "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin",
)
SOCKET = os.environ.get("MAX_VISION_SOCKET", "/run/max/vision.sock")
FRAME_WIDTH, FRAME_HEIGHT = 1920, 1080


def _vision_service_active() -> bool:
    """True when systemd says max-vision is active. Unknown counts as not active
    only when systemctl itself is absent (a dev machine, where nothing is reaped)."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", "max-vision"], check=False, timeout=10
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


@pytest.fixture(scope="module")
def front_camera():
    """The first attached camera, opened the way the sidecar opens it."""
    pytest.importorskip("rclpy")
    pytest.importorskip("sensor_msgs.msg")
    pytest.importorskip("cv2")
    from mipi_camera import MipiCamera, reap_orphans
    from sensors import discover

    if _vision_service_active():
        pytest.skip(
            "max-vision is running and holds the camera; reap_orphans() would kill it. "
            "Run `systemctl stop max-vision` first, then start it again afterwards."
        )

    attached = discover()
    if not attached:
        pytest.skip("no camera module answers on i2c")
    channel, sensor = sorted(attached.items())[0]
    reap_orphans()
    camera = MipiCamera(
        channel=channel, sensor=sensor, camera="front", width=FRAME_WIDTH, height=FRAME_HEIGHT
    )
    try:
        camera.start()
        yield camera
    finally:
        camera.stop()


@pytest.fixture(scope="module")
def detector():
    pytest.importorskip("hobot_dnn")
    if not Path(MODEL).is_file():
        pytest.skip(f"model not found at {MODEL} (set MAX_VISION_MODEL)")
    from perception.detector import Detector

    return Detector(MODEL)


def test_camera_opens_and_yields_a_full_size_frame(front_camera):
    deadline = time.monotonic() + 10
    frame = None
    while frame is None and time.monotonic() < deadline:
        frame = front_camera.latest()
        time.sleep(0.1)

    assert frame is not None, "no frame within 10 s of a successful open"
    assert (frame.width, frame.height) == (FRAME_WIDTH, FRAME_HEIGHT)
    assert len(frame.nv12) == FRAME_WIDTH * FRAME_HEIGHT * 3 // 2


def test_camera_frames_keep_arriving(front_camera):
    # The service's own watchdog exits when frames stop; this is the same fact
    # asserted from outside, so a camera that delivers one frame and dies fails.
    first = front_camera.latest()
    assert first is not None
    time.sleep(2)
    later = front_camera.latest()
    assert later is not None and later.t_ms > first.t_ms
    assert front_camera.age_seconds() < 1.0


def test_the_model_loads_and_exposes_three_detection_heads(detector):
    # decode() reads the heads in stride order 8, 16, 32.
    import numpy as np
    from perception.postprocess import INPUT_SIZE

    outputs = detector._model.forward(np.zeros(INPUT_SIZE * INPUT_SIZE * 3 // 2, dtype=np.uint8))
    assert len(outputs) == 3


def test_one_inference_returns_boxes_in_unit_fractions(detector):
    from perception.types import Detection

    gray = bytes([128]) * (FRAME_WIDTH * FRAME_HEIGHT) + bytes([128]) * (FRAME_WIDTH * FRAME_HEIGHT // 2)
    detections = detector.infer(gray, FRAME_WIDTH, FRAME_HEIGHT)

    assert isinstance(detections, list)
    for detection in detections:
        assert isinstance(detection, Detection)
        assert 0.0 <= detection.x1 <= detection.x2 <= 1.0
        assert 0.0 <= detection.y1 <= detection.y2 <= 1.0
        assert 0.0 < detection.score <= 1.0


def test_the_control_socket_answers_a_request(tmp_path):
    # Needs the running sidecar. An unknown op is answered `unsupported` and has
    # no side effect, which makes it a safe liveness probe.
    if not os.path.exists(SOCKET):
        pytest.skip(f"{SOCKET} not present; start max-vision (and leave it running for this test)")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(SOCKET)
        client.sendall(b'{"id":"smoke-1","op":"smoke.unknown"}\n')
        buffer = b""
        while b"\n" not in buffer:
            chunk = client.recv(4096)
            assert chunk, "control socket closed without answering"
            buffer += chunk
    reply = json.loads(buffer.split(b"\n", 1)[0])
    assert reply["id"] == "smoke-1"
    assert reply["status"] == "unsupported"
