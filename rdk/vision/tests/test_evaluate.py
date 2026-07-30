import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowRecord
from corpus.labels import HazardWindow
from tools.evaluate import score_ride


def record(**overrides):
    base = dict(
        threat_id="forward_collision",
        severity="critical",
        camera="front",
        t_ms=1200,
        wall_ms=1_700_000_000_000,
        ttc_s=1.4,
        ride_id="ride-001",
        segment="front_000003.h264",
        segment_offset_ms=3200,
        track_id=7,
        box_height=0.42,
        closing_rate=0.31,
        track_frames=9,
        ego_moving=True,
        latency_ms=None,
    )
    base.update(overrides)
    return ShadowRecord(**base)


def _window(threat="rear_approach", camera="rear", start=10_000, end=15_000):
    return HazardWindow(threat=threat, camera=camera, start_ms=start, end_ms=end)


def test_hit_miss_and_false_are_scored():
    windows = [_window(), _window(threat="pedestrian_ahead", camera="front", start=30_000, end=34_000)]
    records = [
        record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_012_000),
        record(threat_id="forward_collision", camera="front", severity="critical", wall_ms=1_050_000),
    ]
    score = score_ride(records, windows, ride_start_wall_ms=1_000_000, duration_h=0.5, fingerprints=["abc"])
    rear = next(t for t in score.per_threat if t.threat == "rear_approach")
    ped = next(t for t in score.per_threat if t.threat == "pedestrian_ahead")
    assert rear.hits == 1 and rear.missed == 0 and rear.false_alerts == 0
    assert ped.hits == 0 and ped.missed == 1
    assert score.false_alerts_total == 1          # the forward_collision alert
    assert score.false_criticals == 1
    assert score.false_alerts_per_hour == 2.0     # 1 false / 0.5 h
    assert not score.gate_false_rate_ok
    assert not score.gate_false_criticals_ok


def test_tolerance_bounds_are_inclusive():
    windows = [_window(start=10_000, end=15_000)]
    at_edge = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_009_000)
    score = score_ride([at_edge], windows, 1_000_000, 1.0, ["abc"], tolerance_ms=1000)
    assert score.per_threat[0].hits == 1          # 9_000 == start - tolerance
    past_edge = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_008_999)
    score = score_ride([past_edge], windows, 1_000_000, 1.0, ["abc"], tolerance_ms=1000)
    assert score.per_threat[0].false_alerts == 1


def test_camera_mismatch_is_not_a_hit():
    windows = [_window(camera="rear")]
    wrong_cam = record(threat_id="rear_approach", camera="front", severity="critical", wall_ms=1_012_000)
    score = score_ride([wrong_cam], windows, 1_000_000, 1.0, ["abc"])
    assert score.false_alerts_total == 1
    assert next(t for t in score.per_threat if t.camera == "rear").missed == 1


def test_empty_log_is_a_valid_result():
    score = score_ride([], [_window()], 1_000_000, 2.0, ["abc"])
    assert score.false_alerts_total == 0
    assert score.gate_false_rate_ok and score.gate_false_criticals_ok
    assert score.per_threat[0].missed == 1


def test_gate_passes_when_clean():
    windows = [_window()]
    hit = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_012_000)
    score = score_ride([hit], windows, 1_000_000, 2.0, ["abc"])
    assert score.gate_false_rate_ok and score.gate_false_criticals_ok
