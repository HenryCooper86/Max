import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ttc import height_rate, smoothed_heights, time_to_contact
from perception.types import BoxSample, Track


def track_with(heights, t_step_ms=100, t0=0):
    samples = [
        BoxSample(t_ms=t0 + i * t_step_ms, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)
        for i, h in enumerate(heights)
    ]
    return Track(track_id=1, cls="car", samples=samples)


def test_a_growing_box_has_a_positive_rate():
    track = track_with([0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16])
    assert height_rate(track, window_ms=600) > 0


def test_a_shrinking_box_has_a_negative_rate():
    track = track_with([0.20, 0.19, 0.18, 0.17])
    assert height_rate(track, window_ms=400) < 0


def test_a_steady_box_has_a_rate_near_zero():
    track = track_with([0.2, 0.2, 0.2, 0.2])
    assert height_rate(track, window_ms=400) == pytest.approx(0.0, abs=1e-9)


def test_rate_uses_real_timestamps_not_frame_counts():
    """A dropped frame must not change the answer.

    Both tracks cover the same heights over the same elapsed time; one just has
    a gap in the middle. A counter-based derivative would report different
    rates, and on a thermally throttled board that is the difference between an
    alert and silence.
    """
    even = track_with([0.10, 0.12, 0.14, 0.16], t_step_ms=100)
    gappy = Track(
        track_id=2,
        cls="car",
        samples=[
            BoxSample(t_ms=0, x1=0.4, y1=0.45, x2=0.6, y2=0.55),    # h = 0.10
            BoxSample(t_ms=100, x1=0.4, y1=0.44, x2=0.6, y2=0.56),  # h = 0.12
            BoxSample(t_ms=300, x1=0.4, y1=0.42, x2=0.6, y2=0.58),  # h = 0.16
        ],
    )
    assert height_rate(even, window_ms=400) == pytest.approx(
        height_rate(gappy, window_ms=400), rel=0.25
    )


def test_ttc_is_height_over_rate():
    track = track_with([0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16])
    rate = height_rate(track, window_ms=600)
    height = smoothed_heights(track)[-1][1]
    assert time_to_contact(track, window_ms=600) == pytest.approx(height / rate, rel=1e-9)


def test_a_non_closing_track_has_no_ttc_at_all():
    """Absence is a category, not a big number.

    Returning a large float here is how a receding vehicle becomes a collision
    warning the moment some later comparison flips sign.
    """
    assert time_to_contact(track_with([0.20, 0.19, 0.18, 0.17]), window_ms=400) is None


def test_a_steady_track_has_no_ttc():
    assert time_to_contact(track_with([0.2, 0.2, 0.2, 0.2]), window_ms=400) is None


def test_a_single_sample_yields_nothing():
    assert height_rate(track_with([0.2]), window_ms=400) is None
    assert time_to_contact(track_with([0.2]), window_ms=400) is None


def test_smoothing_damps_a_single_jittery_frame():
    noisy = track_with([0.20, 0.20, 0.35, 0.20, 0.20])
    values = [h for _, h in smoothed_heights(noisy)]
    assert max(values) < 0.30
