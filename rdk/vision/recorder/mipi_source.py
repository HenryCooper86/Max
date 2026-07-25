"""Frame source backed by the vendor's ``mipi_cam`` ROS node.

Why not our own ctypes binding: ``hbn_camera_create`` still returns -1 with a
matching sensor spec and the correct VCON, so it cannot open a camera yet.
``mipi_cam`` demonstrably can — it streams 1920x1080 @ 30 fps from an IMX219 on
channel 2 — so recording rides through it beats blocking the corpus on a binding
that does not work.

The cost is a ROS dependency in the recording path only. Nothing else in the
sidecar imports this module, and `--source binding` stays available for the day
the binding works.

Frames arrive decoded on ``/image_raw`` and are JPEG-encoded here, so a segment
is concatenated JPEG (``.mjpeg``) rather than an encoded H.264 stream.
"""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

TOPIC = "/image_raw"
#: mipi_cam names sensors in upper case (video_device:=IMX219).
DEFAULT_SENSOR = "IMX219"


class MipiCamSource:
    """Owns one ``mipi_cam`` process plus an rclpy subscriber.

    ``read()`` returns the most recent JPEG frame, or raises if none has arrived
    — matching the contract RideRecorder expects, where a raising source means
    "this camera is gone" and the ride continues without it.
    """

    def __init__(self, channel: int, sensor: str = DEFAULT_SENSOR, width: int = 1920, height: int = 1080) -> None:
        self.channel = channel
        self.sensor = sensor
        self.width = width
        self.height = height
        self._proc: subprocess.Popen | None = None
        self._latest: bytes | None = None
        self._lock = threading.Lock()
        self._node = None
        self._executor = None
        self._spin_thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self, settle_seconds: float = 8.0) -> None:
        import cv2  # noqa: PLC0415 - board-only
        import numpy as np  # noqa: PLC0415
        import rclpy  # noqa: PLC0415
        from sensor_msgs.msg import Image  # noqa: PLC0415

        self._proc = subprocess.Popen(
            [
                "ros2",
                "run",
                "mipi_cam",
                "mipi_cam",
                "--ros-args",
                "-p",
                f"video_device:={self.sensor}",
                "-p",
                f"channel:={self.channel}",
                "-p",
                f"image_width:={self.width}",
                "-p",
                f"image_height:={self.height}",
                "-p",
                "out_format:=bgr8",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        if not rclpy.ok():
            rclpy.init()
        self._node = rclpy.create_node(f"max_recorder_ch{self.channel}")

        def on_image(msg) -> None:
            # bgr8 is a plain HxWx3 byte buffer, so cv_bridge buys us nothing
            # here and would be another dependency to install on the board.
            frame = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, 3)
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if ok:
                with self._lock:
                    self._latest = buf.tobytes()

        self._node.create_subscription(Image, TOPIC, on_image, 10)

        # Each source gets its own executor. rclpy.spin_once() drives a global
        # one, so two cameras spinning concurrently raise "generator already
        # executing" — which is exactly what front+rear would hit.
        from rclpy.executors import SingleThreadedExecutor  # noqa: PLC0415

        self._executor = SingleThreadedExecutor()
        self._executor.add_node(self._node)

        def spin() -> None:
            while not self._stop.is_set() and rclpy.ok():
                self._executor.spin_once(timeout_sec=0.1)

        self._spin_thread = threading.Thread(target=spin, daemon=True)
        self._spin_thread.start()

        # mipi_cam needs several seconds to probe the sensor and start the flow.
        deadline = time.monotonic() + settle_seconds
        while time.monotonic() < deadline:
            with self._lock:
                if self._latest is not None:
                    return
            if self._proc.poll() is not None:
                raise RuntimeError(f"mipi_cam exited early on channel {self.channel}")
            time.sleep(0.2)
        raise RuntimeError(f"no frame on {TOPIC} within {settle_seconds:.0f}s (channel {self.channel})")

    def read(self) -> bytes:
        with self._lock:
            if self._latest is None:
                raise RuntimeError(f"no frame available on channel {self.channel}")
            return self._latest

    def stop(self) -> None:
        self._stop.set()
        if self._spin_thread is not None:
            self._spin_thread.join(timeout=2.0)
        if self._executor is not None:
            self._executor.remove_node(self._node)
            self._executor.shutdown()
            self._executor = None
        if self._node is not None:
            self._node.destroy_node()
            self._node = None
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None


def write_jpeg(handle: MipiCamSource, out_path: Path) -> None:
    """Append one JPEG to the segment. Raising propagates to RideRecorder, which
    drops this camera and keeps the ride going."""
    frame = handle.read()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("ab") as fh:
        fh.write(frame)
