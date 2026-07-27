import json
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from bench_server import listing, serve
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
