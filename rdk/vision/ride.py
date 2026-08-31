"""A ride: continuous segments and the shadow runtime, started as one thing.

M2 requires shadow mode to have evidence — ``run_camera`` refuses to start
without a recorder, because an unreviewable false-alarm rate is the measurement
that misleads. The obvious way to satisfy that, running ``tools/record_ride.py``
alongside, is impossible: the board permits exactly one holder of the ISP, so a
recorder process and the sidecar cannot both have the camera.

So the sidecar records. Binding the recorder and the ADAS threads into one
object means they start together and stop together, and the requirement holds by
construction rather than by a flag someone can set wrong.

Nothing here opens a camera. It is handed the ones CameraPair already opened.
"""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from adas.launcher import start_adas
from adas.rebase import RebasedSource
from adas.runtime import RuntimeConfig
from adas.tuning import DEFAULT
from recorder.mipi_source import write_jpeg
from recorder.segmenter import SegmentClock
from recorder.session import CameraSlot, RideRecorder

#: Disk is checked every this many ticks rather than every frame — statvfs at
#: 10 Hz for the whole ride buys nothing.
DISK_CHECK_TICKS = 50


def _free_mb(path) -> float:
    return shutil.disk_usage(str(path)).free / (1024 * 1024)


class _CameraSource:
    """Binds a camera's sample rate so it satisfies the FrameSource protocol.

    ``MipiCamera.frames(fps)`` takes an argument and returns a generator, while
    everything downstream expects a zero-argument ``frames()`` on an object it
    can iterate. This is that adapter, and it keeps the source re-iterable
    rather than handing a spent generator to a second caller.
    """

    def __init__(self, camera, fps: float) -> None:
        self.camera = camera
        self.fps = fps

    def frames(self):
        return self.camera.frames(self.fps)


def _bpu_detect_factory() -> Callable:
    """A detect callable backed by the BPU. Board-only: hobot_dnn lives there."""
    import os  # noqa: PLC0415

    from perception.detector import Detector  # noqa: PLC0415

    model = os.environ.get(
        "MAX_ADAS_MODEL",
        "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin",
    )
    detector = Detector(model)

    def detect(frame, _index):
        return detector.infer(frame.nv12, frame.width, frame.height)

    return detect


class RideSession:
    def __init__(
        self,
        cameras: dict,
        corpus_dir,
        min_free_mb: int,
        broadcast: Callable[[dict], None],
        detect_factory: Callable[[], Callable] | None = None,
        fps: float = 10.0,
        free_mb: Callable[[object], float] | None = None,
    ) -> None:
        self.cameras = dict(cameras)
        self.corpus_dir = Path(corpus_dir)
        self.min_free_mb = min_free_mb
        self.broadcast = broadcast
        self.fps = fps
        self._detect_factory = detect_factory or _bpu_detect_factory
        self._free_mb = free_mb or _free_mb
        self.ride_id: str | None = None
        self.shadow_paths: dict[str, Path] = {}
        self.adas_threads: list[threading.Thread] = []
        self._recorder: RideRecorder | None = None
        #: One clock per open camera, shared with the recorder: it is the
        #: writer, the ADAS thread below is the reader at alert time.
        self._clocks: dict[str, SegmentClock] = {}
        self._stop = threading.Event()
        self._tick_thread: threading.Thread | None = None

    def start(self) -> str | None:
        """Begin a ride. Returns its id, or None if one must not start."""
        if not self.cameras:
            print("[ride] no camera open; not starting a ride", flush=True)
            return None

        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        if self._free_mb(self.corpus_dir) < self.min_free_mb:
            print(
                f"[ride] refusing to start: free space below {self.min_free_mb} MB",
                flush=True,
            )
            return None

        self._stop = threading.Event()
        self._clocks = {name: SegmentClock() for name in self.cameras}
        self._recorder = RideRecorder(
            root=self.corpus_dir,
            slots=[CameraSlot(name, camera.channel) for name, camera in self.cameras.items()],
            # The cameras are already open. Handing them back is what keeps this
            # process the only holder of the ISP.
            open_fn=lambda slot: self.cameras[slot.name],
            encode_fn=write_jpeg,
            video_suffix=".mjpeg",
            clocks=self._clocks,
        )
        self.ride_id = self._recorder.start(now_wall_ms=int(time.time() * 1000))
        print(f"[ride] {self.ride_id}: {', '.join(self.cameras)}", flush=True)

        self._tick_thread = threading.Thread(
            target=self._record_loop, name=f"record-{self.ride_id}", daemon=True
        )
        self._tick_thread.start()
        self._start_adas_threads()
        return self.ride_id

    def _start_adas_threads(self) -> None:
        assert self.ride_id is not None
        ride_dir = self.corpus_dir / self.ride_id
        for name, camera in self.cameras.items():
            # One shadow file per camera: start_adas opens its own ShadowLog, and
            # two of them appending to one file is a race nobody needs.
            shadow_path = ride_dir / f"shadow-{name}.jsonl"
            self.shadow_paths[name] = shadow_path

            config = RuntimeConfig(
                ride_id=self.ride_id,
                camera=name,
                recording=True,
                detect=self._detect_factory(),
                # The same clock RideRecorder writes through, so the shadow
                # record cites the real file instead of a name computed twice.
                segment_clock=self._clocks[name],
                tuning=DEFAULT,
            )

            def source_factory(cam=camera):
                return RebasedSource(_CameraSource(cam, self.fps), stop=self._stop)

            self.adas_threads.append(
                start_adas(config, shadow_path, self.broadcast, source_factory)
            )

    def _record_loop(self) -> None:
        interval = 1.0 / self.fps
        next_at = time.monotonic() + interval
        ticks = 0
        while not self._stop.wait(max(0.0, next_at - time.monotonic())):
            assert self._recorder is not None
            try:
                self._recorder.tick(time.monotonic(), int(time.time() * 1000))
            except Exception as error:  # noqa: BLE001 - a ride ending is not a crash
                print(f"[ride] recording stopped: {error}", flush=True)
                return

            ticks += 1
            if ticks % DISK_CHECK_TICKS == 0 and self._free_mb(self.corpus_dir) < self.min_free_mb:
                # No alerts whose evidence cannot be written. Stopping from
                # another thread so this one can exit its own join.
                print("[ride] free space exhausted; stopping the ride", flush=True)
                threading.Thread(target=self.stop, daemon=True).start()
                return

            next_at += interval
            if next_at < time.monotonic():
                next_at = time.monotonic() + interval

    def stop(self) -> None:
        self._stop.set()
        if self._tick_thread is not None:
            self._tick_thread.join(timeout=3.0)
            self._tick_thread = None
        for thread in self.adas_threads:
            thread.join(timeout=5.0)
        self.adas_threads = []
        if self._recorder is not None:
            self._recorder.stop()
            self._recorder = None
