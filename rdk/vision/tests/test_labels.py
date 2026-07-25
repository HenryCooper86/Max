import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.labels import (
    V1_THREATS,
    HazardWindow,
    LabelError,
    merge_windows,
    read_labels,
    validate_window,
    write_labels,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_threat_ids_match_the_typescript_catalog():
    # Anti-drift: shared/adas.ts is the single source of truth for threat ids.
    # If someone renames one there, this fails instead of silently producing a
    # corpus M1 cannot interpret.
    source = (REPO_ROOT / "shared" / "adas.ts").read_text(encoding="utf-8")
    block = re.search(r"export const ADAS_THREATS[^=]*=\s*\[(.*?)\]", source, re.S)
    assert block, "could not find ADAS_THREATS in shared/adas.ts"
    catalog = set(re.findall(r'"([a-z_]+)"', block.group(1)))
    assert set(V1_THREATS) <= catalog


def test_v1_covers_exactly_the_four_spec_threats():
    assert set(V1_THREATS) == {"forward_collision", "pedestrian_ahead", "rear_approach", "tailgating"}


def test_validate_accepts_a_well_formed_window():
    validate_window(HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000))


def test_validate_rejects_an_unknown_threat():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="teleporting_cow", camera="front", start_ms=0, end_ms=10))


def test_validate_rejects_a_non_positive_duration():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="rear", start_ms=500, end_ms=500))
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="rear", start_ms=900, end_ms=100))


def test_validate_rejects_an_unknown_camera():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="left", start_ms=0, end_ms=10))


def test_merge_combines_overlapping_windows_of_the_same_threat():
    merged = merge_windows(
        [
            HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000),
            HazardWindow(threat="rear_approach", camera="rear", start_ms=2500, end_ms=4000),
        ]
    )
    assert len(merged) == 1
    assert (merged[0].start_ms, merged[0].end_ms) == (1000, 4000)


def test_merge_keeps_different_threats_apart():
    merged = merge_windows(
        [
            HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000),
            HazardWindow(threat="tailgating", camera="rear", start_ms=1500, end_ms=2000),
        ]
    )
    assert len(merged) == 2


def test_merge_keeps_the_same_threat_on_different_cameras_apart():
    merged = merge_windows(
        [
            HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=0, end_ms=100),
            HazardWindow(threat="pedestrian_ahead", camera="rear", start_ms=50, end_ms=150),
        ]
    )
    assert len(merged) == 2


def test_merge_leaves_a_gap_alone():
    merged = merge_windows(
        [
            HazardWindow(threat="tailgating", camera="rear", start_ms=0, end_ms=1000),
            HazardWindow(threat="tailgating", camera="rear", start_ms=2000, end_ms=3000),
        ]
    )
    assert len(merged) == 2


def test_labels_round_trip(tmp_path):
    windows = [
        HazardWindow(threat="forward_collision", camera="front", start_ms=10, end_ms=20, note="braking van"),
    ]
    write_labels(tmp_path, windows)
    assert read_labels(tmp_path) == windows


def test_read_labels_on_unlabelled_ride_is_empty(tmp_path):
    assert read_labels(tmp_path) == []


def test_write_labels_rejects_an_invalid_window_before_writing(tmp_path):
    with pytest.raises(LabelError):
        write_labels(tmp_path, [HazardWindow(threat="nope", camera="front", start_ms=0, end_ms=1)])
    assert not (tmp_path / "labels.json").exists()
