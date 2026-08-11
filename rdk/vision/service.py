"""Max vision sidecar: owns the cameras, captures, gallery, and MJPEG preview."""

from __future__ import annotations

import contextlib
import os
import queue
import signal
import socket
import socketserver
import sys
import threading
from dataclasses import dataclass
from typing import Mapping

from camera import CameraPair
from events import EventBus
from gallery import Gallery
from rpc import Handler, decode_lines, dispatch
from watch.sampler import WatchSampler


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
    #: Shared secret for the bench HTTP surface. Empty means nothing off-box is
    #: served at all — see bench_server.authorized. The agent reads the same
    #: variable so the HUD page it serves can carry the token.
    vision_token: str = ""

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
            vision_token=values.get("MAX_VISION_TOKEN", "").strip(),
        )


@dataclass
class VisionRuntime:
    gallery: Gallery
    events: EventBus
    cameras: CameraPair
    handlers: dict[str, Handler]
    watcher: WatchSampler


def _handle_watch_toggle(watcher: WatchSampler, args: dict) -> dict:
    """vision.watch: {"on": bool} -> the sampler's enabled state.

    device-actions.ts's IssuedDeviceCommand for "vision.watch" carries
    ``args: { on: boolean }``, forwarded to the vision RPC unchanged by
    dispatch.ts — so ``on`` is the key this handler reads, matching
    ``camera.record``'s ``start`` for the same on/off shape.
    """
    watcher.set_enabled(bool(args.get("on")))
    return {"status": "ok"}


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
    # grab_jpeg reads through CameraPair.front_jpeg_for_watch(), which mirrors
    # /frame/front's _grab + downscale path in-process — no HTTP round trip,
    # since the sampler already lives inside this service.
    watcher = WatchSampler(grab_jpeg=cameras.front_jpeg_for_watch, broadcast=events.broadcast)
    handlers: dict[str, Handler] = {
        "camera.photo": lambda args: cameras.capture_photo(gallery),
        "camera.record": lambda args: (
            cameras.start_recording(gallery)
            if args.get("start")
            else cameras.stop_recording(gallery)
        ),
        "vision.watch": lambda args: _handle_watch_toggle(watcher, args),
    }
    return VisionRuntime(
        gallery=gallery,
        events=events,
        cameras=cameras,
        handlers=handlers,
        watcher=watcher,
    )


#: How many unwritten lines one control connection may bank.
#:
#: Deep enough to ride out a brief stall in the agent, shallow enough that a
#: client which stopped reading cannot pin megabytes of base64 watch frames in
#: RAM on a 4 GB board.
EVENT_QUEUE_DEPTH = 32

#: How long a broadcast may wait for room before its client is written off.
#:
#: This is a wedge detector, not a rate limit. A connected agent that is
#: reading drains continuously, so a producer waits microseconds and no event
#: is ever lost — which is the property test_concurrent_writes_do_not_interleave
#: pins. A client that has stopped reading blocks exactly one producer for this
#: long, once, and is then dropped from the event registry; every later
#: broadcast returns immediately.
EVENT_ENQUEUE_TIMEOUT_S = 2.0

#: How long a *response* may wait for room before this connection is given up
#: on. A client not draining its own answers is not a client; dropping it lets
#: the agent's reconnect loop start a working one.
RESPONSE_ENQUEUE_TIMEOUT_S = 5.0


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        runtime = self.server.runtime
        # One writer owns the wfile. RPC responses (this thread) and hazard
        # broadcasts (ADAS threads) used to share it under a lock, which kept
        # lines whole but made the socket's backpressure the *producer's*
        # problem: once both buffers filled, an ADAS thread reporting a
        # collision sat inside broadcast() until the agent drained a watch
        # frame queued seconds earlier. Detection stopped because a bench
        # instrument was slow.
        #
        # A bounded queue plus a single writer keeps lines whole for the same
        # reason the lock did, and keeps a slow reader's cost local to its own
        # connection.
        outbox: "queue.Queue[str | None]" = queue.Queue(maxsize=EVENT_QUEUE_DEPTH)

        def pump() -> None:
            while True:
                line = outbox.get()
                if line is None:
                    return
                try:
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                except OSError:
                    # The client is gone. handle() learns the same thing from
                    # its own read returning empty, and cleans up there.
                    return

        writer = threading.Thread(target=pump, name="control-writer", daemon=True)
        writer.start()

        def write_event(line: str) -> None:
            """Enqueue a broadcast, or give up on this client.

            Raising is deliberate: EventBus drops a client whose write raises,
            so one wedged connection costs one bounded wait rather than every
            later hazard the ADAS threads try to report.
            """
            if not writer.is_alive():
                raise OSError("control writer stopped")
            try:
                outbox.put(line, timeout=EVENT_ENQUEUE_TIMEOUT_S)
            except queue.Full:
                print(
                    "[vision] control client stopped reading; dropping it from the event registry",
                    flush=True,
                )
                raise OSError("control client is not draining events") from None

        def write_response(line: str) -> str | None:
            """Enqueue an answer. Bounded, and only ever blocks this thread."""
            try:
                outbox.put(line, timeout=RESPONSE_ENQUEUE_TIMEOUT_S)
            except queue.Full:
                return "response"
            return None

        runtime.events.register(write_event)
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
                    if line and write_response(line) is not None:
                        print(
                            "[vision] control client never made room for its own response; "
                            "closing the connection",
                            flush=True,
                        )
                        return
        finally:
            # ThreadingUnixStreamServer gives each connection its own thread, so
            # a client that goes away leaves a closure behind unless we say so.
            runtime.events.unregister(write_event)
            # Watching dies with the connection: the agent is the only control
            # client in production, so any disconnect — clean or not — must
            # stop the sampler rather than leave it broadcasting to no one.
            runtime.watcher.set_enabled(False)
            # Unblock a writer parked in sendall() on a client that stopped
            # reading, so this connection's thread does not outlive its handler.
            with contextlib.suppress(OSError):
                self.connection.shutdown(socket.SHUT_WR)
            with contextlib.suppress(queue.Full):
                outbox.put_nowait(None)
            writer.join(timeout=2.0)


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True

    def __init__(
        self,
        socket_path: str,
        handler: type[socketserver.StreamRequestHandler],
        runtime: VisionRuntime,
    ) -> None:
        self.runtime = runtime
        super().__init__(socket_path, handler)


def finalize(cameras, gallery, ride, watcher, monitor=None) -> None:
    """Shutdown: finish a live recording, stop the ride, release the cameras.

    An ordinary `systemctl stop` should produce a finished manifest itself
    rather than leaning on the next boot's reconcile.
    """
    if cameras.recording_id is not None:
        cameras.stop_recording(gallery)
    # Before anything it watches. The frame monitor's whole job is to call
    # os._exit(1) when frames stop arriving, and stopping the cameras below is
    # the most reliable way to stop frames arriving — so left running it turned
    # every clean shutdown into `1/FAILURE` in the journal. `None` is a real
    # state: a camera-less bench run never starts one.
    if monitor is not None:
        monitor.stop()
    # Ride and the watcher both read from the cameras (ride's ADAS threads
    # directly, the watcher through front_jpeg_for_watch), so both must stop
    # before the cameras do or their next grab raises on the way down.
    # ControlHandler's disconnect-disable does NOT cover this path: SIGTERM's
    # sys.exit(0) unwinds serve_forever() in the main thread, but an already
    # accepted connection's handler thread keeps running on its own — nothing
    # about a signal closes it, so finally in ControlHandler.handle() never
    # runs here and the watcher would otherwise keep sampling.
    if ride is not None:
        ride.stop()
    watcher.stop()
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

    monitor = start_monitor(runtime.cameras, notify=sd_notify, on_stale=exit_stale)

    from bench_server import serve as serve_bench  # noqa: PLC0415

    if not config.vision_token:
        print(
            "[vision] MAX_VISION_TOKEN is unset; the bench HTTP surface serves "
            "127.0.0.1 only and refuses every other peer",
            flush=True,
        )
    threading.Thread(
        target=serve_bench,
        args=(runtime.cameras, runtime.gallery, config.preview_port),
        kwargs={"share_frames": config.share_frames, "token": config.vision_token},
        daemon=True,
    ).start()

    ride = None
    if config.adas_shadow:
        # Still function-local, but no longer to break a cycle: ride.py pulls in
        # the recorder and the ADAS stack (numpy, cv2), which only exist on the
        # board, and a camera-less bench run must still import this module.
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
            finalize(runtime.cameras, runtime.gallery, ride, runtime.watcher, monitor)
            with contextlib.suppress(OSError):
                os.unlink(config.socket_path)


if __name__ == "__main__":
    main()
