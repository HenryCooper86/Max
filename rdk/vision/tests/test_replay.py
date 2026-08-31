import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.tuning import fingerprint
from perception.frame_source import Frame
from perception.types import Detection
from tools.replay import ReplayResult, cache_key, run_clip, write_outputs


class FakeSource:
    """A scripted frame sequence, so the harness is testable with no BPU."""

    def __init__(self, count, width=64, height=64, fps=10.0, camera="front"):
        self.count = count
        self.width = width
        self.height = height
        self.fps = fps
        self.camera = camera

    def frames(self):
        for i in range(self.count):
            yield Frame(
                nv12=bytes(self.width * self.height * 3 // 2),
                t_ms=round(i * 1000 / self.fps),
                camera=self.camera,
                width=self.width,
                height=self.height,
            )


def approaching(i):
    """A car centred in the corridor, growing steadily."""
    h = 0.10 + 0.03 * i
    return [Detection(cls="car", score=0.9, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)]


class TexturedSource(FakeSource):
    """Frames whose luma actually translates, so estimate() has flow to read."""

    def __init__(self, count, dx_per_frame, **kwargs):
        super().__init__(count, **kwargs)
        self.dx = dx_per_frame

    def frames(self):
        base = np.random.default_rng(3).integers(0, 255, size=(self.height, self.width), dtype=np.uint8)
        chroma = bytes(self.width * self.height // 2)
        for i in range(self.count):
            luma = np.roll(base, self.dx * i, axis=1)
            yield Frame(
                nv12=luma.tobytes() + chroma,
                t_ms=round(i * 1000 / self.fps),
                camera=self.camera,
                width=self.width,
                height=self.height,
            )


def test_replay_estimates_ego_from_the_frames_themselves():
    # Every other test forces ego_moving, so nothing proved the replay path
    # actually wires frames into estimate() — the parked review note from the
    # algorithm-hardening merge. Moving luma must reproduce the forced
    # ego_moving=True alerts, and static luma the forced-False ones; then the
    # wiring, not just the estimator, holds the parity.
    moving = run_clip(
        TexturedSource(12, dx_per_frame=8), detect=lambda frame, i: approaching(i), camera="front"
    )
    forced = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True
    )
    assert [a.threat_id for a in moving.alerts] == [a.threat_id for a in forced.alerts]
    assert moving.alerts  # the comparison must not pass vacuously

    static = run_clip(
        TexturedSource(12, dx_per_frame=0), detect=lambda frame, i: approaching(i), camera="front"
    )
    stopped = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=False
    )
    assert [a.threat_id for a in static.alerts] == [a.threat_id for a in stopped.alerts]


def test_a_closing_car_produces_an_alert():
    result = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True
    )
    assert [a.threat_id for a in result.alerts] == ["forward_collision"]


def test_an_empty_clip_produces_no_alerts():
    result = run_clip(FakeSource(12), detect=lambda frame, i: [], camera="front", ego_moving=True)
    assert result.alerts == []
    assert result.frames == 12


def test_the_same_clip_twice_gives_the_same_alerts():
    """Determinism is the parity property M1 can actually verify.

    The camera-vs-file comparison needs hardware that does not exist yet; a
    harness that is not reproducible could not support that test anyway.
    """
    a = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True
    )
    b = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True
    )
    assert [(x.threat_id, x.t_ms, x.track_id) for x in a.alerts] == [
        (x.threat_id, x.t_ms, x.track_id) for x in b.alerts
    ]


def test_cached_detections_reproduce_the_live_run_exactly():
    live = run_clip(
        FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True
    )
    cached = run_clip(
        FakeSource(12),
        detect=lambda frame, i: live.detections[i],
        camera="front",
        ego_moving=True,
    )
    assert [a.threat_id for a in cached.alerts] == [a.threat_id for a in live.alerts]


def test_the_cache_key_changes_with_the_model_and_the_threshold():
    """A stale cache silently tuning against another model's detections is the
    exact self-deceiving measurement this milestone exists to avoid."""
    base = cache_key("clip.mp4", "abc123", 0.25)
    assert base != cache_key("clip.mp4", "def456", 0.25)
    assert base != cache_key("clip.mp4", "abc123", 0.30)
    assert base == cache_key("clip.mp4", "abc123", 0.25)


def test_outputs_are_written_where_the_summary_says(tmp_path):
    result = ReplayResult(alerts=[], frames=10, detections={}, latency_ms=[5.0, 7.0])
    write_outputs(result, tmp_path, clip="ride.mp4")
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["frames"] == 10
    assert summary["alerts"] == 0
    assert summary["latency_ms_p50"] == 6.0
    assert (tmp_path / "alerts.jsonl").exists()


def test_the_summary_states_that_the_constants_are_untuned(tmp_path):
    """A clean run must not read as a validated one.

    M1 ships the pipeline with the parent spec's conservative starting values;
    nothing here has been measured against a corpus.
    """
    write_outputs(ReplayResult(frames=1), tmp_path, clip="ride.mp4")
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert "untuned" in summary["tuning_status"]


def test_summary_carries_the_tuning_fingerprint(tmp_path):
    """The summary names the constants it ran under."""
    write_outputs(ReplayResult(frames=1), tmp_path, clip="ride.mp4")
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["tuning_fingerprint"] == fingerprint()
