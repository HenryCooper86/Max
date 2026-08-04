"""Max vision sidecar: owns the cameras, captures, gallery, and MJPEG preview."""

from __future__ import annotations

import contextlib
import os
import signal
import socketserver
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from camera import CameraPair
from events import EventBus
from gallery import Gallery
from rpc import Handler, decode_lines, dispatch


@dataclass(frozen=True)
class VisionConfig:
    socket_path: str = "/run/max/vision.sock"
    gallery_dir: str = "/var/lib/max/gallery"
    min_free_mb: int = 1024
    preview_port: int = 8081
    corpus_dir: str = "/var/lib/max/corpus"
    adas_shadow: bool = False
    share_frames: bool = False
    front_channel: int = 0
    rear_channel: int = 2

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "VisionConfig":
        values = os.environ if env is None else env
        return cls(
            socket_path=values.get("MAX_VISION_SOCKET", "/run/max/vision.sock"),
            gallery_dir=values.get("MAX_GALLERY_DIR", "/var/lib/max/gallery"),
            min_free_mb=int(values.get("MAX_GALLERY_MIN_FREE_MB", "1024")),
            preview_port=int(values.get("MAX_VISION_PREVIEW_PORT", "8081")),
            corpus_dir=values.get("MAX_CORPUS_DIR", "/var/lib/max/corpus"),
            adas_shadow=values.get("MAX_ADAS_SHADOW", "0") == "1",
            share_frames=values.get("MAX_VISION_SHARE", "0") == "1",
            front_channel=int(values.get("RDK_CAMERA_FRONT", "0")),
            rear_channel=int(values.get("RDK_CAMERA_REAR", "2")),
        )


@dataclass
class VisionRuntime:
    gallery: Gallery
    events: EventBus
    cameras: CameraPair
    handlers: dict[str, Handler]


def build_runtime(config: VisionConfig) -> VisionRuntime:
    gallery = Gallery(config.gallery_dir, config.min_free_mb)
    events = EventBus()
    # MIPI channels, not VCON indices. CAM1 is channel 0 (i2c bus 6, vcon@0/@1) and
    # the other connector is channel 2 (bus 4, vcon@2/@3). Channels 1 and 3 are not
    # offered because this board does not have hosts 1 and 3 — the previous default
    # of front=0 rear=1 named the same connector twice, one of them nonexistent.
    cameras = CameraPair(
        front_channel=config.front_channel,
        rear_channel=config.rear_channel,
    )
    handlers: dict[str, Handler] = {
        "camera.photo": lambda args: cameras.capture_photo(gallery),
        "camera.record": lambda args: (
            cameras.start_recording(gallery)
            if args.get("start")
            else cameras.stop_recording(gallery)
        ),
    }
    return VisionRuntime(
        gallery=gallery,
        events=events,
        cameras=cameras,
        handlers=handlers,
    )


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        runtime = self.server.runtime
        # RPC responses (this thread) and hazard broadcasts (ADAS threads)
        # share one wfile; unsynchronised, they interleave bytes mid-line on a
        # channel whose whole contract is one JSON message per line.
        write_lock = threading.Lock()

        def write(line: str) -> None:
            with write_lock:
                self.wfile.write(line.encode("utf-8"))
                self.wfile.flush()

        runtime.events.register(write)
        try:
            buffer = ""
            while True:
                chunk = self.rfile.readline()
                if not chunk:
                    return
                buffer += chunk.decode("utf-8", errors="replace")
                messages, buffer = decode_lines(buffer)
                for message in messages:
                    line = dispatch(message, runtime.handlers)
                    if line:
                        write(line)
        finally:
            # ThreadingUnixStreamServer gives each connection its own thread, so
            # a client that goes away leaves a closure behind unless we say so.
            runtime.events.unregister(write)


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        socket_path: str,
        handler: type[socketserver.StreamRequestHandler],
        runtime: VisionRuntime,
    ) -> None:
        self.runtime = runtime
        super().__init__(socket_path, handler)


def finalize(cameras, gallery, ride) -> None:
    """Shutdown: finish a live recording, stop the ride, release the cameras.

    An ordinary `systemctl stop` should produce a finished manifest itself
    rather than leaning on the next boot's reconcile.
    """
    if cameras.recording_id is not None:
        cameras.stop_recording(gallery)
    # Ride first among the readers: its threads read from the cameras, so
    # stopping the cameras out from under them would raise on the way down.
    if ride is not None:
        ride.stop()
    # An orphaned mipi_cam holds the ISP, and the next start cannot open
    # the camera at all. Reaping at startup covers a crash; this covers
    # every ordinary stop.
    for camera in (cameras.front, cameras.rear):
        if camera is not None:
            camera.stop()


def require_cameras(cameras) -> None:
    """Exit when the pair opened with no cameras, or short of a detected one.

    A boot can race the camera stack: on 2026-07-31 the sidecar came up
    seconds after power-on, ``discover()`` saw an empty bus, and the service
    ran camera-less until a human restarted it — the staleness monitor never
    fired because it only watches cameras that opened. Exiting hands the
    retry to systemd (``StartLimitIntervalSec=0``, every 2 s), which keeps
    trying until the stack is ready. Voice is unaffected; max-agent does not
    ``Require=`` this service and reports camera failures truthfully.

    ``failed`` is the same race one layer deeper, measured at the 2026-08-01
    boot: i2c saw the front OV5647 but its open stalled in the ISP, and the
    sidecar served rear-only for a whole boot with nothing in the journal
    after the open. A sensor the bus can see is a promise that it streams;
    falling short of it restarts the service just as a stale camera does.

    One camera is enough — front-only is normal on this hardware — so long as
    every *attached* camera opened. A deliberately camera-less bench will
    crash-loop visibly, which is the fail-loud trade: stop the service instead
    of running it blind.
    """
    if cameras.opened and not cameras.failed:
        return
    if not cameras.opened:
        print("[vision] no cameras opened; exiting for systemd to retry the open", flush=True)
    else:
        print(
            f"[vision] detected camera(s) failed to open: {', '.join(cameras.failed)}; "
            "exiting for systemd to retry the open",
            flush=True,
        )
    raise SystemExit(1)


def main() -> None:
    config = VisionConfig.from_env()
    runtime = build_runtime(config)

    if os.path.exists(config.socket_path):
        os.unlink(config.socket_path)
    os.makedirs(os.path.dirname(config.socket_path), exist_ok=True)

    # Before anything can record, so a manifest still flagged `recording` can
    # only belong to a process that is gone. This is what makes a clip the board
    # died partway through show up in the gallery instead of vanishing.
    repaired = runtime.gallery.reconcile()
    if repaired:
        print(f"[vision] recovered {len(repaired)} interrupted capture(s): {', '.join(repaired)}", flush=True)

    runtime.cameras.open()
    require_cameras(runtime.cameras)

    from monitor import start_monitor  # noqa: PLC0415
    from notify import sd_notify  # noqa: PLC0415

    def exit_stale(stale: list[str]) -> None:
        print(f"[vision] camera frames stale: {', '.join(stale)}; exiting for systemd to restart", flush=True)
        os._exit(1)

    start_monitor(runtime.cameras, notify=sd_notify, on_stale=exit_stale)

    from bench_server import serve as serve_bench  # noqa: PLC0415

    threading.Thread(
        target=serve_bench,
        args=(runtime.cameras, runtime.gallery, config.preview_port),
        kwargs={"share_frames": config.share_frames},
        daemon=True,
    ).start()

    ride = None
    if config.adas_shadow:
        # Imported here, not at module scope: ride.py imports start_adas from
        # this module, and a top-level import would be circular.
        from ride import RideSession  # noqa: PLC0415

        open_cameras = {
            name: camera
            for name, camera in (("front", runtime.cameras.front), ("rear", runtime.cameras.rear))
            if camera is not None
        }
        ride = RideSession(
            cameras=open_cameras,
            corpus_dir=config.corpus_dir,
            min_free_mb=config.min_free_mb,
            broadcast=runtime.events.broadcast,
        )
        if ride.start() is None:
            ride = None
    else:
        print("[vision] MAX_ADAS_SHADOW is not 1; no ride, no ADAS", flush=True)

    # systemd stops us with SIGTERM. Without a handler the interpreter tears
    # down while the ROS executor thread is mid-spin, so an ordinary stop prints
    # a traceback and the cameras never get stop()ped.
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))

    with ControlServer(config.socket_path, ControlHandler, runtime) as server:
        os.chmod(config.socket_path, 0o660)
        try:
            server.serve_forever()
        finally:
            finalize(runtime.cameras, runtime.gallery, ride)
            with contextlib.suppress(OSError):
                os.unlink(config.socket_path)


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
            with ShadowLog(Path(shadow_path), tuning=config.tuning) as shadow:
                fired = run_camera(source_factory(), config, shadow, emit)
                print(f"[adas] {config.camera}: {fired} alerts", flush=True)
        except Exception as error:  # noqa: BLE001 — see the docstring
            print(f"[adas] {config.camera} stopped: {error}", flush=True)

    thread = threading.Thread(target=body, name=f"adas-{config.camera}", daemon=True)
    thread.start()
    return thread
