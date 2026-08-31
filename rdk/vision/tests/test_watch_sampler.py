import base64
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from watch.sampler import WatchSampler

BOUND = 2.0  # every wait in this file is bounded by this many seconds


def _encode(image) -> bytes:
    import cv2  # noqa: PLC0415 - board-only, requirements-dev supplies it off-board

    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return buf.tobytes()


def scene_jpeg(width: int = 320, height: int = 240, noise_std: float = 0.0, seed: int = 0) -> bytes:
    """A smooth synthetic "scene". See test_watch_gate.py's copy of this
    helper for why it is blurred texture rather than a literal gradient: a
    gradient's near-uniform histogram makes histogram_correlation's Pearson
    coefficient unstable under imperceptible noise."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    rng = np.random.default_rng(seed)
    base = rng.normal(128, 45, (height, width))
    base = cv2.GaussianBlur(base, (0, 0), sigmaX=20)
    if noise_std:
        base = base + rng.normal(0, noise_std, base.shape)
    base = np.clip(base, 0, 255).astype(np.uint8)
    return _encode(np.stack([base, base, base], axis=-1))


def gradient_jpeg() -> bytes:
    return scene_jpeg()


def gradient_with_noise_jpeg() -> bytes:
    return scene_jpeg(noise_std=1.0)


def checkerboard_jpeg(width: int = 320, height: int = 240, tile: int = 20) -> bytes:
    import numpy as np  # noqa: PLC0415

    xs = (np.arange(width) // tile) % 2
    ys = (np.arange(height) // tile) % 2
    plane = (np.logical_xor(ys[:, None], xs[None, :]) * 255).astype(np.uint8)
    return _encode(np.stack([plane, plane, plane], axis=-1))


class FakeGrab:
    """A grab_jpeg stand-in whose return value the test controls, and which
    signals every call so tests can wait for ticks instead of guessing at
    sleeps."""

    def __init__(self, value: bytes | None):
        self._lock = threading.Lock()
        self._value = value
        self.ticked = threading.Event()

    def set(self, value: bytes | None) -> None:
        with self._lock:
            self._value = value
        self.ticked.clear()

    def __call__(self) -> bytes | None:
        with self._lock:
            value = self._value
        self.ticked.set()
        return value

    def wait_for_tick(self) -> None:
        assert self.ticked.wait(timeout=BOUND), "sampler thread did not tick in time"
        self.ticked.clear()


class FakeBroadcast:
    def __init__(self):
        self.payloads: list[dict] = []
        self._lock = threading.Lock()
        self.event = threading.Event()

    def __call__(self, payload: dict) -> None:
        with self._lock:
            self.payloads.append(payload)
        self.event.set()

    def wait_for_broadcast(self) -> dict:
        assert self.event.wait(timeout=BOUND), "expected a broadcast that never came"
        self.event.clear()
        with self._lock:
            return self.payloads[-1]


def new_sampler(grab, broadcast, **kwargs):
    return WatchSampler(grab_jpeg=grab, broadcast=broadcast, interval_override_s=0.01, **kwargs)


def test_enabling_starts_sampling_and_ships_the_grabbed_frame():
    a = gradient_jpeg()
    grab = FakeGrab(a)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)
    try:
        sampler.set_enabled(True)
        payload = broadcast.wait_for_broadcast()
        assert payload["event"] == "watch.frame"
        assert base64.b64decode(payload["image"]) == a
    finally:
        sampler.set_enabled(False)


def test_gate_drops_do_not_update_the_shipped_reference():
    a = gradient_jpeg()
    a_noise = gradient_with_noise_jpeg()
    checker = checkerboard_jpeg()
    grab = FakeGrab(a)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)
    try:
        sampler.set_enabled(True)
        broadcast.wait_for_broadcast()  # first frame after enable always ships

        # Same scene (gradient + noise): the gate should drop it, and the
        # reference frame the gate compares against must stay `a`, not the
        # dropped noisy frame.
        grab.set(a_noise)
        for _ in range(5):
            grab.wait_for_tick()
        assert len(broadcast.payloads) == 1, "a same-scene frame must not ship"

        # A genuinely different scene should still ship, proving the gate
        # compared it against `a` (still highly correlated with a_noise had
        # the reference silently drifted) rather than against a_noise.
        grab.set(checker)
        payload = broadcast.wait_for_broadcast()
        assert base64.b64decode(payload["image"]) == checker
        assert len(broadcast.payloads) == 2
        assert [base64.b64decode(p["image"]) for p in broadcast.payloads] == [a, checker]
    finally:
        sampler.set_enabled(False)


def test_disable_stops_the_thread_and_broadcasts_stop():
    a = gradient_jpeg()
    grab = FakeGrab(a)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)
    sampler.set_enabled(True)
    broadcast.wait_for_broadcast()

    sampler.set_enabled(False)
    assert sampler.enabled is False
    assert sampler._thread is None  # joined, not daemon-and-forgotten

    broadcast.event.clear()
    seen_before = len(broadcast.payloads)
    # Bounded wait for "nothing happens": several sample intervals, well
    # under BOUND, then assert the count never moved.
    assert not broadcast.event.wait(timeout=0.2)
    assert len(broadcast.payloads) == seen_before


def test_re_enable_starts_fresh():
    a = gradient_jpeg()
    grab = FakeGrab(a)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)
    sampler.set_enabled(True)
    broadcast.wait_for_broadcast()
    sampler.set_enabled(False)

    broadcast.event.clear()
    # Same frame as last shipped before disabling; if last_shipped survived
    # the disable, the gate would drop this (correlation with itself is 1.0).
    # It must ship, because re-enabling clears the reference.
    sampler.set_enabled(True)
    try:
        payload = broadcast.wait_for_broadcast()
        assert base64.b64decode(payload["image"]) == a
        assert len(broadcast.payloads) == 2
    finally:
        sampler.set_enabled(False)


def test_a_none_grab_skips_the_tick_without_crashing():
    grab = FakeGrab(None)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)
    sampler.set_enabled(True)
    try:
        for _ in range(5):
            grab.wait_for_tick()
        assert broadcast.payloads == []
        assert sampler.enabled is True  # the thread survived the None ticks

        # Recovery: a later valid frame still ships normally.
        a = gradient_jpeg()
        grab.set(a)
        payload = broadcast.wait_for_broadcast()
        assert base64.b64decode(payload["image"]) == a
    finally:
        sampler.set_enabled(False)


def test_a_stale_epochs_tick_cannot_write_a_newer_epochs_last_shipped():
    """Regression for a race set_enabled's bounded join does not close:
    set_enabled(False)'s ``thread.join(timeout=5.0)`` is not a guarantee, and
    broadcast() can block on backpressure (see test_control_socket.py). A
    tick still mid-flight when a disable+re-enable pair completes sees
    `_enabled` flip back to True under the *new* epoch — indistinguishable
    from its own epoch by a plain boolean. It must not be able to write the
    new epoch's last_shipped anyway.

    This drives that stale tick directly with epoch 1's captured stop Event
    (what a real backgrounded tick would have closed over) rather than
    reproducing the real timing: doing that for real means a tick blocked
    past the 5 s join timeout, which is not expressible as a fast,
    deterministic test with this class's current seams.
    """
    a = gradient_jpeg()
    checker = checkerboard_jpeg()
    grab = FakeGrab(a)
    broadcast = FakeBroadcast()
    sampler = new_sampler(grab, broadcast)

    sampler.set_enabled(True)
    broadcast.wait_for_broadcast()  # epoch 1's first frame
    epoch_1 = sampler._stop
    assert epoch_1 is not None

    sampler.set_enabled(False)
    sampler.set_enabled(True)
    broadcast.wait_for_broadcast()  # epoch 2's own first-frame ship
    assert sampler._stop is not epoch_1
    epoch_2_last_shipped = sampler._last_shipped

    # A different frame than either epoch has shipped, so a wrongful write
    # would be unmistakable rather than accidentally matching by content.
    grab.set(checker)
    sampler._tick(epoch_1)  # epoch 1's stale identity, driven directly

    assert sampler._last_shipped == epoch_2_last_shipped
    sampler.set_enabled(False)
