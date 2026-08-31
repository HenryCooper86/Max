import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.labels import HazardWindow, LabelError, read_labels
from tools.label import add_window, parse_window_arg


def test_parses_the_documented_argument_form():
    window = parse_window_arg("rear_approach:rear:1000:3000")
    assert window == HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000)


def test_parses_an_optional_note():
    window = parse_window_arg("tailgating:rear:0:5000:van sat on me")
    assert window.note == "van sat on me"


def test_rejects_a_malformed_argument():
    with pytest.raises(LabelError):
        parse_window_arg("rear_approach:rear:1000")


def test_rejects_non_numeric_bounds():
    with pytest.raises(LabelError):
        parse_window_arg("rear_approach:rear:start:end")


def test_add_window_appends_and_persists(tmp_path):
    add_window(tmp_path, parse_window_arg("tailgating:rear:0:1000"))
    add_window(tmp_path, parse_window_arg("pedestrian_ahead:front:2000:3000"))
    assert len(read_labels(tmp_path)) == 2


def test_add_window_merges_an_overlapping_repeat(tmp_path):
    add_window(tmp_path, parse_window_arg("tailgating:rear:0:1000"))
    add_window(tmp_path, parse_window_arg("tailgating:rear:500:2000"))
    windows = read_labels(tmp_path)
    assert len(windows) == 1
    assert (windows[0].start_ms, windows[0].end_ms) == (0, 2000)


def test_add_window_rejects_an_invalid_threat(tmp_path):
    with pytest.raises(LabelError):
        add_window(tmp_path, HazardWindow(threat="nope", camera="front", start_ms=0, end_ms=1))
