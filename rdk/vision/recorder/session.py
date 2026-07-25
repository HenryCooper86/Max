"""Ride recording session.

Cameras are independently optional by design: on this board only one MIPI port
currently streams, and a front-only corpus is still a useful corpus. A camera
that fails to open — or dies mid-ride — is dropped from the ride, never fatal to
it. Only a ride with no cameras at all is an error.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from corpus.library import write_ride_manifest
from recorder.metadata import FrameMeta, MetadataWriter
from recorder.segmenter import Segmenter, ride_id, segment_name


@dataclass(frozen=True)
class CameraSlot:
    name: str
    vcon: int


class RideRecorder:
    def __init__(
        self,
        root: Path | str,
        slots: list[CameraSlot],
        open_fn: Callable[[CameraSlot], object],
        encode_fn: Callable[[object, Path], None],
        video_suffix: str = ".h264",
    ) -> None:
        self.root = Path(root)
        self.slots = slots
        self._open_fn = open_fn
        self._encode_fn = encode_fn
        #: Container the encode_fn writes. ".h264" for the hardware encoder,
        #: ".mjpeg" for the mipi_cam source, which delivers decoded frames.
        self.video_suffix = video_suffix
        self._cameras: dict[str, object] = {}
        self._segmenters: dict[str, Segmenter] = {}
        self._writers: dict[str, MetadataWriter] = {}
        self._frame_index: dict[str, int] = {}
        self._ride_dir: Path | None = None
        self._ride: str | None = None

    @property
    def active_cameras(self) -> list[str]:
        return list(self._cameras.keys())

    def start(self, now_wall_ms: int) -> str:
        for slot in self.slots:
            try:
                self._cameras[slot.name] = self._open_fn(slot)
            except Exception as error:  # noqa: BLE001 - one dead camera is not fatal
                print(f"[recorder] {slot.name} unavailable: {error}")

        if not self._cameras:
            raise RuntimeError("no camera opened; nothing to record")

        self._ride = ride_id(datetime.now())
        self._ride_dir = self.root / self._ride
        write_ride_manifest(
            self._ride_dir, ride=self._ride, cameras=self.active_cameras, started_wall_ms=now_wall_ms
        )
        for name in self._cameras:
            self._segmenters[name] = Segmenter()
        return self._ride

    def _open_segment(self, camera: str, now_s: float) -> None:
        index = self._segmenters[camera].roll(now_s)
        assert self._ride_dir is not None
        base = self._ride_dir / camera / segment_name(index)
        old = self._writers.pop(camera, None)
        if old is not None:
            old.close()
        self._writers[camera] = MetadataWriter(base.with_suffix(".jsonl"))
        self._frame_index[camera] = 0

    def tick(self, now_s: float, now_wall_ms: int) -> int:
        """Capture one frame per live camera. Returns how many were written, so a
        caller can notice the ride going silent."""
        assert self._ride_dir is not None, "start() first"
        written = 0
        for camera, handle in list(self._cameras.items()):
            segmenter = self._segmenters[camera]
            if segmenter.index < 0 or segmenter.should_roll(now_s):
                self._open_segment(camera, now_s)

            base = self._ride_dir / camera / segment_name(segmenter.index)
            try:
                self._encode_fn(handle, base.with_suffix(self.video_suffix))
            except Exception as error:  # noqa: BLE001 - drop this camera, keep the ride
                print(f"[recorder] {camera} stopped: {error}")
                self._cameras.pop(camera, None)
                writer = self._writers.pop(camera, None)
                if writer is not None:
                    writer.close()
                continue

            index = self._frame_index[camera]
            self._writers[camera].append(
                FrameMeta(
                    frame_index=index,
                    mono_ns=int(now_s * 1_000_000_000),
                    wall_ms=now_wall_ms,
                    camera=camera,
                )
            )
            self._frame_index[camera] = index + 1
            written += 1
        return written

    def stop(self) -> None:
        for writer in self._writers.values():
            writer.close()
        self._writers.clear()
        self._cameras.clear()
