import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from gallery import MAX_RECORDING_SECONDS, Gallery


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


def test_recording_cap_matches_the_ios_rule():
    assert MAX_RECORDING_SECONDS == 600


def test_pair_id_is_sortable_and_timestamped(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    assert pair_id == "pair-20260725-142233"


def test_pair_ids_do_not_collide_within_a_second(gallery):
    now = datetime(2026, 7, 25, 14, 22, 33)
    first = gallery.new_pair_id(now)
    second = gallery.new_pair_id(now)
    assert first != second


def test_a_capture_in_a_later_second_needs_no_suffix(gallery):
    first = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    later = gallery.new_pair_id(datetime(2026, 7, 25, 14, 27, 33))
    assert first == "pair-20260725-142233"
    assert later == "pair-20260725-142733"


def test_pair_id_does_not_reuse_a_directory_left_by_an_earlier_run(tmp_path):
    # The board has no RTC, so every boot before NTP steps the clock stamps ids
    # from the same fake epoch. Two captures at the same reported second, on
    # either side of a restart, must still be two captures.
    now = datetime(2026, 7, 25, 14, 22, 33)
    before = Gallery(str(tmp_path), min_free_mb=0)
    first = before.new_pair_id(now)
    before.write_manifest(first, "front.mjpeg", None, "video")
    (before.pair_dir(first) / "front.mjpeg").write_bytes(b"\xff\xd8\xff first clip")

    after = Gallery(str(tmp_path), min_free_mb=0)
    second = after.new_pair_id(now)

    assert second != first
    assert not after.pair_dir(second).exists()


def test_a_colliding_id_cannot_append_onto_an_earlier_clip(tmp_path):
    # The damage the id guard prevents: recording opens the segment with "ab",
    # so reusing a directory fuses the new clip onto the old one and overwrites
    # the manifest describing it.
    now = datetime(2026, 7, 25, 14, 22, 33)
    before = Gallery(str(tmp_path), min_free_mb=0)
    first = before.new_pair_id(now)
    before.pair_dir(first).mkdir(parents=True, exist_ok=True)
    original = b"\xff\xd8\xff first clip"
    (before.pair_dir(first) / "front.mjpeg").write_bytes(original)

    after = Gallery(str(tmp_path), min_free_mb=0)
    second_dir = after.pair_dir(after.new_pair_id(now))
    second_dir.mkdir(parents=True, exist_ok=True)
    with (second_dir / "front.mjpeg").open("ab") as handle:
        handle.write(b"\xff\xd8\xff second clip")

    assert (before.pair_dir(first) / "front.mjpeg").read_bytes() == original


def test_has_space_refuses_when_below_the_floor(tmp_path):
    huge = Gallery(str(tmp_path), min_free_mb=10**9)
    assert huge.has_space() is False


def test_has_space_allows_when_the_floor_is_met(gallery):
    assert gallery.has_space() is True


def test_write_manifest_records_both_sides(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    path = gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    payload = json.loads(path.read_text())
    assert payload["front"] == "front.jpg"
    assert payload["rear"] == "rear.jpg"
    assert payload["kind"] == "photo"


def test_write_manifest_records_a_degraded_pair(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    path = gallery.write_manifest(pair_id, "front.jpg", None, "photo")
    payload = json.loads(path.read_text())
    assert payload["rear"] is None
    assert payload["degraded"] is True


def test_write_manifest_records_the_achieved_fps(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 8, 1, 0, 4, 44))
    path = gallery.write_manifest(pair_id, "front.mjpeg", "rear.mjpeg", "video", duration_s=498.5, fps=3.65)
    payload = json.loads(path.read_text())
    assert payload["fps"] == 3.65


def test_write_manifest_omits_fps_when_unknown(gallery):
    # Reconciled clips have no trustworthy clock; absent must not read as 0.
    pair_id = gallery.new_pair_id(datetime(2026, 8, 1, 0, 4, 44))
    path = gallery.write_manifest(pair_id, "front.mjpeg", None, "video")
    assert "fps" not in json.loads(path.read_text())


def test_manifest_write_is_atomic(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    # No temp file survives a completed write.
    assert list(gallery.pair_dir(pair_id).glob("*.tmp")) == []


def test_list_pairs_is_newest_first(gallery):
    # Ordered by capture time (the manifest's mtime), not by id — a pre-NTP
    # boot mints pair-20000101-… ids that would sort a fresh clip to the
    # bottom. With a synced clock the two agree, which is what this pins.
    for stamp in [
        datetime(2026, 7, 25, 10, 0, 0),
        datetime(2026, 7, 25, 12, 0, 0),
        datetime(2026, 7, 25, 11, 0, 0),
    ]:
        pair_id = gallery.new_pair_id(stamp)
        path = gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
        os.utime(path, (stamp.timestamp(), stamp.timestamp()))
    ids = [pair["id"] for pair in gallery.list_pairs()]
    assert ids == sorted(ids, reverse=True)


def test_list_pairs_ignores_a_directory_with_no_manifest(gallery):
    (Path(gallery.root) / "pair-garbage").mkdir(parents=True)
    assert gallery.list_pairs() == []
