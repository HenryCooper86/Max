import json
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from bench_server import first_frame, listing, safe_path, serve
from camera import CameraPair
from gallery import Gallery

PHOTO = b"\xff\xd8\xff photo \xff\xd9"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


def make_photo(gallery, pair_id: str, front=PHOTO, rear=None):
    directory = gallery.pair_dir(pair_id)
    directory.mkdir(parents=True, exist_ok=True)
    if front is not None:
        (directory / "front.jpg").write_bytes(front)
    if rear is not None:
        (directory / "rear.jpg").write_bytes(rear)
    gallery.write_manifest(
        pair_id, "front.jpg" if front else None, "rear.jpg" if rear else None, "photo"
    )


def test_listing_is_empty_when_nothing_was_captured(gallery):
    assert listing(gallery) == {"pairs": []}


def test_listing_reports_a_capture_with_its_size(gallery):
    make_photo(gallery, "pair-20260727-100000")
    payload = listing(gallery)
    assert len(payload["pairs"]) == 1
    entry = payload["pairs"][0]
    assert entry["id"] == "pair-20260727-100000"
    assert entry["front"] == "front.jpg"
    assert entry["sizes"]["front"] == len(PHOTO)
    assert entry["sizes"]["rear"] is None


def test_listing_is_newest_first(gallery):
    make_photo(gallery, "pair-20260727-100000")
    make_photo(gallery, "pair-20260727-110000")
    assert [p["id"] for p in listing(gallery)["pairs"]] == [
        "pair-20260727-110000",
        "pair-20260727-100000",
    ]


def test_a_manifest_naming_a_missing_file_reports_no_size(gallery):
    # The tile must be able to say "missing" rather than show a broken image.
    directory = gallery.pair_dir("pair-20260727-120000")
    directory.mkdir(parents=True, exist_ok=True)
    gallery.write_manifest("pair-20260727-120000", "front.jpg", None, "photo")
    assert listing(gallery)["pairs"][0]["sizes"]["front"] is None


def test_the_route_serves_the_listing_as_json(gallery):
    make_photo(gallery, "pair-20260727-100000")
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    threading.Thread(target=serve, args=(pair, gallery, port), daemon=True).start()
    time.sleep(0.5)

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/gallery", timeout=5) as response:
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        payload = json.loads(response.read())
    assert payload["pairs"][0]["id"] == "pair-20260727-100000"


JPEG_A = b"\xff\xd8\xff first \xff\xd9"
JPEG_B = b"\xff\xd8\xff second \xff\xd9"


def get(port: int, path: str):
    return urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5)


def status_of(port: int, path: str) -> int:
    try:
        with get(port, path) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def running(gallery) -> int:
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    threading.Thread(target=serve, args=(pair, gallery, port), daemon=True).start()
    time.sleep(0.5)
    return port


def test_safe_path_accepts_a_file_inside_the_root(tmp_path):
    (tmp_path / "pair").mkdir()
    (tmp_path / "pair" / "front.jpg").write_bytes(b"x")
    assert safe_path(tmp_path, "pair/front.jpg") is not None


def test_safe_path_rejects_climbing_out():
    # This server binds 0.0.0.0 and the sidecar runs as root, so a path that
    # escapes the gallery reads whatever root can read.
    assert safe_path(Path("/var/lib/max/gallery"), "../../../etc/shadow") is None


def test_safe_path_rejects_an_absolute_path():
    assert safe_path(Path("/var/lib/max/gallery"), "/etc/shadow") is None


def test_safe_path_rejects_the_root_itself(tmp_path):
    assert safe_path(tmp_path, "") is None


def test_first_frame_slices_at_the_second_marker():
    assert first_frame(JPEG_A + JPEG_B) == JPEG_A


def test_first_frame_of_a_single_frame_file_is_the_whole_file():
    assert first_frame(JPEG_A) == JPEG_A


def test_first_frame_of_something_that_is_not_jpeg_is_none():
    assert first_frame(b"not a jpeg at all") is None


def test_the_route_serves_a_photo(gallery):
    make_photo(gallery, "pair-1")
    port = running(gallery)
    with get(port, "/gallery/pair-1/front.jpg") as response:
        assert response.status == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.read() == PHOTO


def test_the_route_refuses_to_climb_out(gallery):
    # Weaker than it looks: urllib may normalise "../" away before sending, in
    # which case the path never matches /gallery/ and 404s for a different
    # reason. Kept because it costs nothing; the encoded test below is the one
    # that actually reaches safe_path, and the curl check in Task 5 uses
    # --path-as-is so the server really does see the dots.
    port = running(gallery)
    assert status_of(port, "/gallery/../../../etc/shadow") == 404


def test_the_route_refuses_an_encoded_climb(gallery):
    # %2e%2e survives client-side normalisation, so this exercises the guard.
    port = running(gallery)
    assert status_of(port, "/gallery/%2e%2e/%2e%2e/etc/shadow") == 404


def test_an_unknown_pair_is_404(gallery):
    port = running(gallery)
    assert status_of(port, "/gallery/pair-nope/front.jpg") == 404


def test_thumb_returns_only_the_first_frame(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A + JPEG_B)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video")

    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg/thumb") as response:
        assert response.read() == JPEG_A
        assert response.headers["Content-Type"] == "image/jpeg"


def test_a_recording_downloads_as_an_attachment(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A + JPEG_B)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video")

    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg") as response:
        assert "attachment" in response.headers["Content-Disposition"]
        assert response.read() == JPEG_A + JPEG_B
