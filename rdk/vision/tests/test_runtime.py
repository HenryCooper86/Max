import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.catalog import CATALOG
from adas.runtime import RecordingRequired, RuntimeConfig, run_camera
from adas.shadow import ShadowLog, read_shadow
from perception.frame_source import Frame
from perception.types import Detection


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
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path) as log:
        run_camera(
            FakeSource(12),
            RuntimeConfig(ride_id="r1", camera="front", detect=approaching),
            log,
            lambda _: None,
        )
    r = read_shadow(path)[0]
    assert r.segment.startswith("front_")
    assert 0 <= r.segment_offset_ms < 60_000
