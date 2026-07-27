"""The preview server must serve more than one client.

The HUD renders two <img> tags — front and rear — so a browser opens two
connections at once. A single-threaded HTTPServer whose handler never returns
(MJPEG streams forever) serves the first and queues the second until the listen
backlog fills. Observed on the board: `LISTEN 6 5` on port 8081, both HUD panels
blank, and every later client refused.
"""

import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera import CameraPair


class FakeCamera:
    def jpeg(self):
        return b"\xff\xd8fake-jpeg\xff\xd9"

    def stop(self):
        pass


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def serve(pair) -> int:
    port = free_port()
    threading.Thread(target=pair.serve_preview, args=(port,), daemon=True).start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return port
        except OSError:
            time.sleep(0.05)
    raise AssertionError("preview server never started listening")


def read_some(port: int, path: str, timeout: float = 4.0, hold: bool = False) -> bytes:
    """Open one streaming client and return whatever bytes arrive.

    ``hold`` keeps the connection open for the whole timeout instead of leaving
    as soon as a frame arrives — that is what a browser tab does, and it is the
    condition under which a single-threaded server starves everyone else.
    """
    connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    connection.sendall(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
    connection.settimeout(timeout)
    got = b""
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not hold and b"\xff\xd8" in got:
                break
            chunk = connection.recv(4096)
            if not chunk:
                break
            got += chunk
    except socket.timeout:
        pass
    finally:
        connection.close()
    return got


@pytest.fixture()
def pair():
    cameras = CameraPair(front_channel=0, rear_channel=2)
    cameras.front = FakeCamera()
    cameras.rear = FakeCamera()
    cameras.opened = True
    return cameras


def test_one_client_gets_frames(pair):
    port = serve(pair)
    assert b"\xff\xd8" in read_some(port, "/preview/front")


def test_a_second_client_is_served_while_the_first_still_streams(pair):
    # The HUD's two <img> tags do exactly this. Single-threaded, the second
    # connection sits in the listen backlog forever and the panel stays blank.
    port = serve(pair)

    first_got = []
    first = threading.Thread(
        target=lambda: first_got.append(read_some(port, "/preview/front", 6.0, hold=True))
    )
    first.start()
    time.sleep(0.5)

    second = read_some(port, "/preview/rear", 4.0)
    first.join(timeout=10)

    assert b"\xff\xd8" in second, "the second client was never served"
    assert first_got and b"\xff\xd8" in first_got[0]


def test_a_camera_that_is_absent_answers_instead_of_hanging(pair):
    # A missing camera used to loop sleep(0.5) forever writing nothing, so the
    # connection never produced a byte and never ended.
    pair.rear = None
    port = serve(pair)
    got = read_some(port, "/preview/rear", 4.0)
    assert got.startswith(b"HTTP/1.0 503") or got.startswith(b"HTTP/1.1 503"), got[:60]


def test_an_absent_camera_does_not_block_the_working_one(pair):
    pair.rear = None
    port = serve(pair)

    stuck = threading.Thread(target=lambda: read_some(port, "/preview/rear", 6.0, hold=True))
    stuck.start()
    time.sleep(0.5)

    assert b"\xff\xd8" in read_some(port, "/preview/front", 4.0)
    stuck.join(timeout=10)
