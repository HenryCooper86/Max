import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from watch.gate import histogram_correlation, scene_changed
from watch.tuning import DEFAULT


def _encode(image) -> bytes:
    import cv2  # noqa: PLC0415 - board-only, requirements-dev supplies it off-board

    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return buf.tobytes()


def scene_jpeg(width: int = 320, height: int = 240, noise_std: float = 0.0, seed: int = 0) -> bytes:
    """A smooth synthetic "scene": blurred random texture, with an optional
    small per-pixel noise draw layered on top to stand in for ordinary sensor
    noise between two shots of the same subject.

    Deliberately not a literal ramp: a linear gradient's histogram is close
    to uniform (every bin near the same count), and histogram_correlation's
    Pearson coefficient is numerically unstable near zero variance --
    imperceptible per-pixel noise then swings the correlation wildly even
    though nothing about the scene changed (measured: a gradient plus
    std=2 noise correlated at 0.03). A blurred-noise texture has a histogram
    with real peaks and spread, the way an actual camera frame does, so
    correlation behaves the way the gate depends on.
    """
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    rng = np.random.default_rng(seed)
    base = rng.normal(128, 45, (height, width))
    base = cv2.GaussianBlur(base, (0, 0), sigmaX=20)
    if noise_std:
        base = base + rng.normal(0, noise_std, base.shape)
    base = np.clip(base, 0, 255).astype(np.uint8)
    return _encode(np.stack([base, base, base], axis=-1))


def same_scene_jpeg() -> bytes:
    return scene_jpeg()


def same_scene_with_noise_jpeg() -> bytes:
    # std=1.0 measured >=0.978 correlation against the noiseless frame across
    # six seeds; std=2.0 already dips into the 0.85s, so this stays well
    # clear of both the >=0.95 contract and the 0.90 gate threshold.
    return scene_jpeg(noise_std=1.0)


def checkerboard_jpeg(width: int = 320, height: int = 240, tile: int = 20) -> bytes:
    """A high-contrast checkerboard -- a different scene from scene_jpeg()."""
    import numpy as np  # noqa: PLC0415

    xs = (np.arange(width) // tile) % 2
    ys = (np.arange(height) // tile) % 2
    plane = (np.logical_xor(ys[:, None], xs[None, :]) * 255).astype(np.uint8)
    return _encode(np.stack([plane, plane, plane], axis=-1))


def test_same_scene_correlates_highly():
    a = same_scene_jpeg()
    b = same_scene_with_noise_jpeg()
    assert histogram_correlation(a, b) >= 0.95


def test_same_scene_does_not_trip_the_gate():
    a = same_scene_jpeg()
    b = same_scene_with_noise_jpeg()
    assert scene_changed(a, b) is False


def test_new_scene_correlates_poorly():
    a = same_scene_jpeg()
    b = checkerboard_jpeg()
    assert histogram_correlation(a, b) < DEFAULT.change_threshold


def test_new_scene_trips_the_gate():
    a = same_scene_jpeg()
    b = checkerboard_jpeg()
    assert scene_changed(a, b) is True


def test_first_frame_after_enable_always_ships():
    # None previous -> True, regardless of the current frame's content.
    assert scene_changed(None, same_scene_jpeg()) is True


def test_garbage_current_frame_raises_in_the_correlation_helper():
    with pytest.raises(ValueError):
        histogram_correlation(same_scene_jpeg(), b"not a jpeg")


def test_garbage_current_frame_ships_through_the_gate():
    # Fail toward shipping: an undecodable frame must not silently suppress a
    # broadcast. The relay governor, not this gate, is the spend guard.
    assert scene_changed(same_scene_jpeg(), b"not a jpeg") is True
