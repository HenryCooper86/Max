"""One camera, one ``mipi_cam`` process, one holder.

Exactly one process on this board may hold a given camera's pipeline. A second
opener of the same camera fails with ``The detected sensors are 1 less than
expected``, which names sensor detection when the real cause is a busy device —
an hour of debugging pointed at the wrong layer before that was understood.
(Two processes driving two *different* sensors coexist fine: both hold the same
vs-isp0/vse0 nodes and stream ~30 fps each, measured 2026-08-01.) So the
sidecar owns the cameras, and every consumer (photo, preview, recording, ADAS)
reads the same latest frame from here.

The ctypes binding in ``camera_binding.py`` remains the alternative, and remains
non-functional: ``hbn_camera_create`` returns -1 for every sensor and VCON tried.
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import threading
import time
from typing import Iterator

from perception.frame_source import Frame

#: One of the nodes a live mipi_cam holds. Checking one is enough — they are
#: acquired together (both cameras hold the same vs-isp0/vse0 set, measured
#: 2026-08-01) — and it is the one whose holder blocks the next open.
ISP_DEVICE = "/dev/vs-isp0_cap"

#: How stale a served JPEG may be when the caller opts in. At 24 fps capture
#: a 100 ms-old frame is within one 10 fps recording period; sharing one
#: encode across recorder + preview cuts ~30 encodes/s to at most 10 — a
#: measured slice of the 94 °C shadow-ride plateau.
JPEG_MAX_AGE_MS = 100.0


def _encode_jpeg(nv12: bytes, width: int, height: int) -> bytes | None:
    """NV12 -> JPEG. Board-only: cv2 and numpy are not on the dev machine."""
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    planar = np.frombuffer(nv12, dtype=np.uint8).reshape(height * 3 // 2, width)
    bgr = cv2.cvtColor(planar, cv2.COLOR_YUV2BGR_NV12)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return buf.tobytes() if ok else None


class FrameBuffer:
    """The latest frame, plus a JPEG of it encoded only if someone asks.

    Encoding eagerly would burn CPU on frames nobody reads: ADAS consumes nv12
    directly, and preview pulls at 10 fps from a 24 fps stream.
    """

    def __init__(self, camera: str, width: int, height: int, encode=None, clock=time.monotonic) -> None:
        self.camera = camera
        self.width = width
        self.height = height
        self._encode = encode or _encode_jpeg
        self._clock = clock
        self._lock = threading.Lock()
        self._frame: Frame | None = None
        self._jpeg: bytes | None = None
        self._received_at: float | None = None
        self._last_jpeg: bytes | None = None
        self._last_jpeg_at: float | None = None

    def put(self, nv12: bytes, t_ms: int) -> None:
        with self._lock:
            self._frame = Frame(
                nv12=nv12,
                t_ms=t_ms,
                camera=self.camera,
                width=self.width,
                height=self.height,
            )
            self._jpeg = None
            self._received_at = self._clock()

    def latest(self) -> Frame | None:
        with self._lock:
            return self._frame

    def jpeg(self, max_age_ms: float | None = None) -> bytes | None:
        with self._lock:
            if self._jpeg is not None:
                return self._jpeg  # current frame's encode — exact, as always
            if (
                max_age_ms is not None
                and self._last_jpeg is not None
                and self._last_jpeg_at is not None
                and (self._clock() - self._last_jpeg_at) * 1000.0 <= max_age_ms
            ):
                # A newer frame exists but the last encode is younger than the
                # caller's staleness budget. Serving it is what turns thirty
                # encodes a second into ten.
                return self._last_jpeg
            frame = self._frame
        if frame is None:
            return None

        # Encode outside the lock: a 3 MB frame takes long enough that holding
        # it would stall the subscriber thread and drop frames.
        data = self._encode(frame.nv12, frame.width, frame.height)
        with self._lock:
            if self._frame is frame:
                self._jpeg = data
            if data is not None:
                self._last_jpeg = data
                self._last_jpeg_at = self._clock()
        return data

    def age_seconds(self) -> float | None:
        """Seconds since the last frame arrived; None before the first one."""
        with self._lock:
            if self._received_at is None:
                return None
            return self._clock() - self._received_at


def _isp_holders(run=subprocess.run) -> list[int]:
    """PIDs holding the ISP capture node, via fuser. Empty if fuser is absent."""
    try:
        out = run(["fuser", ISP_DEVICE], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(token) for token in out.split() if token.isdigit()]


def reap_orphans(holders=_isp_holders, kill=os.kill, sleep=time.sleep) -> list[int]:
    """Clear any process still holding the camera, and report what was killed.

    Without this a max-vision restart can never reacquire the camera: the dead
    service's child keeps the ISP, and the next open fails with a message about
    sensor detection that sends you looking at i2c. Measured, not hypothesised.

    Called once per acquisition cycle by the opener (CameraPair.open,
    record_ride) — never per camera, or the second camera reaps the first.
    """
    pids = holders()
    if not pids:
        return []

    for pid in pids:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            kill(pid, signal.SIGTERM)
    sleep(2.0)
    for pid in holders():
        with contextlib.suppress(ProcessLookupError, PermissionError):
            kill(pid, signal.SIGKILL)
    return pids


def init_ros(rclpy, signal_options="auto") -> None:
    """Bring the ROS context up without letting it take our signal handlers.

    ``rclpy.init()`` installs its own SIGINT/SIGTERM handlers by default, and
    that is what made a `systemctl stop max-vision` during camera acquisition
    look like a crash. Measured on the board 2026-08-11: the stop replaced
    service.py's handler, so instead of exiting, rclpy shut its context down;
    the mipi_cam children died with the cgroup, the front camera's open failed
    ("mipi_cam exited early"), the rear camera's own init failed ("Context.init()
    must only be called once"), and ``require_cameras`` then exited 1 —
    a deliberate stop reported in the journal as a failure, twice over.

    Camera acquisition takes ~19 s on this board, so that window is wide enough
    to hit by hand. Keeping our handler installed for the whole run is what
    makes a stop during it exit 0.

    An rclpy too old to know the option gets a plain init: the pre-existing
    behaviour for that window beats refusing to open the cameras at all.
    """
    if rclpy.ok():
        return
    if signal_options == "auto":
        try:
            from rclpy.signals import SignalHandlerOptions  # noqa: PLC0415 - board-only

            signal_options = SignalHandlerOptions
        except ImportError:
            signal_options = None
    if signal_options is None:
        rclpy.init()
        return
    try:
        rclpy.init(signal_handler_options=signal_options.NO)
    except TypeError:
        rclpy.init()


def launch_command(
    sensor: str, channel: int, width: int, height: int, topic: str, node_name: str
) -> list[str]:
    """The ros2 invocation for one camera, remapped onto its own topic.

    The vendor node publishes a hardcoded ``/image_raw`` under a hardcoded node
    name. With two cameras that is the measured flicker: two publishers on one
    topic (confirmed 2026-08-01, ~50 Hz combined on ``/image_raw``), so every
    subscriber drinks both sensors' frames interleaved — and the staleness
    monitor goes blind, because a dead camera's buffer stays fresh on the other
    camera's frames. ``-r`` moves each node onto ``/<camera>/image_raw``;
    verified against the real node before this was written.
    """
    return [
        "ros2", "run", "mipi_cam", "mipi_cam", "--ros-args",
        "-r", f"__node:={node_name}",
        "-r", f"/image_raw:={topic}",
        "-p", f"video_device:={sensor}",
        "-p", f"channel:={channel}",
        "-p", f"image_width:={width}",
        "-p", f"image_height:={height}",
        "-p", "out_format:=nv12",
        # The node logs one INFO line per captured frame — ~24 a second,
        # forever. Its stdout is discarded, but ROS also writes them to
        # disk, so quiet it at the source.
        "--log-level", "WARN",
    ]


def _signal_group(proc, sig, killpg=os.killpg, getpgid=os.getpgid) -> None:
    """Signal the child's whole process group.

    ``ros2 run`` is a wrapper that execs the real node as a child. Signalling
    only the wrapper leaves that node alive, reparented to init and still
    holding the ISP — and ``proc.wait()`` returns cleanly, so nothing looks
    wrong until the next open fails. Measured on 2026-07-27.
    """
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        killpg(getpgid(proc.pid), sig)


class MipiCamera:
    """Owns one mipi_cam process and the subscriber that drains it."""

    def __init__(
        self,
        channel: int,
        sensor: str,
        camera: str,
        width: int = 1920,
        height: int = 1080,
    ) -> None:
        self.channel = channel
        self.sensor = sensor
        self.width = width
        self.height = height
        #: Per-camera topic and node name. Sharing the vendor defaults across
        #: two cameras is the flicker: see ``launch_command``.
        self.topic = f"/{camera}/image_raw"
        self.node_name = f"mipi_cam_{camera}"
        self.buffer = FrameBuffer(camera, width, height)
        self._proc: subprocess.Popen | None = None
        self._node = None
        self._executor = None
        self._spin_thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self, settle_seconds: float = 8.0) -> None:
        import rclpy  # noqa: PLC0415 - board-only
        from rclpy.executors import SingleThreadedExecutor  # noqa: PLC0415
        from sensor_msgs.msg import Image  # noqa: PLC0415

        self._proc = subprocess.Popen(
            launch_command(
                self.sensor, self.channel, self.width, self.height,
                self.topic, self.node_name,
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Its own session, so stop() can signal the wrapper and the real
            # node as one group. Without this the node outlives us.
            start_new_session=True,
        )

        def on_image(msg) -> None:
            stamp = msg.header.stamp
            self.buffer.put(
                bytes(msg.data), int(stamp.sec * 1000 + stamp.nanosec // 1_000_000)
            )

        init_ros(rclpy)
        self._node = rclpy.create_node(f"max_vision_ch{self.channel}")
        self._node.create_subscription(Image, self.topic, on_image, 10)

        # Each camera gets its own executor. rclpy.spin_once() drives a global
        # one, so two cameras spinning concurrently raise "generator already
        # executing" — exactly what front+rear would hit.
        self._executor = SingleThreadedExecutor()
        self._executor.add_node(self._node)

        def spin() -> None:
            while not self._stop.is_set() and rclpy.ok():
                try:
                    self._executor.spin_once(timeout_sec=0.1)
                except Exception as error:  # noqa: BLE001 - see below
                    # The executor gets torn down under this thread whenever the
                    # process exits. Silent when we asked for it; loud otherwise,
                    # because a spin thread that dies on its own means no frames.
                    if not self._stop.is_set():
                        print(
                            f"[vision] spin stopped on channel {self.channel}: {error}",
                            flush=True,
                        )
                    return

        self._spin_thread = threading.Thread(target=spin, daemon=True)
        self._spin_thread.start()

        # mipi_cam needs several seconds to probe the sensor and start the flow.
        # Paying it here, once at service start, is what keeps a capture a frame
        # grab — and so inside the relay's 8 s DEVICE_RESULT_TIMEOUT_MS.
        deadline = time.monotonic() + settle_seconds
        while time.monotonic() < deadline:
            if self.buffer.latest() is not None:
                return
            if self._proc.poll() is not None:
                raise RuntimeError(f"mipi_cam exited early on channel {self.channel}")
            time.sleep(0.2)
        raise RuntimeError(
            f"no frame on {self.topic} within {settle_seconds:.0f}s (channel {self.channel})"
        )

    def latest(self) -> Frame | None:
        return self.buffer.latest()

    def jpeg(self, max_age_ms: float | None = None) -> bytes | None:
        return self.buffer.jpeg(max_age_ms)

    def age_seconds(self) -> float | None:
        return self.buffer.age_seconds()

    def frames(self, fps: float = 10.0) -> Iterator[Frame]:
        """Satisfies the FrameSource protocol, so ADAS reaches live frames through
        the same seam as FileSource and replay parity stays structural."""
        interval = 1.0 / fps
        last_t: int | None = None
        while not self._stop.is_set():
            frame = self.buffer.latest()
            if frame is not None and frame.t_ms != last_t:
                last_t = frame.t_ms
                yield frame
            time.sleep(interval / 2)

    def stop(self) -> None:
        self._stop.set()
        if self._spin_thread is not None:
            self._spin_thread.join(timeout=2.0)
            self._spin_thread = None
        if self._executor is not None:
            self._executor.remove_node(self._node)
            self._executor.shutdown()
            self._executor = None
        if self._node is not None:
            self._node.destroy_node()
            self._node = None
        if self._proc is not None:
            # Signal the GROUP, not the process: proc.terminate() reaps only the
            # ros2 wrapper and leaves the real node holding the ISP, at which
            # point wait() returns cleanly and nothing looks wrong until the
            # next open fails with a message about sensor detection.
            _signal_group(self._proc, signal.SIGTERM)
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _signal_group(self._proc, signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self._proc.wait(timeout=5)
            self._proc = None
