import sys
from pathlib import Path

import numpy as np

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
