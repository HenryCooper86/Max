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

from bench_server import first_frame, listing, read_first_frame, safe_path, serve
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
    assert listing(gallery)["pairs"] == []


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


def test_read_first_frame_stops_at_the_second_marker(tmp_path):
    path = tmp_path / "seg.mjpeg"
    path.write_bytes(JPEG_A + JPEG_B)
    assert read_first_frame(path) == JPEG_A


def test_read_first_frame_of_a_single_frame_file_is_the_whole_file(tmp_path):
    path = tmp_path / "seg.mjpeg"
    path.write_bytes(JPEG_A)
    assert read_first_frame(path) == JPEG_A


def test_read_first_frame_of_something_that_is_not_jpeg_is_none(tmp_path):
    path = tmp_path / "seg.mjpeg"
    path.write_bytes(b"not a jpeg at all")
    assert read_first_frame(path) is None


def test_read_first_frame_does_not_read_a_huge_segment_whole(tmp_path):
    """A clip on the board reached 835 MB. The thumbnail must cost one frame,
    not the file — this is the difference between a thumbnail and an OOM."""
    import bench_server

    path = tmp_path / "big.mjpeg"
    # Two frames, then far more than one chunk of trailing data.
    path.write_bytes(JPEG_A + JPEG_B + b"\x00" * (4 * bench_server.SEGMENT_CHUNK))

    reads = []
    real_open = Path.open

    def counting_open(self, *args, **kwargs):
        handle = real_open(self, *args, **kwargs)
        real_read = handle.read

        def read(size=-1):
            data = real_read(size)
            reads.append(len(data))
            return data

        handle.read = read
        return handle

    Path.open = counting_open
    try:
        assert read_first_frame(path) == JPEG_A
    finally:
        Path.open = real_open
    assert sum(reads) <= bench_server.SEGMENT_CHUNK, "read past the first chunk"


def test_a_recording_downloads_as_an_attachment(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A + JPEG_B)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video")

    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg") as response:
        assert "attachment" in response.headers["Content-Disposition"]
        assert response.read() == JPEG_A + JPEG_B


def make_video(gallery, pair_id: str, data=JPEG_A + JPEG_B, recording=False):
    directory = gallery.pair_dir(pair_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(data)
    gallery.write_manifest(pair_id, "front.mjpeg", None, "video", recording=recording)


def post(port: int, path: str):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=b"", method="POST")
    return urllib.request.urlopen(request, timeout=5)


def post_status(port: int, path: str) -> int:
    try:
        with post(port, path) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_iter_frames_yields_each_frame(tmp_path):
    from bench_server import iter_frames

    path = tmp_path / "seg.mjpeg"
    path.write_bytes(JPEG_A + JPEG_B)
    assert list(iter_frames(path)) == [JPEG_A, JPEG_B]


def test_iter_frames_of_a_single_frame_file_yields_it(tmp_path):
    from bench_server import iter_frames

    path = tmp_path / "seg.mjpeg"
    path.write_bytes(JPEG_A)
    assert list(iter_frames(path)) == [JPEG_A]


def test_iter_frames_of_something_that_is_not_jpeg_yields_nothing(tmp_path):
    from bench_server import iter_frames

    path = tmp_path / "seg.mjpeg"
    path.write_bytes(b"not a jpeg at all")
    assert list(iter_frames(path)) == []


def test_play_streams_the_recording_as_multipart(gallery):
    make_video(gallery, "pair-v")
    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg/play") as response:
        assert response.headers["Content-Type"].startswith("multipart/x-mixed-replace")
        body = response.read()
    assert body.count(b"--frame") == 2
    assert JPEG_A in body
    assert JPEG_B in body


def test_play_of_a_photo_is_404(gallery):
    # A photo is already viewable inline; only a segment has frames to pace.
    make_photo(gallery, "pair-p")
    port = running(gallery)
    assert status_of(port, "/gallery/pair-p/front.jpg/play") == 404


def test_play_of_an_unknown_file_is_404(gallery):
    port = running(gallery)
    assert status_of(port, "/gallery/pair-nope/front.mjpeg/play") == 404


def test_play_refuses_an_encoded_climb(gallery):
    port = running(gallery)
    assert status_of(port, "/gallery/%2e%2e/%2e%2e/etc/shadow/play") == 404


def test_play_accepts_an_fps_within_range(gallery):
    make_video(gallery, "pair-v", data=JPEG_A)
    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg/play?fps=30") as response:
        assert response.status == 200
        response.read()


@pytest.mark.parametrize("fps", ["0", "31", "abc", "-5"])
def test_play_refuses_a_bad_fps(gallery, fps):
    make_video(gallery, "pair-v", data=JPEG_A)
    port = running(gallery)
    assert status_of(port, f"/gallery/pair-v/front.mjpeg/play?fps={fps}") == 400


def test_delete_removes_the_pair(gallery):
    make_photo(gallery, "pair-1")
    port = running(gallery)
    with post(port, "/gallery/pair-1/delete") as response:
        assert response.status == 200
        # The page reads the outcome cross-origin, so the header is part of
        # the contract, not a nicety.
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        assert json.loads(response.read()) == {"deleted": "pair-1"}
    assert not gallery.pair_dir("pair-1").exists()
    assert listing(gallery)["pairs"] == []


def test_delete_of_an_unknown_pair_is_404(gallery):
    port = running(gallery)
    assert post_status(port, "/gallery/pair-nope/delete") == 404


def test_delete_refuses_an_encoded_climb(gallery):
    port = running(gallery)
    assert post_status(port, "/gallery/%2e%2e/delete") == 404


def test_delete_of_a_live_recording_is_409(gallery):
    make_video(gallery, "pair-live", recording=True)
    port = running(gallery)
    try:
        with post(port, "/gallery/pair-live/delete") as response:
            code, headers = response.status, response.headers
    except urllib.error.HTTPError as error:
        code, headers = error.code, error.headers
    assert code == 409
    # Errors need the CORS header too, or the page cannot tell "still
    # recording" apart from the sidecar being down.
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert gallery.pair_dir("pair-live").exists()


def test_post_anywhere_else_is_404(gallery):
    port = running(gallery)
    assert post_status(port, "/gallery") == 404
    assert post_status(port, "/preview/front") == 404


def test_listing_carries_the_capture_time(gallery):
    make_photo(gallery, "pair-20260727-100000")
    entry = listing(gallery)["pairs"][0]
    assert entry["created"] == "2026-07-27T10:00:00"


def test_listing_falls_back_to_mtime_for_an_unparseable_id(gallery):
    make_photo(gallery, "pair-strange-name")
    entry = listing(gallery)["pairs"][0]
    assert entry["created"] is not None


def test_listing_passes_a_duration_through(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video", duration_s=12.3)
    assert listing(gallery)["pairs"][0]["duration_s"] == 12.3


def test_listing_reports_disk_space_against_the_floor(gallery):
    payload = listing(gallery)
    assert payload["disk"]["free_mb"] > 0
    assert payload["disk"]["min_free_mb"] == 0
