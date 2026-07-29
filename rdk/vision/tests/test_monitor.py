import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from monitor import STALE_AFTER_SECONDS, stale_cameras, start_monitor


class FakeCamera:
    def __init__(self, age):
        self._age = age

    def age_seconds(self):
        return self._age


class FakePair:
    def __init__(self, front=None, rear=None):
        self.front = front
        self.rear = rear


def test_fresh_cameras_are_not_stale():
    pair = FakePair(front=FakeCamera(0.5), rear=FakeCamera(1.0))
    assert stale_cameras(pair) == []


def test_a_frozen_camera_is_named_with_its_age():
    pair = FakePair(front=FakeCamera(9.0))
    stale = stale_cameras(pair)
    assert len(stale) == 1
    assert "front" in stale[0]
    assert "9.0" in stale[0]


def test_a_camera_that_never_framed_is_stale():
    pair = FakePair(front=FakeCamera(None))
    assert len(stale_cameras(pair)) == 1


def test_a_missing_camera_is_ignored():
    assert stale_cameras(FakePair(front=None, rear=None)) == []


def test_monitor_notifies_while_fresh_then_stops_on_stale():
    pair = FakePair(front=FakeCamera(0.5))
    notified, stale_seen = [], []
    # Three checks: fresh, fresh, then we freeze the camera.
    checks = iter([False, False, False, True])

    def wait(_interval):
        done = next(checks)
        if not done and len(notified) == 2:
            pair.front._age = STALE_AFTER_SECONDS + 1
        return done

    thread = start_monitor(
        pair,
        notify=lambda state: notified.append(state),
        on_stale=lambda stale: stale_seen.append(stale),
        wait=wait,
    )
    thread.join(timeout=2.0)
    assert not thread.is_alive()
    assert notified == ["WATCHDOG=1", "WATCHDOG=1"]
    assert len(stale_seen) == 1
