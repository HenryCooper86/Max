"""Recording-side adapter over the sidecar's camera.

This used to hold a second implementation of mipi_cam ownership. One is enough:
the board allows one holder, so two classes that each spawn a process were two
ways to produce the same orphan — and the version here terminated only the
``ros2`` wrapper, leaving the real node alive and the camera unopenable.
``MipiCamera`` is that one implementation.

Frames are appended as JPEG, so a segment is concatenated JPEG (``.mjpeg``)
rather than an encoded H.264 stream.
"""

from __future__ import annotations

from pathlib import Path

from mipi_camera import MipiCamera


def write_jpeg(camera: MipiCamera, out_path: Path) -> None:
    """Append one JPEG to the segment. Raising propagates to RideRecorder, which
    drops this camera and keeps the ride going."""
    frame = camera.jpeg()
    if frame is None:
        raise RuntimeError(f"no frame available on channel {camera.channel}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("ab") as handle:
        handle.write(frame)
