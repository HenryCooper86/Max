import json
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
    for stamp in [
        datetime(2026, 7, 25, 10, 0, 0),
        datetime(2026, 7, 25, 12, 0, 0),
        datetime(2026, 7, 25, 11, 0, 0),
    ]:
        pair_id = gallery.new_pair_id(stamp)
        gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    ids = [pair["id"] for pair in gallery.list_pairs()]
    assert ids == sorted(ids, reverse=True)


def test_list_pairs_ignores_a_directory_with_no_manifest(gallery):
    (Path(gallery.root) / "pair-garbage").mkdir(parents=True)
    assert gallery.list_pairs() == []
