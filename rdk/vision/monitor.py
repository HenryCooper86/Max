"""Frame-age monitor: heartbeat while frames flow, loud exit when they freeze.

A dead mipi_cam leaves FrameBuffer.latest() returning the last frame forever —
frozen preview, a recorder appending the same stale JPEG, ADAS blocked without
a word. This thread turns that into one journal line and a restart, and its
WATCHDOG=1 heartbeats double as the wedge detector: a process locked hard
enough to stop this thread stops heartbeating, and systemd does the rest.
"""

from __future__ import annotations

import threading

STALE_AFTER_SECONDS = 5.0
CHECK_EVERY_SECONDS = 10.0


def stale_cameras(cameras) -> list[str]:
    """Names of open cameras whose newest frame is older than the threshold."""
    stale = []
    for name in ("front", "rear"):
        camera = getattr(cameras, name)
        if camera is None:
            continue
        age = camera.age_seconds()
        if age is None:
            stale.append(f"{name} (no frame ever)")
        elif age > STALE_AFTER_SECONDS:
            stale.append(f"{name} (last frame {age:.1f}s ago)")
    return stale


class Monitor:
    """A running frame monitor, and its off switch.

    The switch is the point. Without one this loop ran until the process died,
    which is what made an ordinary `systemctl stop max-vision` exit
    `1/FAILURE`: SIGTERM unwinds into finalize(), finalize() stops the cameras,
    and this thread then woke, correctly observed that no frame had arrived
    since, and called `os._exit(1)` on a shutdown that was going perfectly
    well. A deliberate stop that reports failure is exactly the kind of
    untruthful signal the rest of this service goes out of its way to avoid.
    """

    def __init__(self, thread: threading.Thread, stop: threading.Event) -> None:
        self._thread = thread
        self._stop = stop

    def stop(self, timeout: float = 2.0) -> None:
        """Silence the monitor and wait for its thread to leave the loop."""
        self._stop.set()
        self._thread.join(timeout)

    def join(self, timeout=None) -> None:
        self._thread.join(timeout)

    def is_alive(self) -> bool:
        return self._thread.is_alive()


def start_monitor(cameras, notify, on_stale, interval=CHECK_EVERY_SECONDS, wait=None, stop=None) -> Monitor:
    """Check every `interval` seconds; heartbeat when fresh, report and end when not.

    `wait` is the test seam: it receives the interval and returns True to stop
    the loop (the default is the stop Event's wait, which fires on Monitor.stop).
    `stop` is injectable for the same reason — a test can hand in an Event that
    is already set to stand in for "teardown began".
    """
    stop = stop or threading.Event()
    waiter = wait or stop.wait

    def body() -> None:
        while not waiter(interval):
            if stop.is_set():
                return
            stale = stale_cameras(cameras)
            # Re-checked after the verdict, not just before it: the ordering in
            # finalize() closes most of the window, but a loop that woke just
            # as shutdown began would otherwise turn cameras being torn down
            # into a failed exit.
            if stale and not stop.is_set():
                on_stale(stale)
                return
            if stale:
                return
            notify("WATCHDOG=1")

    thread = threading.Thread(target=body, name="frame-monitor", daemon=True)
    thread.start()
    return Monitor(thread, stop)
