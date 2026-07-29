"""Max vision sidecar: owns the cameras, captures, gallery, and MJPEG preview."""

from __future__ import annotations

import os
import signal
import socketserver
import sys
import threading
from pathlib import Path

from camera import CameraPair
from events import EventBus
from gallery import Gallery
from rpc import decode_lines, dispatch

SOCKET_PATH = os.environ.get("MAX_VISION_SOCKET", "/run/max/vision.sock")
GALLERY_DIR = os.environ.get("MAX_GALLERY_DIR", "/var/lib/max/gallery")
MIN_FREE_MB = int(os.environ.get("MAX_GALLERY_MIN_FREE_MB", "1024"))
PREVIEW_PORT = int(os.environ.get("MAX_VISION_PREVIEW_PORT", "8081"))
CORPUS_DIR = os.environ.get("MAX_CORPUS_DIR", "/var/lib/max/corpus")
#: Only the exact string "1" enables shadow mode, matching MAX_RELAY_INSECURE_TLS.
ADAS_SHADOW = os.environ.get("MAX_ADAS_SHADOW", "0") == "1"
#: Consent gate. Only "1" lets a frame leave the board.
SHARE_FRAMES = os.environ.get("MAX_VISION_SHARE", "0") == "1"

gallery = Gallery(GALLERY_DIR, MIN_FREE_MB)
events = EventBus()
# MIPI channels, not VCON indices. CAM1 is channel 0 (i2c bus 6, vcon@0/@1) and
# the other connector is channel 2 (bus 4, vcon@2/@3). Channels 1 and 3 are not
# offered because this board does not have hosts 1 and 3 — the previous default
# of front=0 rear=1 named the same connector twice, one of them nonexistent.
cameras = CameraPair(
    front_channel=int(os.environ.get("RDK_CAMERA_FRONT", "0")),
    rear_channel=int(os.environ.get("RDK_CAMERA_REAR", "2")),
)

HANDLERS = {
    "camera.photo": lambda args: cameras.capture_photo(gallery),
    "camera.record": lambda args: (
        cameras.start_recording(gallery) if args.get("start") else cameras.stop_recording(gallery)
    ),
}


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        def write(line: str) -> None:
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        events.register(write)
        try:
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
                        write(line)
        finally:
            # ThreadingUnixStreamServer gives each connection its own thread, so
            # a client that goes away leaves a closure behind unless we say so.
            events.unregister(write)


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True


def main() -> None:
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

    # Before anything can record, so a manifest still flagged `recording` can
    # only belong to a process that is gone. This is what makes a clip the board
    # died partway through show up in the gallery instead of vanishing.
    repaired = gallery.reconcile()
    if repaired:
        print(f"[vision] recovered {len(repaired)} interrupted capture(s): {', '.join(repaired)}", flush=True)

    cameras.open()

    from bench_server import serve as serve_bench  # noqa: PLC0415

    threading.Thread(
        target=serve_bench,
        args=(cameras, gallery, PREVIEW_PORT),
        kwargs={"share_frames": SHARE_FRAMES},
        daemon=True,
    ).start()

    ride = None
    if ADAS_SHADOW:
        # Imported here, not at module scope: ride.py imports start_adas from
        # this module, and a top-level import would be circular.
        from ride import RideSession  # noqa: PLC0415

        open_cameras = {
            name: camera
            for name, camera in (("front", cameras.front), ("rear", cameras.rear))
            if camera is not None
        }
        ride = RideSession(
            cameras=open_cameras,
            corpus_dir=CORPUS_DIR,
            min_free_mb=MIN_FREE_MB,
            broadcast=events.broadcast,
        )
        if ride.start() is None:
            ride = None
    else:
        print("[vision] MAX_ADAS_SHADOW is not 1; no ride, no ADAS", flush=True)

    # systemd stops us with SIGTERM. Without a handler the interpreter tears
    # down while the ROS executor thread is mid-spin, so an ordinary stop prints
    # a traceback and the cameras never get stop()ped.
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))

    with ControlServer(SOCKET_PATH, ControlHandler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        try:
            server.serve_forever()
        finally:
            # Ride first: its threads read from the cameras, so stopping the
            # cameras out from under them would raise on the way down.
            if ride is not None:
                ride.stop()
            # An orphaned mipi_cam holds the ISP, and the next start cannot open
            # the camera at all. Reaping at startup covers a crash; this covers
            # every ordinary stop.
            for camera in (cameras.front, cameras.rear):
                if camera is not None:
                    camera.stop()


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
