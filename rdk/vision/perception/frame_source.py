"""The seam that keeps the offline harness and the on-bike runtime identical.

A FrameSource yields (nv12, t_ms, camera) and nothing else. Everything below
this interface — detector, tracker, threat, suppression — is reached by exactly
one code path, so parity is a property of the structure rather than something
maintained by discipline.

FileSource decodes with ffmpeg, which reads both the .mjpeg the mipi_cam
recorder writes and the .h264 the ctypes binding will write, so a clip from
either recording path replays without special-casing.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol


@dataclass(frozen=True)
class Frame:
    nv12: bytes
    #: Capture time. Everything downstream derives dt from this, never from a
    #: frame counter — a dropped frame must not silently change dh/dt.
    t_ms: int
    camera: str
    width: int
    height: int


class FrameSource(Protocol):
    def frames(self) -> Iterator[Frame]: ...


def probe_dims(path: str) -> tuple[int, int]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
        ],
        capture_output=True,
        check=True,
    )
    w, h = (int(v) for v in out.stdout.decode().strip().split("x"))
    return w, h


class FileSource:
    """Frames from a recorded clip, at a fixed sampling rate."""

    def __init__(
        self, path: str, camera: str, fps: float = 10.0, start_t_ms: int = 0
    ) -> None:
        self.path = path
        self.camera = camera
        self.fps = fps
        self.start_t_ms = start_t_ms

    def frames(self) -> Iterator[Frame]:
        if not Path(self.path).exists():
            raise FileNotFoundError(self.path)
        width, height = probe_dims(self.path)
        frame_bytes = width * height * 3 // 2

        proc = subprocess.Popen(
            [
                "ffmpeg", "-v", "error", "-i", self.path,
                "-vf", f"fps={self.fps}", "-pix_fmt", "nv12",
                "-f", "rawvideo", "-",
            ],
            stdout=subprocess.PIPE,
        )
        assert proc.stdout is not None
        try:
            index = 0
            while True:
                buf = proc.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                yield Frame(
                    nv12=buf,
                    t_ms=self.start_t_ms + round(index * 1000.0 / self.fps),
                    camera=self.camera,
                    width=width,
                    height=height,
                )
                index += 1
        finally:
            proc.stdout.close()
            proc.wait()
