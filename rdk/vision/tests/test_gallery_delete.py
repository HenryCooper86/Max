import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from gallery import Gallery

PHOTO = b"\xff\xd8\xff photo \xff\xd9"


@pytest.fixture()
def gallery(tmp_path):
    root = tmp_path / "gallery"
    return Gallery(str(root), min_free_mb=0)


def make_photo(gallery, pair_id: str):
    directory = gallery.pair_dir(pair_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.jpg").write_bytes(PHOTO)
    gallery.write_manifest(pair_id, "front.jpg", None, "photo")


def test_delete_removes_the_pair_directory(gallery):
    make_photo(gallery, "pair-20260730-100000")
    assert gallery.delete_pair("pair-20260730-100000") == "deleted"
    assert not gallery.pair_dir("pair-20260730-100000").exists()


def test_delete_of_an_unknown_pair_is_unknown(gallery):
    assert gallery.delete_pair("pair-nope") == "unknown"


def test_delete_refuses_to_climb_out(gallery, tmp_path):
    # The route hands this whatever the URL said. A pair id that resolves
    # outside the root must delete nothing, wherever it points.
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "manifest.json").write_text("{}")
    assert gallery.delete_pair("../outside") == "unknown"
    assert outside.exists()


def test_delete_refuses_a_nested_path(gallery):
    # The unit of deletion is the pair. A path naming one file inside it would
    # leave a manifest claiming media that is gone — the broken-tile state
    # reconcile() exists to repair.
    make_photo(gallery, "pair-1")
    assert gallery.delete_pair("pair-1/front.jpg") == "unknown"
    assert (gallery.pair_dir("pair-1") / "front.jpg").exists()


def test_delete_refuses_a_live_recording(gallery):
    directory = gallery.pair_dir("pair-live")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(PHOTO)
    gallery.write_manifest("pair-live", "front.mjpeg", None, "video", recording=True)
    assert gallery.delete_pair("pair-live") == "recording"
    assert directory.exists()


def test_delete_refuses_a_stray_file_under_the_root(gallery):
    stray = Path(gallery.root) / "notes.txt"
    stray.write_text("not a capture")
    assert gallery.delete_pair("notes.txt") == "unknown"
    assert stray.exists()


def test_delete_refuses_a_directory_without_a_manifest(gallery):
    # Nothing without a manifest is listed, so nothing without a manifest can
    # be asked for by the page; a bare directory here is not a capture.
    bare = Path(gallery.root) / "pair-bare"
    bare.mkdir()
    assert gallery.delete_pair("pair-bare") == "unknown"
    assert bare.exists()


def test_delete_still_works_when_the_manifest_is_unreadable(gallery):
    # A crash-damaged capture must still be removable — the rider's way out of
    # a broken tile cannot be SSH.
    directory = gallery.pair_dir("pair-broken")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.jpg").write_bytes(PHOTO)
    (directory / "manifest.json").write_text("{ not json")
    assert gallery.delete_pair("pair-broken") == "deleted"
    assert not directory.exists()


def test_a_video_manifest_can_carry_a_duration(gallery):
    gallery.pair_dir("pair-v").mkdir(parents=True, exist_ok=True)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video", duration_s=12.3)
    manifest = json.loads((gallery.pair_dir("pair-v") / "manifest.json").read_text())
    assert manifest["duration_s"] == 12.3


def test_a_manifest_without_a_duration_omits_the_key(gallery):
    # Reconciled clips have no trustworthy clock; an absent key says "unknown"
    # where a 0 would say "instant".
    gallery.pair_dir("pair-p").mkdir(parents=True, exist_ok=True)
    gallery.write_manifest("pair-p", "front.jpg", None, "photo")
    manifest = json.loads((gallery.pair_dir("pair-p") / "manifest.json").read_text())
    assert "duration_s" not in manifest
