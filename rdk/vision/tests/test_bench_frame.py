import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bench_server import downscale, serve
from camera import CameraPair
from gallery import Gallery


def jpeg_of(width: int, height: int) -> bytes:
    """A real, decodable JPEG — downscale() must not be testable with a stub."""
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, : width // 2] = (0, 0, 255)
    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return buf.tobytes()


def dims(jpeg: bytes) -> tuple[int, int]:
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    decoded = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    return decoded.shape[1], decoded.shape[0]


class FakeCamera:
    def jpeg(self, max_age_ms=None):
        return jpeg_of(1920, 1080)

    def stop(self):
        pass


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def running(share: bool, front=None) -> int:
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.front = FakeCamera() if front is None else front
    gallery = Gallery("/tmp/bench-frame-test", min_free_mb=0)
    threading.Thread(
        target=serve, args=(pair, gallery, port), kwargs={"share_frames": share}, daemon=True
    ).start()
    time.sleep(0.5)
    return port


def status_of(port: int, path: str) -> int:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_downscale_fits_the_longest_edge():
    out = downscale(jpeg_of(1920, 1080), 640)
    assert dims(out) == (640, 360)


def test_downscale_preserves_a_portrait_aspect():
    out = downscale(jpeg_of(1080, 1920), 640)
    assert dims(out) == (360, 640)


def test_downscale_does_not_upscale_a_small_frame():
    # Enlarging invents detail the sensor never captured.
    out = downscale(jpeg_of(320, 240), 640)
    assert dims(out) == (320, 240)


def test_downscale_returns_none_for_junk():
    assert downscale(b"not a jpeg", 640) is None


def test_the_route_serves_a_downscaled_frame():
    port = running(share=True)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/frame/front", timeout=5) as response:
        assert response.status == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        body = response.read()
    assert dims(body) == (640, 360)


def test_the_route_honours_an_explicit_width():
    port = running(share=True)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/frame/front?w=320", timeout=5) as response:
        assert dims(response.read()) == (320, 180)


def test_sharing_off_refuses_with_403():
    # The consent gate: no image may leave the board unless it is on.
    port = running(share=False)
    assert status_of(port, "/frame/front") == 403


def test_an_absent_camera_is_503_even_when_sharing_is_on():
    # The fixture never populates rear, so this is the absent-camera case
    # without needing a second fixture.
    port = running(share=True)
    assert status_of(port, "/frame/rear") == 503


def test_a_silly_width_is_rejected():
    port = running(share=True)
    assert status_of(port, "/frame/front?w=99999") == 400
    assert status_of(port, "/frame/front?w=abc") == 400
