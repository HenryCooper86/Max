"""Front and rear IMX219 cameras on the RDK X5 VIN/ISP pipeline.

Both sensors stay open for the life of the service. The relay's
DEVICE_RESULT_TIMEOUT_MS is 8 s, and cold-starting the VIN pipeline inside a
capture could exceed it — which would have Max tell the rider the capture failed
when it had not. Keeping the sensors streaming reduces a capture to a frame grab.

``libsrcampy`` is only available on the board, so it is imported lazily: the
policy tests run anywhere, and only ``open()`` needs real hardware.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

from gallery import MAX_RECORDING_SECONDS, Gallery

WIDTH = 1920
HEIGHT = 1080


class CameraPair:
    def __init__(self, front_port: str, rear_port: str) -> None:
        self.front_port = front_port
        self.rear_port = rear_port
        self.front = None
        self.rear = None
        self.opened = False
        self.recording_id: str | None = None
        self.recording_started_at: float | None = None
        self.recording_sides: dict[str, str | None] = {"front": None, "rear": None}
        self._lock = threading.Lock()
        self._stop_timer: threading.Timer | None = None

    def open(self) -> None:
        from hobot_vio import libsrcampy  # noqa: PLC0415 - board-only import

        self.front = libsrcampy.Camera()
        self.front.open_cam(int(self.front_port), -1, 30, WIDTH, HEIGHT)
        self.rear = libsrcampy.Camera()
        self.rear.open_cam(int(self.rear_port), -1, 30, WIDTH, HEIGHT)
        self.opened = True

    def _grab(self, sensor) -> bytes | None:
        try:
            return sensor.get_img()
        except Exception:  # noqa: BLE001 - one dead sensor must not fail the pair
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

    def start_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            if self.recording_id is not None:
                return {"status": "failed", "reason": "camera.recording"}
            if not gallery.has_space():
                return {"status": "failed", "reason": "storage.full"}

            # Probe each sensor now so the manifest can name only the files that
            # will actually exist. Claiming a rear clip that was never written
            # would be the same class of lie as a false success.
            sides: dict[str, str | None] = {
                "front": "front.h264" if self._grab(self.front) is not None else None,
                "rear": "rear.h264" if self._grab(self.rear) is not None else None,
            }
            if sides["front"] is None and sides["rear"] is None:
                return {"status": "failed", "reason": "capture.failed"}

            pair_id = gallery.new_pair_id(datetime.now())
            gallery.pair_dir(pair_id).mkdir(parents=True, exist_ok=True)
            self.recording_id = pair_id
            self.recording_started_at = time.monotonic()
            self.recording_sides = sides

        # Hard stop at the cap, so a forgotten recording cannot fill the disk.
        self._stop_timer = threading.Timer(MAX_RECORDING_SECONDS, lambda: self.stop_recording(gallery))
        self._stop_timer.daemon = True
        self._stop_timer.start()
        return {"status": "ok", "detail": pair_id}

    def stop_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            pair_id = self.recording_id
            if pair_id is None:
                return {"status": "failed", "reason": "camera.notRecording"}
            sides = self.recording_sides
            self.recording_id = None
            self.recording_started_at = None
            self.recording_sides = {"front": None, "rear": None}

        if self._stop_timer is not None:
            self._stop_timer.cancel()
            self._stop_timer = None

        gallery.write_manifest(pair_id, sides["front"], sides["rear"], "video")
        degraded = sides["front"] is None or sides["rear"] is None
        return {"status": "ok", "detail": f"{pair_id}{' degraded' if degraded else ''}"}

    def serve_preview(self, port: int) -> None:
        """MJPEG preview for the dev HUD. Deliberately served over HTTP rather
        than the control socket, so image bytes never pass through the agent."""
        pair = self

        class PreviewHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                sensor = pair.front if self.path.endswith("front") else pair.rear
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.end_headers()
                while True:
                    data = pair._grab(sensor)
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
