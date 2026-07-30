import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.catalog import CATALOG
from adas.runtime import RecordingRequired, RuntimeConfig, run_camera
from adas.shadow import ShadowLog, read_shadow
from adas.tuning import DEFAULT
from perception.frame_source import Frame
from perception.types import Detection
from recorder.segmenter import SegmentClock


class FakeSource:
    def __init__(self, count, camera="front", width=64, height=64, fps=10.0):
        self.count, self.camera = count, camera
        self.width, self.height, self.fps = width, height, fps

    def frames(self):
        for i in range(self.count):
            yield Frame(
                nv12=bytes(self.width * self.height * 3 // 2),
                t_ms=round(i * 1000 / self.fps),
                camera=self.camera,
                width=self.width,
                height=self.height,
            )


def approaching(frame, i):
    h = 0.10 + 0.03 * i
    return [Detection(cls="car", score=0.9, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)]


def nothing(frame, i):
    return []


def test_a_closing_car_writes_a_shadow_record(tmp_path):
    path = tmp_path / "shadow.jsonl"
    emitted = []
    with ShadowLog(path) as log:
        fired = run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
            log,
            emitted.append,
        )
    assert fired == 1
    records = read_shadow(path)
    assert records[0].threat_id == "forward_collision"
    assert records[0].ride_id == "r1"
    assert records[0].track_id > 0


def test_the_record_carries_the_pipeline_view(tmp_path):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
            log,
            lambda _: None,
        )
    r = read_shadow(path)[0]
    assert r.box_height > 0
    assert r.closing_rate is not None and r.closing_rate > 0
    assert r.track_frames >= 3
    assert r.ego_moving is True


def test_an_empty_road_writes_nothing(tmp_path):
    path = tmp_path / "shadow.jsonl"
    emitted = []
    with ShadowLog(path) as log:
        fired = run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=nothing),
            log,
            emitted.append,
        )
    assert fired == 0
    assert emitted == []


def test_every_alert_is_emitted_as_well_as_logged(tmp_path):
    # Shadow does not mean "do not tell the agent" — it means the agent makes no
    # sound. Emitting always keeps the armed path from being one nobody has run.
    path = tmp_path / "shadow.jsonl"
    emitted = []
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
            log,
            emitted.append,
        )
    assert len(emitted) == 1
    assert emitted[0]["event"] == "hazard"
    assert emitted[0]["threat"] == "forward_collision"
    assert emitted[0]["message"] == CATALOG["forward_collision"]["message"]
    assert emitted[0]["direction"] == "front"


def test_it_refuses_to_run_without_recording(tmp_path):
    # A false-alarm rate whose evidence was never written is the number that
    # misleads. Fail loudly rather than degrade to alerts nobody can review.
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        with pytest.raises(RecordingRequired):
            run_camera(
                FakeSource(4),
                RuntimeConfig(ride_id="r1", camera="front", recording=False, detect=approaching),
                log,
                lambda _: None,
            )


def test_the_rear_camera_produces_rear_threats(tmp_path):
    path = tmp_path / "shadow.jsonl"
    emitted = []
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12, camera="rear"),
            RuntimeConfig(ride_id="r1", camera="rear", detect=approaching),
            log,
            emitted.append,
        )
    assert emitted and emitted[0]["threat"] == "rear_approach"
    assert emitted[0]["direction"] == "rear"


def test_provenance_points_at_a_segment_that_could_be_clipped(tmp_path):
    # Task 6: the runtime no longer builds this path itself — it cites
    # whatever the recorder's clock says is live, so the fixture publishes it.
    path = tmp_path / "shadow.jsonl"
    clock = SegmentClock()
    clock.update("front/seg-000000.mjpeg", int(time.time() * 1000))
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching, segment_clock=clock),
            log,
            lambda _: None,
        )
    r = read_shadow(path)[0]
    assert r.segment == "front/seg-000000.mjpeg"
    assert 0 <= r.segment_offset_ms < 60_000


def test_alert_cites_the_recorders_segment_not_arithmetic(tmp_path):
    clock = SegmentClock()
    # Simulate a LATE second roll: ideal boundary at 60s, real roll at 61.5s.
    # An alert at wall-time "62s" must land in segment 1 at ~500ms offset —
    # the old frame-time arithmetic would have said offset 2000ms. The runtime
    # stamps real wall time, so the fixture updates the clock relative to now
    # rather than the literal 61_500 the scenario describes.
    clock.update("front/seg-000001.mjpeg", int(time.time() * 1000) - 500)
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching, segment_clock=clock),
            log,
            lambda _: None,
        )
    record = read_shadow(path)[0]
    assert record.segment == "front/seg-000001.mjpeg"
    assert 0 <= record.segment_offset_ms < 5_000


def test_alert_before_first_roll_still_logs(tmp_path, capsys):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(
                ride_id="r1", camera="front", detect=approaching, segment_clock=SegmentClock()
            ),
            log,
            lambda _: None,
        )
    record = read_shadow(path)[0]
    assert record.segment == ""
    assert record.segment_offset_ms == -1
    assert "segment unknown" in capsys.readouterr().out


def test_runtime_builds_suppressor_from_tuning(tmp_path):
    # min_ttc_frames raised to an unreachable 99: the same scene that fires
    # an alert under DEFAULT must fire none.
    strict = replace(DEFAULT, min_ttc_frames=99)
    path = tmp_path / "shadow.jsonl"
    emitted = []
    with ShadowLog(path) as log:
        fired = run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching, tuning=strict),
            log,
            emitted.append,
        )
    assert fired == 0

    path_default = tmp_path / "shadow_default.jsonl"
    emitted_default = []
    with ShadowLog(path_default) as log:
        fired_default = run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
            log,
            emitted_default.append,
        )
    assert fired_default == 1
