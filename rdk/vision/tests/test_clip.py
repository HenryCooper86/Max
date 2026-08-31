import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import ShadowLog, ShadowRecord
from adas.tuning import DEFAULT
from tools.clip import clip_window, extract, main


def test_window_is_centred_on_the_alert():
    assert clip_window(20_000, before_s=5.0, after_s=3.0) == (15.0, 8.0)


def test_window_clamps_at_the_start_of_a_segment():
    # An alert 2 s into a segment cannot start 5 s earlier.
    start, duration = clip_window(2_000, before_s=5.0, after_s=3.0)
    assert start == 0.0
    assert duration == pytest.approx(5.0)


def test_an_alert_at_the_very_start_still_yields_a_clip():
    start, duration = clip_window(0, before_s=5.0, after_s=3.0)
    assert start == 0.0
    assert duration == pytest.approx(3.0)


def test_extract_writes_a_playable_clip(tmp_path):
    segment = tmp_path / "front_000000.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", "testsrc=size=320x240:rate=10:duration=20",
            "-pix_fmt", "yuv420p", str(segment),
        ],
        check=True,
    )
    out = extract(segment, offset_ms=12_000, out_path=tmp_path / "clip.mp4")
    assert out.exists() and out.stat().st_size > 0
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
        capture_output=True,
        check=True,
    )
    assert float(probe.stdout.decode().strip()) == pytest.approx(8.0, abs=1.5)


def test_a_missing_segment_raises_rather_than_writing_an_empty_clip(tmp_path):
    # A zero-byte clip would look like an alert with nothing to see, which is
    # indistinguishable from a false alarm nobody can explain.
    with pytest.raises(FileNotFoundError):
        extract(tmp_path / "nope.h264", offset_ms=1000, out_path=tmp_path / "x.mp4")


def test_a_directory_is_not_a_segment(tmp_path):
    # The segment="" sentinel joined onto the segments root IS the root — a
    # directory, which exists, so the old exists() check passed and ffmpeg
    # failed in its own words on an input that was never a video.
    with pytest.raises(FileNotFoundError):
        extract(tmp_path, offset_ms=1000, out_path=tmp_path / "x.mp4")


def test_the_no_segment_sentinel_is_refused_with_its_meaning(tmp_path):
    # SegmentClock stamps segment="" when no segment covered the alert. The
    # CLI must say that, not hand ffmpeg a directory.
    shadow = tmp_path / "shadow-front.jsonl"
    with ShadowLog(shadow, tuning=DEFAULT) as log:
        log.append(
            ShadowRecord(
                threat_id="forward_collision",
                severity="critical",
                camera="front",
                t_ms=1200,
                wall_ms=1_700_000_000_000,
                ttc_s=1.4,
                ride_id="ride-001",
                segment="",
                segment_offset_ms=0,
                track_id=7,
                box_height=0.42,
                closing_rate=0.31,
                track_frames=9,
                ego_moving=True,
                latency_ms=None,
            )
        )
    with pytest.raises(SystemExit, match="no segment"):
        main([str(shadow), "--index", "0", "--segments", str(tmp_path)])
