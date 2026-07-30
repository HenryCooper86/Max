"""Front and rear cameras on the RDK X5, driven through ``mipi_cam``.

Both cameras stay open for the life of the service. The relay's
DEVICE_RESULT_TIMEOUT_MS is 8 s, and cold-starting the pipeline inside a capture
could exceed it — which would have Max tell the rider the capture failed when it
had not. Keeping the cameras streaming reduces a capture to a frame grab.

The pair owns the only camera handles in the process, because the board permits
exactly one holder of the ISP. Photo, preview, recording and ADAS all read the
frame those handles already have; none of them opens hardware.

``MipiCamera`` pulls in ROS and OpenCV, which exist only on the board, so it is
imported lazily: the policy tests run anywhere, and only ``open()`` needs real
hardware.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from pathlib import Path

from gallery import MAX_RECORDING_SECONDS, Gallery
from mipi_camera import JPEG_MAX_AGE_MS

WIDTH = 1920
HEIGHT = 1080
#: Recording sample rate. Well under the sensor's ~24 fps, because a segment is
#: concatenated JPEG and the disk, not the camera, is the limit here.
RECORDING_FPS = 10.0


class CameraPair:
    def __init__(self, front_channel: int, rear_channel: int) -> None:
        self.front_channel = front_channel
        self.rear_channel = rear_channel
        self.front = None
        self.rear = None
        self.opened = False
        self.recording_id: str | None = None
        self.recording_started_at: float | None = None
        self.recording_sides: dict[str, str | None] = {"front": None, "rear": None}
        self._recording_dir: Path | None = None
        #: Held for the life of a recording so the writer can re-check free
        #: space; the disk is the only thing that can end a clip early.
        self._recording_gallery: Gallery | None = None
        self._recording_frames = 0
        self._recording_stop = threading.Event()
        self._recording_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._stop_timer: threading.Timer | None = None

    def open(self) -> None:
        from mipi_camera import MipiCamera, reap_orphans  # noqa: PLC0415 - board-only
        from sensors import discover  # noqa: PLC0415

        # Once for the pair, before the first open — a per-camera reap would
        # SIGKILL the front camera's mipi_cam while starting the rear one.
        reap_orphans()

        # Never hardcode a sensor: an assumed IMX219 is why the OV5647 in CAM1
        # could not be opened, and the binding path cannot open either one.
        attached = discover()
        for attr, channel in (("front", self.front_channel), ("rear", self.rear_channel)):
            sensor = attached.get(channel)
            if sensor is None:
                print(f"[vision] no camera on channel {channel} ({attr})", flush=True)
                continue
            camera = MipiCamera(
                channel=channel, sensor=sensor, camera=attr, width=WIDTH, height=HEIGHT
            )
            try:
                camera.start()
                setattr(self, attr, camera)
                print(f"[vision] {attr}: {sensor} on channel {channel}", flush=True)
            except Exception as error:  # noqa: BLE001 - one camera is enough
                camera.stop()
                print(
                    f"[vision] {attr} camera unavailable on channel {channel}: {error}",
                    flush=True,
                )
        self.opened = self.front is not None or self.rear is not None

    def _grab(self, camera, max_age_ms: float | None = None) -> bytes | None:
        """Latest frame as JPEG, or None if this camera is absent or has no frame.

        ``max_age_ms`` is a pass-through to the camera's own staleness budget
        (see ``FrameBuffer.jpeg``); bare calls (photo, the recording probe)
        keep the exact-frame semantics unchanged.
        """
        if camera is None:
            return None
        try:
            return camera.jpeg(max_age_ms)
        except Exception:  # noqa: BLE001 - one dead camera must not fail the pair
            return None

    def capture_photo(self, gallery: Gallery) -> dict:
        if not gallery.has_space():
            return {"status": "failed", "reason": "storage.full"}

        pair_id = gallery.new_pair_id(datetime.now())
        directory = gallery.pair_dir(pair_id)
        directory.mkdir(parents=True, exist_ok=True)

        front_name = None
        rear_name = None
        for name, sensor in (("front.jpg", self.front), ("rear.jpg", self.rear)):
            data = self._grab(sensor)
            if data is None:
                continue
            (directory / name).write_bytes(data)
            if name.startswith("front"):
                front_name = name
            else:
                rear_name = name

        if front_name is None and rear_name is None:
            return {"status": "failed", "reason": "capture.failed"}

        gallery.write_manifest(pair_id, front_name, rear_name, "photo")
        degraded = front_name is None or rear_name is None
        return {"status": "ok", "detail": f"{pair_id}{' degraded' if degraded else ''}"}

    def start_recording(self, gallery: Gallery, drive: bool = True) -> dict:
        with self._lock:
            if self.recording_id is not None:
                return {"status": "failed", "reason": "camera.recording"}
            if not gallery.has_space():
                return {"status": "failed", "reason": "storage.full"}

            # Probe each camera now so the manifest can name only the files that
            # will actually exist. Claiming a rear clip that was never written
            # would be the same class of lie as a false success.
            sides: dict[str, str | None] = {
                "front": "front.mjpeg" if self._grab(self.front) is not None else None,
                "rear": "rear.mjpeg" if self._grab(self.rear) is not None else None,
            }
            if sides["front"] is None and sides["rear"] is None:
                return {"status": "failed", "reason": "capture.failed"}

            pair_id = gallery.new_pair_id(datetime.now())
            gallery.pair_dir(pair_id).mkdir(parents=True, exist_ok=True)
            # Describe the clip before a single frame is written, not at the
            # stop. A manifest that only appeared on a clean stop is why an
            # 835 MB clip measured on the board was invisible in the gallery:
            # the board lost power mid-ride, and list_pairs() skips a directory
            # with no manifest. Now an interrupted clip is still a clip.
            gallery.write_manifest(pair_id, sides["front"], sides["rear"], "video", recording=True)
            self.recording_id = pair_id
            self.recording_started_at = time.monotonic()
            self.recording_sides = sides
            self._recording_dir = gallery.pair_dir(pair_id)
            self._recording_gallery = gallery
            self._recording_frames = 0

        # Hard stop at the cap, so a forgotten recording cannot fill the disk.
        self._stop_timer = threading.Timer(MAX_RECORDING_SECONDS, lambda: self.stop_recording(gallery))
        self._stop_timer.daemon = True
        self._stop_timer.start()

        # drive=False lets a test own the clock and call write_recording_frame
        # itself; counting frames against a live thread would flake.
        if drive:
            self._recording_stop = threading.Event()

            def write_loop() -> None:
                # Pace on absolute deadlines. Sleeping a fixed interval *between*
                # writes adds the encode time to every period — measured at 6.2 fps
                # for a nominal 10, because a 1080p NV12->JPEG costs ~60 ms.
                interval = 1.0 / RECORDING_FPS
                next_at = time.monotonic() + interval
                while not self._recording_stop.wait(max(0.0, next_at - time.monotonic())):
                    self.write_recording_frame()
                    next_at += interval
                    now = time.monotonic()
                    if next_at < now:
                        # Encoding fell behind the target rate. Resynchronise
                        # rather than spinning to catch up on a stale frame.
                        next_at = now + interval

            self._recording_thread = threading.Thread(
                target=write_loop, name=f"record-{pair_id}", daemon=True
            )
            self._recording_thread.start()

        return {"status": "ok", "detail": pair_id}

    def write_recording_frame(self) -> None:
        """Append one JPEG per recording camera. Appending JPEGs is what makes the
        segment an .mjpeg, which corpus/library.py already reads."""
        with self._lock:
            directory = self._recording_dir
            sides = dict(self.recording_sides)
            gallery = self._recording_gallery
            frame = self._recording_frames
            self._recording_frames = frame + 1
        if directory is None:
            return

        # Free space was checked when the clip started and never again, so a
        # recording could write straight through the floor and fill the disk:
        # measured at 2.84 MB/s, the ten-minute cap is ~1.7 GB against a 1 GB
        # MAX_GALLERY_MIN_FREE_MB. Stop cleanly instead, so the clip keeps the
        # frames it did get and the manifest describes a finished video.
        if gallery is not None and frame % Gallery.SPACE_CHECK_FRAMES == 0 and not gallery.has_space():
            print("[vision] stopping the recording: free space is below the floor", flush=True)
            self.stop_recording(gallery)
            return

        for side, filename in sides.items():
            if filename is None:
                continue
            data = self._grab(
                self.front if side == "front" else self.rear, max_age_ms=JPEG_MAX_AGE_MS
            )
            if data is None:
                continue
            directory.mkdir(parents=True, exist_ok=True)
            try:
                self._append_frame(directory / filename, data)
            except OSError as error:
                # ENOSPC or a dying card. The thread dying here is what left
                # manifests stuck at "recording": true; stop cleanly instead,
                # keeping the frames already on disk. A truncated final JPEG is
                # fine — every reader scans for SOI markers.
                print(f"[vision] recording write failed ({error}); stopping with the frames on disk", flush=True)
                if gallery is not None:
                    self.stop_recording(gallery)
                return

    def _append_frame(self, path: Path, data: bytes) -> None:
        with path.open("ab") as handle:
            handle.write(data)

    def stop_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            pair_id = self.recording_id
            if pair_id is None:
                return {"status": "failed", "reason": "camera.notRecording"}
            sides = self.recording_sides
            started_at = self.recording_started_at
            self.recording_id = None
            self.recording_started_at = None
            self.recording_sides = {"front": None, "rear": None}
            self._recording_dir = None
            self._recording_gallery = None

        if self._stop_timer is not None:
            self._stop_timer.cancel()
            self._stop_timer = None

        # Stop the writer before the manifest is written, so the segment the
        # manifest describes is not still growing after the fact.
        self._recording_stop.set()
        if self._recording_thread is not None:
            # The low-space stop runs *on* the writer thread. Joining a thread
            # from itself raises, which would abandon the manifest mid-update
            # and leave the clip flagged as still recording.
            if self._recording_thread is not threading.current_thread():
                self._recording_thread.join(timeout=2.0)
            self._recording_thread = None

        # Wall clock, not frames ÷ fps: the writer measurably falls behind the
        # nominal rate, and the truth about a clip is how long it recorded.
        duration = round(time.monotonic() - started_at, 1) if started_at is not None else None
        gallery.write_manifest(
            pair_id, sides["front"], sides["rear"], "video", recording=False, duration_s=duration
        )
        degraded = sides["front"] is None or sides["rear"] is None
        return {"status": "ok", "detail": f"{pair_id}{' degraded' if degraded else ''}"}
