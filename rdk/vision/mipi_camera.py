"""One camera, one ``mipi_cam`` process, one holder.

Exactly one process on this board may hold the ISP. A second opener fails with
``The detected sensors are 1 less than expected``, which names sensor detection
when the real cause is a busy device — an hour of debugging pointed at the wrong
layer before that was understood. So the sidecar owns the camera, and every
consumer (photo, preview, recording, ADAS) reads the same latest frame from here.

The ctypes binding in ``camera_binding.py`` remains the alternative, and remains
non-functional: ``hbn_camera_create`` returns -1 for every sensor and VCON tried.
"""

from __future__ import annotations

import threading

from perception.frame_source import Frame


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

    def __init__(self, camera: str, width: int, height: int, encode=None) -> None:
        self.camera = camera
        self.width = width
        self.height = height
        self._encode = encode or _encode_jpeg
        self._lock = threading.Lock()
        self._frame: Frame | None = None
        self._jpeg: bytes | None = None

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

    def latest(self) -> Frame | None:
        with self._lock:
            return self._frame

    def jpeg(self) -> bytes | None:
        with self._lock:
            if self._jpeg is not None:
                return self._jpeg
            frame = self._frame
        if frame is None:
            return None

        # Encode outside the lock: a 3 MB frame takes long enough that holding
        # it would stall the subscriber thread and drop frames.
        data = self._encode(frame.nv12, frame.width, frame.height)
        with self._lock:
            if self._frame is frame:
                self._jpeg = data
        return data
