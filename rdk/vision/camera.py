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
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from gallery import MAX_RECORDING_SECONDS, Gallery

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
        self._recording_stop = threading.Event()
        self._recording_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._stop_timer: threading.Timer | None = None

    def open(self) -> None:
        from mipi_camera import MipiCamera  # noqa: PLC0415 - board-only
        from sensors import discover  # noqa: PLC0415

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

    def _grab(self, camera) -> bytes | None:
        """Latest frame as JPEG, or None if this camera is absent or has no frame."""
        if camera is None:
            return None
        try:
            return camera.jpeg()
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
            self.recording_id = pair_id
            self.recording_started_at = time.monotonic()
            self.recording_sides = sides
            self._recording_dir = gallery.pair_dir(pair_id)

        # Hard stop at the cap, so a forgotten recording cannot fill the disk.
        self._stop_timer = threading.Timer(MAX_RECORDING_SECONDS, lambda: self.stop_recording(gallery))
        self._stop_timer.daemon = True
        self._stop_timer.start()

        # drive=False lets a test own the clock and call write_recording_frame
        # itself; counting frames against a live thread would flake.
        if drive:
            self._recording_stop = threading.Event()

            def write_loop() -> None:
                while not self._recording_stop.wait(1.0 / RECORDING_FPS):
                    self.write_recording_frame()

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
        if directory is None:
            return

        for side, filename in sides.items():
            if filename is None:
                continue
            data = self._grab(self.front if side == "front" else self.rear)
            if data is None:
                continue
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / filename).open("ab") as handle:
                handle.write(data)

    def stop_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            pair_id = self.recording_id
            if pair_id is None:
                return {"status": "failed", "reason": "camera.notRecording"}
            sides = self.recording_sides
            self.recording_id = None
            self.recording_started_at = None
            self.recording_sides = {"front": None, "rear": None}
            self._recording_dir = None

        if self._stop_timer is not None:
            self._stop_timer.cancel()
            self._stop_timer = None

        # Stop the writer before the manifest is written, so the segment the
        # manifest describes is not still growing after the fact.
        self._recording_stop.set()
        if self._recording_thread is not None:
            self._recording_thread.join(timeout=2.0)
            self._recording_thread = None

        gallery.write_manifest(pair_id, sides["front"], sides["rear"], "video")
        degraded = sides["front"] is None or sides["rear"] is None
        return {"status": "ok", "detail": f"{pair_id}{' degraded' if degraded else ''}"}

    def serve_preview(self, port: int) -> None:
        """MJPEG preview for the dev HUD. Deliberately served over HTTP rather
        than the control socket, so image bytes never pass through the agent."""
        pair = self

        class PreviewHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                camera = pair.front if self.path.endswith("front") else pair.rear
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.end_headers()
                while True:
                    data = pair._grab(camera)
                    if data is None:
                        time.sleep(0.5)
                        continue
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    time.sleep(1 / 10)

            def log_message(self, *args) -> None:
                return

        HTTPServer(("0.0.0.0", port), PreviewHandler).serve_forever()
