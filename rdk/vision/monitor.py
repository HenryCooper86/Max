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


def start_monitor(cameras, notify, on_stale, interval=CHECK_EVERY_SECONDS, wait=None) -> threading.Thread:
    """Check every `interval` seconds; heartbeat when fresh, report and end when not.

    `wait` is the test seam: it receives the interval and returns True to stop
    the loop (the default is an Event.wait that never fires).
    """
    stop = threading.Event()
    waiter = wait or stop.wait

    def body() -> None:
        while not waiter(interval):
            stale = stale_cameras(cameras)
            if stale:
                on_stale(stale)
                return
            notify("WATCHDOG=1")

    thread = threading.Thread(target=body, name="frame-monitor", daemon=True)
    thread.start()
    return thread
