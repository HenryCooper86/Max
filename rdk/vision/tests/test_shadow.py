import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowLog, ShadowRecord, read_shadow


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


def test_appends_one_json_object_per_line(tmp_path):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        log.append(record())
        log.append(record(threat_id="tailgating", severity="caution"))
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[1])["threat_id"] == "tailgating"


def test_round_trips(tmp_path):
    path = tmp_path / "shadow.jsonl"
    original = [record(), record(threat_id="rear_approach", camera="rear")]
    with ShadowLog(path) as log:
        for item in original:
            log.append(item)
    assert read_shadow(path) == original


def test_flushes_each_record_so_a_dead_battery_keeps_what_fired(tmp_path):
    # A ride ends when the bike's power does. A buffered writer would lose the
    # tail — which is exactly the part of the ride worth reviewing.
    path = tmp_path / "shadow.jsonl"
    log = ShadowLog(path)
    log.append(record())
    assert path.read_text(encoding="utf-8").count("\n") == 1
    log.close()


def test_appends_across_reopen(tmp_path):
    # A restart mid-ride must not erase the alerts that already fired.
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        log.append(record())
    with ShadowLog(path) as log:
        log.append(record(threat_id="pedestrian_ahead"))
    assert len(read_shadow(path)) == 2


def test_reading_an_empty_log_is_not_an_error(tmp_path):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path):
        pass
    assert read_shadow(path) == []


def test_carries_the_evidence_needed_to_explain_a_false_alarm(tmp_path):
    # "Why did it fire" has to be answerable from the log alone: the ride is
    # over and the road has moved on.
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        log.append(record())
    stored = json.loads(path.read_text(encoding="utf-8").strip())
    for key in (
        "segment",
        "segment_offset_ms",
        "track_id",
        "box_height",
        "closing_rate",
        "track_frames",
        "ego_moving",
    ):
        assert key in stored


def test_keeps_chinese_labels_readable_rather_than_escaped(tmp_path):
    # These logs get read by a person deciding whether to arm the audio.
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        log.append(record(threat_id="前车急刹"))
    assert "前车急刹" in path.read_text(encoding="utf-8")
