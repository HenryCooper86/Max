import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from adas.tuning import DEFAULT, Tuning, fingerprint


def test_defaults_freeze_todays_constants():
    """This test is the guarantee that introducing the seam changed nothing.
    Every value here is copied from the module constants this dataclass
    replaced. Changing any of them is a deliberate retune, not a refactor."""
    assert DEFAULT.ttc_forward_collision_s == 2.0
    assert DEFAULT.ttc_pedestrian_ahead_s == 2.5
    assert DEFAULT.ttc_rear_approach_s == 3.0
    assert DEFAULT.closing_rate_min == 0.08
    assert DEFAULT.tailgate_height_frac == 0.45
    assert DEFAULT.tailgate_dwell_s == 4.0
    assert DEFAULT.corridor_width_frac == 0.5
    assert DEFAULT.smoothing_tau_ms == 200.0
    assert DEFAULT.ttc_window_ms == 300
    assert DEFAULT.min_track_frames == 3
    assert DEFAULT.min_ttc_frames == 3
    assert DEFAULT.threat_cooldown_s == 8.0
    assert DEFAULT.global_gap_s == 4.0
    assert DEFAULT.iou_threshold == 0.3
    assert DEFAULT.max_misses == 3
    assert DEFAULT.max_gap_ms == 500
    assert DEFAULT.track_window_ms == 6_000


def test_fingerprint_is_stable_and_sensitive():
    assert fingerprint() == fingerprint(Tuning())
    assert len(fingerprint()) == 12
    changed = replace(DEFAULT, ttc_forward_collision_s=2.1)
    assert fingerprint(changed) != fingerprint()


def test_window_must_exceed_tailgate_dwell():
    with pytest.raises(ValueError):
        Tuning(track_window_ms=4_000)  # equal to dwell*1000 → invalid
    with pytest.raises(ValueError):
        Tuning(tailgate_dwell_s=7.0)  # dwell pushed past the default window
