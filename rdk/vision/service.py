"""Max vision sidecar: owns the cameras, captures, gallery, and MJPEG preview."""

from __future__ import annotations

import os
import socketserver
import threading
from pathlib import Path

from camera import CameraPair
from gallery import Gallery
from rpc import decode_lines, dispatch

SOCKET_PATH = os.environ.get("MAX_VISION_SOCKET", "/run/max/vision.sock")
GALLERY_DIR = os.environ.get("MAX_GALLERY_DIR", "/var/lib/max/gallery")
MIN_FREE_MB = int(os.environ.get("MAX_GALLERY_MIN_FREE_MB", "1024"))
PREVIEW_PORT = int(os.environ.get("MAX_VISION_PREVIEW_PORT", "8081"))

gallery = Gallery(GALLERY_DIR, MIN_FREE_MB)
cameras = CameraPair(
    front_port=os.environ.get("RDK_CAMERA_FRONT", "0"),
    rear_port=os.environ.get("RDK_CAMERA_REAR", "1"),
)

HANDLERS = {
    "camera.photo": lambda args: cameras.capture_photo(gallery),
    "camera.record": lambda args: (
        cameras.start_recording(gallery) if args.get("start") else cameras.stop_recording(gallery)
    ),
}


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        buffer = ""
        while True:
            chunk = self.rfile.readline()
            if not chunk:
                return
            buffer += chunk.decode("utf-8", errors="replace")
            messages, buffer = decode_lines(buffer)
            for message in messages:
                line = dispatch(message, HANDLERS)
                if line:
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True


def main() -> None:
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

    cameras.open()
    threading.Thread(target=cameras.serve_preview, args=(PREVIEW_PORT,), daemon=True).start()

    with ControlServer(SOCKET_PATH, ControlHandler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    main()


def start_adas(config: "RuntimeConfig", shadow_path, emit, source_factory) -> threading.Thread:
    """Run one camera's ADAS loop on a daemon thread.

    Exceptions are caught and logged rather than raised. ADAS failing must cost
    hazard detection and nothing else: the sidecar keeps serving preview and
    gallery, and voice is a different process that this cannot reach.

    RecordingRequired arrives here too. It is a deliberate stop rather than a
    bug — shadow mode without a recorder produces a false-alarm rate nobody can
    review — and it is contained the same way.
    """
    from adas.runtime import run_camera
    from adas.shadow import ShadowLog

    def body() -> None:
        try:
            with ShadowLog(Path(shadow_path)) as shadow:
                fired = run_camera(source_factory(), config, shadow, emit)
                print(f"[adas] {config.camera}: {fired} alerts", flush=True)
        except Exception as error:  # noqa: BLE001 — see the docstring
            print(f"[adas] {config.camera} stopped: {error}", flush=True)

    thread = threading.Thread(target=body, name=f"adas-{config.camera}", daemon=True)
    thread.start()
    return thread
