import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.frame_source import FileSource, Frame, probe_dims


@pytest.fixture
def clip(tmp_path):
    """Two seconds of synthetic video, the shape ffmpeg gives us from a ride."""
    path = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", "testsrc=size=640x360:rate=10:duration=2",
            "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )
    return path


def test_probe_reports_the_real_dimensions(clip):
    assert probe_dims(str(clip)) == (640, 360)


def test_yields_nv12_frames_of_the_right_size(clip):
    frames = list(FileSource(str(clip), camera="front", fps=10.0).frames())
    assert len(frames) > 0
    f = frames[0]
    assert isinstance(f, Frame)
    assert f.camera == "front"
    # NV12 is 1.5 bytes per pixel.
    assert len(f.nv12) == int(640 * 360 * 1.5)


def test_timestamps_advance_at_the_requested_rate(clip):
    frames = list(FileSource(str(clip), camera="front", fps=10.0).frames())
    assert frames[0].t_ms == 0
    assert frames[1].t_ms == 100
    assert frames[5].t_ms == 500


def test_start_offset_lets_a_clip_sit_on_a_ride_timeline(clip):
    frames = list(FileSource(str(clip), camera="rear", fps=10.0, start_t_ms=60_000).frames())
    assert frames[0].t_ms == 60_000
    assert frames[1].t_ms == 60_100


def test_a_missing_file_raises_rather_than_yielding_nothing(tmp_path):
    # Silently yielding zero frames would look like a clip with no hazards,
    # which is the most dangerous possible failure for a measurement harness.
    with pytest.raises(FileNotFoundError):
        list(FileSource(str(tmp_path / "nope.mp4"), camera="front").frames())
