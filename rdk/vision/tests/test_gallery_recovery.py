"""A recording must survive the board dying mid-clip.

Measured on the board (2026-07-29): `pair-20000101-080114/front.mjpeg` was
835 MB with no `manifest.json`, because the manifest was only ever written by
`stop_recording()` and the board lost power partway through. `list_pairs()`
skips a directory with no manifest, so that clip was invisible in the gallery
forever — the rider heard "开始录像。" and then never saw the video.

These tests pin the two halves of the fix: a manifest exists from the moment
recording starts, and `reconcile()` adopts anything left behind by an older
build or a crash between the start write and the stop write.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera import CameraPair
from gallery import Gallery


class FakeCamera:
    def __init__(self, works=True):
        self.works = works

    def jpeg(self, max_age_ms=None):
        return b"\xff\xd8fake-jpeg\xff\xd9" if self.works else None

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


def manifest_of(gallery, pair_id):
    return json.loads((gallery.pair_dir(pair_id) / "manifest.json").read_text(encoding="utf-8"))


# --- a clip is listable from the first frame, not from the stop ---------------


def test_a_recording_has_a_manifest_as_soon_as_it_starts(pair, gallery):
    started = pair.start_recording(gallery, drive=False)
    assert (gallery.pair_dir(started["detail"]) / "manifest.json").exists()


def test_a_running_recording_is_listed(pair, gallery):
    started = pair.start_recording(gallery, drive=False)
    listed = gallery.list_pairs()
    assert [entry["id"] for entry in listed] == [started["detail"]]
    assert listed[0]["kind"] == "video"
    assert listed[0]["recording"] is True


def test_stopping_clears_the_in_progress_flag(pair, gallery):
    started = pair.start_recording(gallery, drive=False)
    pair.stop_recording(gallery)
    assert manifest_of(gallery, started["detail"])["recording"] is False


def test_a_photo_is_never_marked_as_recording(pair, gallery):
    result = pair.capture_photo(gallery)
    pair_id = result["detail"].split()[0]
    assert manifest_of(gallery, pair_id)["recording"] is False


# --- recovery of what earlier crashes left behind ----------------------------


def test_reconcile_finishes_a_recording_that_was_interrupted(pair, gallery):
    """The board dies mid-clip: the manifest still says `recording`. Nothing is
    writing to it after a restart, so it must be presented as a finished clip."""
    started = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    # No stop_recording() — this is the crash.

    assert gallery.reconcile() == [started["detail"]]
    manifest = manifest_of(gallery, started["detail"])
    assert manifest["recording"] is False
    assert manifest["kind"] == "video"
    assert manifest["front"] == "front.mjpeg"


def test_reconcile_adopts_a_clip_written_before_this_fix(gallery):
    """The 835 MB orphan measured on the board: media on disk, no manifest at
    all, because the old code only wrote one at stop."""
    directory = gallery.pair_dir("pair-20000101-080114")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(b"\xff\xd8\xff clip \xff\xd9")

    assert gallery.reconcile() == ["pair-20000101-080114"]
    manifest = manifest_of(gallery, "pair-20000101-080114")
    assert manifest["kind"] == "video"
    assert manifest["front"] == "front.mjpeg"
    assert manifest["rear"] is None
    assert manifest["recording"] is False
    assert [entry["id"] for entry in gallery.list_pairs()] == ["pair-20000101-080114"]


def test_reconcile_adopts_a_photo_with_no_manifest(gallery):
    directory = gallery.pair_dir("pair-20260101-101010")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.jpg").write_bytes(b"\xff\xd8\xff photo \xff\xd9")
    (directory / "rear.jpg").write_bytes(b"\xff\xd8\xff photo \xff\xd9")

    gallery.reconcile()
    manifest = manifest_of(gallery, "pair-20260101-101010")
    assert manifest["kind"] == "photo"
    assert manifest["degraded"] is False


def test_reconcile_leaves_a_finished_capture_alone(gallery):
    gallery.pair_dir("pair-1").mkdir(parents=True, exist_ok=True)
    (gallery.pair_dir("pair-1") / "front.jpg").write_bytes(b"x")
    gallery.write_manifest("pair-1", "front.jpg", None, "photo")
    before = manifest_of(gallery, "pair-1")

    assert gallery.reconcile() == []
    assert manifest_of(gallery, "pair-1") == before


def test_reconcile_drops_a_side_whose_file_never_landed(gallery):
    """A crash between the start manifest and the first frame names a file that
    does not exist. Claiming it would render a broken tile."""
    directory = gallery.pair_dir("pair-2")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(b"\xff\xd8\xff clip \xff\xd9")
    gallery.write_manifest("pair-2", "front.mjpeg", "rear.mjpeg", "video", recording=True)

    gallery.reconcile()
    manifest = manifest_of(gallery, "pair-2")
    assert manifest["front"] == "front.mjpeg"
    assert manifest["rear"] is None
    assert manifest["degraded"] is True


def test_reconcile_removes_a_capture_directory_holding_nothing(gallery):
    """An empty directory can only be debris from a start that never wrote a
    frame; there is no capture in it to lose."""
    gallery.pair_dir("pair-20260727-114223").mkdir(parents=True, exist_ok=True)
    gallery.reconcile()
    assert not gallery.pair_dir("pair-20260727-114223").exists()


def test_reconcile_removes_a_directory_whose_media_never_landed(gallery):
    directory = gallery.pair_dir("pair-3")
    directory.mkdir(parents=True, exist_ok=True)
    gallery.write_manifest("pair-3", "front.mjpeg", None, "video", recording=True)
    gallery.reconcile()
    assert not directory.exists()


def test_reconcile_rebuilds_a_corrupt_manifest_from_disk(gallery):
    """A manifest half-written by a power cut is unreadable; the media beside it
    is still good."""
    directory = gallery.pair_dir("pair-4")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(b"\xff\xd8\xff clip \xff\xd9")
    (directory / "manifest.json").write_text('{"id": "pair-4", "kin', encoding="utf-8")

    assert gallery.reconcile() == ["pair-4"]
    assert manifest_of(gallery, "pair-4")["kind"] == "video"


def test_reconcile_ignores_a_stray_file_in_the_gallery_root(gallery):
    (Path(gallery.root) / "notes.txt").write_text("hello", encoding="utf-8")
    assert gallery.reconcile() == []
    assert (Path(gallery.root) / "notes.txt").exists()


# --- a recording must not run the disk to zero -------------------------------
#
# has_space() was checked only at start. Measured on the board, a clip writes
# 2.84 MB/s, so the 10-minute cap is ~1.7 GB — a recording that starts with the
# 1 GB MAX_GALLERY_MIN_FREE_MB floor just free writes straight through it.


def test_a_recording_stops_itself_when_space_runs_low(pair, gallery):
    started = pair.start_recording(gallery, drive=False)
    gallery.min_free_mb = 10**9  # the disk filled up under us
    for _ in range(Gallery.SPACE_CHECK_FRAMES + 1):
        pair.write_recording_frame()

    assert pair.recording_id is None
    manifest = manifest_of(gallery, started["detail"])
    assert manifest["recording"] is False, "a self-stopped clip must still be a finished clip"


def test_a_recording_with_room_keeps_writing(pair, gallery):
    pair.start_recording(gallery, drive=False)
    for _ in range(Gallery.SPACE_CHECK_FRAMES + 1):
        pair.write_recording_frame()
    assert pair.recording_id is not None


def test_stopping_from_the_writer_thread_does_not_join_itself(pair, gallery):
    """The low-space stop runs on the writer thread. Joining that thread from
    itself raises RuntimeError, which would leave the manifest unfinished."""
    import threading

    started = pair.start_recording(gallery, drive=False)
    pair._recording_thread = threading.current_thread()
    result = pair.stop_recording(gallery)

    assert result["status"] == "ok"
    assert manifest_of(gallery, started["detail"])["recording"] is False
