"""Read-only index over a recorded ride corpus.

Pure: it reads what the recorder wrote and never mutates a ride. M1's replay
harness walks the corpus through this module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from recorder.metadata import read_metadata

MANIFEST_NAME = "ride.json"
LABELS_NAME = "labels.json"

#: Segment container formats. `.h264` comes from the hardware encoder; `.mjpeg`
#: (concatenated JPEG) comes from the mipi_cam source, which delivers decoded
#: frames rather than an encoded stream.
VIDEO_SUFFIXES = (".h264", ".mjpeg")


@dataclass(frozen=True)
class SegmentInfo:
    camera: str
    name: str
    video_path: Path
    meta_path: Path
    frame_count: int


@dataclass(frozen=True)
class RideInfo:
    ride: str
    path: Path
    cameras: list[str]
    segments: list[SegmentInfo]
    labelled: bool


def write_ride_manifest(ride_dir: Path | str, ride: str, cameras: list[str], started_wall_ms: int) -> Path:
    """`cameras` records which cameras actually opened, not which were asked for
    — a front-only ride is a first-class corpus entry on this hardware."""
    directory = Path(ride_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / MANIFEST_NAME
    path.write_text(
        json.dumps({"ride": ride, "cameras": cameras, "started_wall_ms": started_wall_ms}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def scan_ride(ride_dir: Path | str) -> RideInfo:
    directory = Path(ride_dir)
    manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    cameras = list(manifest.get("cameras", []))

    segments: list[SegmentInfo] = []
    for camera in cameras:
        cam_dir = directory / camera
        if not cam_dir.is_dir():
            continue
        videos = [p for p in cam_dir.glob("seg-*") if p.suffix in VIDEO_SUFFIXES]
        for video in sorted(videos, key=lambda p: p.stem):
            meta_path = video.with_suffix(".jsonl")
            segments.append(
                SegmentInfo(
                    camera=camera,
                    name=video.stem,
                    video_path=video,
                    meta_path=meta_path,
                    frame_count=len(read_metadata(meta_path)),
                )
            )

    return RideInfo(
        ride=manifest.get("ride", directory.name),
        path=directory,
        cameras=cameras,
        segments=segments,
        labelled=(directory / LABELS_NAME).exists(),
    )


def scan_corpus(root: Path | str) -> list[RideInfo]:
    """Newest first — the ride you just recorded is the one you want to label."""
    rides: list[RideInfo] = []
    for directory in sorted(Path(root).iterdir(), reverse=True):
        if not directory.is_dir() or not (directory / MANIFEST_NAME).exists():
            continue
        rides.append(scan_ride(directory))
    return rides
