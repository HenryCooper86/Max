import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowLog, ShadowRecord
from adas.tuning import DEFAULT, fingerprint
from corpus.labels import HazardWindow, write_labels
from recorder.metadata import FrameMeta, MetadataWriter
from tools.evaluate import load_ride, main, score_ride


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


def _fixture_ride(tmp_path, with_labels=True, with_sidecars=True, records=()):
    ride = tmp_path / "ride-test"
    (ride / "front").mkdir(parents=True)
    if with_sidecars:
        with MetadataWriter(ride / "front" / "seg-000000.jsonl") as w:
            w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1_000_000, camera="front"))
            w.append(FrameMeta(frame_index=1, mono_ns=10**9, wall_ms=1_360_000, camera="front"))
    with ShadowLog(ride / "shadow-front.jsonl", tuning=DEFAULT) as log:
        for rec in records:
            log.append(rec)
    if with_labels:
        write_labels(ride, [HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=10_000, end_ms=14_000)])
    return ride


def test_load_ride_derives_start_and_duration_from_sidecars(tmp_path):
    ride = _fixture_ride(tmp_path)
    records, fingerprints, start, duration_h = load_ride(ride)
    assert start == 1_000_000
    assert abs(duration_h - 0.1) < 1e-9          # 360 s
    assert fingerprints == [fingerprint(DEFAULT)]


def test_missing_labels_exits_with_instructions(tmp_path, capsys):
    ride = _fixture_ride(tmp_path, with_labels=False)
    with pytest.raises(SystemExit):
        main([str(ride)])
    assert "tools.label" in capsys.readouterr().err


def test_missing_sidecars_exit_naming_the_files(tmp_path, capsys):
    ride = _fixture_ride(tmp_path, with_sidecars=False)
    with pytest.raises(SystemExit):
        main([str(ride)])
    assert "jsonl" in capsys.readouterr().err


def test_cli_scores_and_writes_json(tmp_path, capsys):
    hit = record(threat_id="pedestrian_ahead", camera="front", severity="critical", wall_ms=1_012_000)
    ride = _fixture_ride(tmp_path, records=[hit])
    out = tmp_path / "score.json"
    main([str(ride), "--json", str(out)])
    printed = capsys.readouterr().out
    assert "false alerts/hour" in printed and "fingerprint" in printed
    payload = json.loads(out.read_text())
    assert payload["false_alerts_total"] == 0
    assert payload["gate_false_rate_ok"] is True


def test_a_mid_ride_restart_scores_each_fingerprint_separately(tmp_path, capsys):
    # Two tuning headers in one shadow log — a restart mid-ride. The spec's
    # error table calls for records grouped by the header preceding them and
    # scored per fingerprint, never blended into one misleading total.
    ride = tmp_path / "ride-restart"
    (ride / "front").mkdir(parents=True)
    with MetadataWriter(ride / "front" / "seg-000000.jsonl") as w:
        w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1_000_000, camera="front"))
        w.append(FrameMeta(frame_index=1, mono_ns=10**9, wall_ms=1_360_000, camera="front"))
    write_labels(
        ride,
        [HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=10_000, end_ms=14_000)],
    )

    alt_tuning = replace(DEFAULT, ttc_forward_collision_s=2.1)
    fp_default = fingerprint(DEFAULT)
    fp_alt = fingerprint(alt_tuning)

    shadow_path = ride / "shadow-front.jsonl"
    with ShadowLog(shadow_path, tuning=DEFAULT) as log:
        log.append(
            record(
                threat_id="pedestrian_ahead",
                camera="front",
                severity="critical",
                wall_ms=1_012_000,
                tuning=fp_default,
            )
        )
    with ShadowLog(shadow_path, tuning=alt_tuning) as log:
        log.append(
            record(
                threat_id="forward_collision",
                camera="front",
                severity="critical",
                wall_ms=1_050_000,
                tuning=fp_alt,
            )
        )

    out = tmp_path / "score.json"
    main([str(ride), "--json", str(out)])
    printed = capsys.readouterr().out
    assert "WARNING" in printed and "2 tuning fingerprints" in printed
    assert fp_default in printed
    assert fp_alt in printed

    payload = json.loads(out.read_text())
    assert set(payload.keys()) == {fp_default, fp_alt}
    # The pedestrian record falls inside its own header's labelled window.
    assert payload[fp_default]["false_alerts_total"] == 0
    # The forward_collision record under the second header matches no window.
    assert payload[fp_alt]["false_alerts_total"] == 1


def test_orphan_fingerprint_records_are_reported_not_silently_dropped(tmp_path, capsys):
    # A corrupted multi-header log can leave records whose tuning fingerprint
    # matches no surviving header. They cannot be honestly scored under any
    # group — but vanishing without a word makes the report claim coverage it
    # does not have. The tool must say what it dropped.
    ride = tmp_path / "ride-corrupt"
    (ride / "front").mkdir(parents=True)
    with MetadataWriter(ride / "front" / "seg-000000.jsonl") as w:
        w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1_000_000, camera="front"))
        w.append(FrameMeta(frame_index=1, mono_ns=10**9, wall_ms=1_360_000, camera="front"))
    write_labels(
        ride,
        [HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=10_000, end_ms=14_000)],
    )

    alt_tuning = replace(DEFAULT, ttc_forward_collision_s=2.1)
    fp_default = fingerprint(DEFAULT)
    fp_alt = fingerprint(alt_tuning)

    shadow_path = ride / "shadow-front.jsonl"
    with ShadowLog(shadow_path, tuning=DEFAULT) as log:
        log.append(
            record(
                threat_id="pedestrian_ahead",
                camera="front",
                severity="critical",
                wall_ms=1_012_000,
                tuning=fp_default,
            )
        )
    with ShadowLog(shadow_path, tuning=alt_tuning) as log:
        log.append(
            record(
                threat_id="forward_collision",
                camera="front",
                severity="critical",
                wall_ms=1_050_000,
                tuning="feedfacedead",  # its header line did not survive
            )
        )

    main([str(ride)])
    err = capsys.readouterr().err
    assert "feedfacedead" in err
    assert "unscored" in err
