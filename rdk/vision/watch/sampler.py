"""The background loop: grab, gate, maybe ship.

Follows ride.py's ``self._stop.wait(interval)`` idiom — no busy loop, no
sleep-then-check race. Toggling is the tricky part: ``set_enabled`` must be
safe against a tick that is already in flight when a disconnect flips it off,
and against a rapid disable/enable pair from two different control
connections. The stop ``Event`` a running thread waits on is captured as a
thread-local argument at start time rather than read back off ``self`` on
every loop iteration, so a later re-enable's fresh ``Event`` can never be
mistaken by an old thread for its own — which would otherwise leave that old
thread spinning forever, un-joinable, sampling alongside the new one.
"""

from __future__ import annotations

import base64
import threading
from typing import Callable

from .gate import scene_changed
from .tuning import DEFAULT, WatchTuning


class WatchSampler:
    def __init__(
        self,
        grab_jpeg: Callable[[], bytes | None],
        broadcast: Callable[[dict], None],
        tuning: WatchTuning = DEFAULT,
        interval_override_s: float | None = None,
    ) -> None:
        self._grab_jpeg = grab_jpeg
        self._broadcast = broadcast
        self._tuning = tuning
        self._interval = tuning.sample_interval_s if interval_override_s is None else interval_override_s
        self._lock = threading.Lock()
        self._enabled = False
        self._last_shipped: bytes | None = None
        self._thread: threading.Thread | None = None
        self._stop: threading.Event | None = None

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._enabled

    def set_enabled(self, on: bool) -> None:
        """Idempotent; starts or stops the sampling thread.

        Enabling always starts fresh (no reference frame carried over from a
        previous session). Disabling joins the thread before returning, so a
        caller — the control-socket disconnect path, in production — can
        trust that no broadcast follows once this call is back.
        """
        with self._lock:
            if on == self._enabled:
                return
            self._enabled = on
            self._last_shipped = None  # both directions start with no reference
            if on:
                stop_event = threading.Event()
                self._stop = stop_event
                thread = threading.Thread(
                    target=self._run, args=(stop_event,), name="vision-watch", daemon=True
                )
                self._thread = thread
                thread.start()
                return
            thread = self._thread
            stop_event = self._stop
            self._thread = None
            self._stop = None

        # Signal and join outside the lock: the thread's own tick needs the
        # lock (to check _enabled / read-write _last_shipped), so holding it
        # here would deadlock a tick that is already in flight.
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=5.0)

    def stop(self) -> None:
        """Process shutdown: same as disabling."""
        self.set_enabled(False)

    def _run(self, stop_event: threading.Event) -> None:
        while not stop_event.wait(self._interval):
            try:
                self._tick()
            except Exception as error:  # noqa: BLE001 - one bad tick must not kill the thread
                print(f"[vision.watch] tick failed: {error}", flush=True)

    def _tick(self) -> None:
        jpeg = self._grab_jpeg()
        if jpeg is None:
            return  # camera not ready this tick; try again next interval

        with self._lock:
            if not self._enabled:
                return  # disabled while this tick's grab was in flight
            last_shipped = self._last_shipped

        if not scene_changed(last_shipped, jpeg, self._tuning):
            return  # gate drop: last_shipped stays exactly what it was

        self._broadcast({"event": "watch.frame", "image": base64.b64encode(jpeg).decode("ascii")})

        with self._lock:
            # Re-check enabled: a disable that landed mid-tick must not leave
            # a reference frame behind for a re-enable to see.
            if self._enabled:
                self._last_shipped = jpeg
