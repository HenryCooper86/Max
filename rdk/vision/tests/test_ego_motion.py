import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ego_motion import estimate

W, H = 64, 64


def textured(seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, size=(H, W), dtype=np.uint8)


def shifted(image, dx):
    return np.roll(image, dx, axis=1)


def test_identical_frames_read_as_stopped():
    frame = textured()
    state = estimate(frame.tobytes(), frame.tobytes(), W, H)
    assert state.moving is False
    assert state.speed_scale == 0.0


def test_a_shifted_frame_reads_as_moving():
    frame = textured()
    state = estimate(frame.tobytes(), shifted(frame, 6).tobytes(), W, H)
    assert state.moving is True
    assert state.speed_scale > 0


def test_a_bigger_shift_reads_as_faster():
    frame = textured()
    slow = estimate(frame.tobytes(), shifted(frame, 2).tobytes(), W, H)
    fast = estimate(frame.tobytes(), shifted(frame, 10).tobytes(), W, H)
    assert fast.speed_scale > slow.speed_scale


def test_sensor_noise_alone_does_not_read_as_moving():
    """A parked bike at a light must stay 'stopped'.

    This is the gate that kills the most common false alarm there is, so it has
    to survive the mild frame-to-frame noise every sensor produces.
    """
    frame = textured().astype(np.int16)
    rng = np.random.default_rng(7)
    noisy = np.clip(frame + rng.integers(-3, 4, size=frame.shape), 0, 255).astype(np.uint8)
    state = estimate(frame.astype(np.uint8).tobytes(), noisy.tobytes(), W, H)
    assert state.moving is False


def test_the_same_motion_reads_the_same_at_two_resolutions():
    """The moving/stopped verdict must not depend on camera resolution.

    Displacement was measured in raw pixels, so the identical physical motion
    read 2.4x larger at 1920 wide than at 810 — meaning the gate that
    suppresses the most common false alarm would quietly change behaviour when
    a camera was swapped. Block matching now runs at a fixed working width.
    """
    rng = np.random.default_rng(3)
    small_w, small_h = 320, 240
    base = rng.integers(0, 255, size=(small_h, small_w), dtype=np.uint8)
    moved = np.roll(base, 8, axis=1)  # 2.5% of the width

    big = np.repeat(np.repeat(base, 3, axis=0), 3, axis=1)
    big_moved = np.repeat(np.repeat(moved, 3, axis=0), 3, axis=1)

    small = estimate(base.tobytes(), moved.tobytes(), small_w, small_h)
    large = estimate(big.tobytes(), big_moved.tobytes(), small_w * 3, small_h * 3)

    assert small.moving == large.moving is True
    assert large.speed_scale == pytest.approx(small.speed_scale, rel=0.5)
