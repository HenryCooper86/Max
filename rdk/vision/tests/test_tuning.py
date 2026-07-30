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


def test_tracker_and_suppressor_defaults_are_structurally_tied_to_default():
    """Bare Tracker()/Suppressor() must be governed by DEFAULT, not a copied
    literal -- otherwise a retune here silently stops matching what replay.py
    and run_camera's uninjected callers actually run. This is the test a
    future retune cannot pass without touching, which is the point."""
    from perception.tracker import Tracker

    from adas.suppress import Suppressor

    tracker = Tracker()
    assert tracker.iou_threshold == DEFAULT.iou_threshold
    assert tracker.max_misses == DEFAULT.max_misses
    assert tracker.max_gap_ms == DEFAULT.max_gap_ms
    assert tracker.window_ms == DEFAULT.track_window_ms

    suppressor = Suppressor()
    assert suppressor.min_track_frames == DEFAULT.min_track_frames
    assert suppressor.min_ttc_frames == DEFAULT.min_ttc_frames
    assert suppressor.threat_cooldown_s == DEFAULT.threat_cooldown_s
    assert suppressor.global_gap_s == DEFAULT.global_gap_s


def test_new_fields_freeze_their_defaults():
    # min_flow_px_per_s: 6.0 px/s == the old 0.6 px/frame at the nominal
    # 10 fps — same gate at nominal rate, now time-based.
    assert DEFAULT.min_flow_px_per_s == 6.0
    # One flicker frame of grace; 0 restores the old consecutive-only rule.
    assert DEFAULT.run_grace_frames == 1


def test_fingerprint_changed_from_the_evidence_track():
    """The two new fields deliberately change pipeline semantics, and the
    fingerprint exists to disclose exactly that. 9b33ddc9a92d is the
    evidence-track fingerprint captured in the 2026-07-30 bench ride's shadow
    header. If this ever fails because they match again, the disclosure
    mechanism itself is broken."""
    assert fingerprint() != "9b33ddc9a92d"
