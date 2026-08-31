import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.library import scan_corpus, scan_ride, write_ride_manifest
from recorder.metadata import FrameMeta, MetadataWriter


def make_segment(ride_dir: Path, camera: str, index: int, frames: int, suffix: str = ".h264") -> None:
    name = f"seg-{index:06d}"
    cam_dir = ride_dir / camera
    cam_dir.mkdir(parents=True, exist_ok=True)
    (cam_dir / f"{name}{suffix}").write_bytes(b"\x00\x00\x00\x01fake")
    with MetadataWriter(cam_dir / f"{name}.jsonl") as w:
        for i in range(frames):
            w.append(FrameMeta(frame_index=i, mono_ns=i * 100_000_000, wall_ms=1700 + i, camera=camera))


@pytest.fixture()
def ride(tmp_path):
    ride_dir = tmp_path / "ride-20260725-141900"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-141900", cameras=["front"], started_wall_ms=1700)
    make_segment(ride_dir, "front", 0, frames=10)
    make_segment(ride_dir, "front", 1, frames=7)
    return ride_dir


def test_manifest_records_the_cameras_that_actually_ran(ride):
    payload = json.loads((ride / "ride.json").read_text())
    assert payload["cameras"] == ["front"]
    assert payload["ride"] == "ride-20260725-141900"


def test_scan_finds_every_segment_in_capture_order(ride):
    info = scan_ride(ride)
    assert [s.name for s in info.segments] == ["seg-000000", "seg-000001"]


def test_scan_counts_frames_from_the_metadata_sidecar(ride):
    info = scan_ride(ride)
    assert [s.frame_count for s in info.segments] == [10, 7]


def test_scan_reports_a_front_only_ride_without_complaint(ride):
    # Rear camera is unreachable on this board; front-only must be a first-class
    # corpus entry, not an error.
    info = scan_ride(ride)
    assert info.cameras == ["front"]


def test_scan_handles_a_two_camera_ride(tmp_path):
    ride_dir = tmp_path / "ride-20260725-150000"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-150000", cameras=["front", "rear"], started_wall_ms=1)
    make_segment(ride_dir, "front", 0, frames=3)
    make_segment(ride_dir, "rear", 0, frames=3)
    info = scan_ride(ride_dir)
    assert sorted(info.cameras) == ["front", "rear"]
    assert len(info.segments) == 2


def test_segment_without_a_sidecar_reports_zero_frames(ride):
    (ride / "front" / "seg-000002.h264").write_bytes(b"\x00")
    info = scan_ride(ride)
    orphan = [s for s in info.segments if s.name == "seg-000002"][0]
    assert orphan.frame_count == 0


def test_labelled_flag_tracks_the_labels_file(ride):
    assert scan_ride(ride).labelled is False
    (ride / "labels.json").write_text("{}", encoding="utf-8")
    assert scan_ride(ride).labelled is True


def test_scan_corpus_is_newest_first(tmp_path):
    for stamp in ("ride-20260725-100000", "ride-20260725-120000", "ride-20260725-110000"):
        d = tmp_path / stamp
        d.mkdir()
        write_ride_manifest(d, ride=stamp, cameras=["front"], started_wall_ms=1)
    rides = [r.ride for r in scan_corpus(tmp_path)]
    assert rides == sorted(rides, reverse=True)


def test_scan_corpus_ignores_directories_without_a_manifest(tmp_path):
    (tmp_path / "not-a-ride").mkdir()
    assert scan_corpus(tmp_path) == []


def test_scan_finds_mjpeg_segments(tmp_path):
    # The mipi_cam source writes concatenated JPEG, not H.264, because it
    # delivers decoded frames rather than an encoded stream.
    ride_dir = tmp_path / "ride-20260725-160000"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-160000", cameras=["front"], started_wall_ms=1)
    make_segment(ride_dir, "front", 0, frames=4, suffix=".mjpeg")
    info = scan_ride(ride_dir)
    assert [s.name for s in info.segments] == ["seg-000000"]
    assert info.segments[0].frame_count == 4
    assert info.segments[0].video_path.suffix == ".mjpeg"


def test_scan_finds_both_formats_in_one_ride(tmp_path):
    ride_dir = tmp_path / "ride-20260725-170000"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-170000", cameras=["front"], started_wall_ms=1)
    make_segment(ride_dir, "front", 0, frames=2, suffix=".h264")
    make_segment(ride_dir, "front", 1, frames=3, suffix=".mjpeg")
    names = [s.name for s in scan_ride(ride_dir).segments]
    assert names == ["seg-000000", "seg-000001"]


def test_scan_ignores_a_stray_non_video_file(tmp_path):
    ride_dir = tmp_path / "ride-20260725-180000"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-180000", cameras=["front"], started_wall_ms=1)
    make_segment(ride_dir, "front", 0, frames=1)
    (ride_dir / "front" / "seg-000009.txt").write_text("notes", encoding="utf-8")
    assert [s.name for s in scan_ride(ride_dir).segments] == ["seg-000000"]
