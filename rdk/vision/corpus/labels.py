"""Hazard-window labels — the ground truth M1 measures against.

Deliberately coarse: a labeller marks the time range in which a genuine hazard
existed, per threat, per camera. Precise boxes are not needed to answer the only
question that matters — did we fire at the right moments, and how often did we
fire when nothing was there.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

LABELS_NAME = "labels.json"

#: Must remain a subset of ADAS_THREATS in shared/adas.ts — enforced by test.
V1_THREATS = ("forward_collision", "pedestrian_ahead", "rear_approach", "tailgating")

VALID_CAMERAS = ("front", "rear")


class LabelError(ValueError):
    """Raised for a window that would corrupt the corpus."""


@dataclass(frozen=True)
class HazardWindow:
    threat: str
    camera: str
    start_ms: int
    end_ms: int
    note: str = ""


def validate_window(window: HazardWindow) -> None:
    if window.threat not in V1_THREATS:
        raise LabelError(f"unknown threat {window.threat!r}; expected one of {V1_THREATS}")
    if window.camera not in VALID_CAMERAS:
        raise LabelError(f"unknown camera {window.camera!r}; expected one of {VALID_CAMERAS}")
    if window.end_ms <= window.start_ms:
        raise LabelError(f"window must have positive duration, got {window.start_ms}..{window.end_ms}")


def merge_windows(windows: list[HazardWindow]) -> list[HazardWindow]:
    """Merge overlapping windows sharing a threat AND camera. Two labellers
    marking the same event, or one person marking it twice, must not count as two
    hazards when M1 scores recall."""
    by_key: dict[tuple[str, str], list[HazardWindow]] = {}
    for window in windows:
        by_key.setdefault((window.threat, window.camera), []).append(window)

    merged: list[HazardWindow] = []
    for (threat, camera), group in by_key.items():
        for window in sorted(group, key=lambda w: w.start_ms):
            if (
                merged
                and merged[-1].threat == threat
                and merged[-1].camera == camera
                and window.start_ms <= merged[-1].end_ms
            ):
                previous = merged.pop()
                merged.append(
                    HazardWindow(
                        threat=threat,
                        camera=camera,
                        start_ms=previous.start_ms,
                        end_ms=max(previous.end_ms, window.end_ms),
                        note=previous.note or window.note,
                    )
                )
            else:
                merged.append(window)
    return sorted(merged, key=lambda w: (w.camera, w.threat, w.start_ms))


def write_labels(ride_dir: Path | str, windows: list[HazardWindow]) -> Path:
    """Validates everything before writing anything — a half-written labels file
    is worse than none."""
    for window in windows:
        validate_window(window)
    directory = Path(ride_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / LABELS_NAME
    payload = {"windows": [asdict(w) for w in merge_windows(windows)]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def read_labels(ride_dir: Path | str) -> list[HazardWindow]:
    path = Path(ride_dir) / LABELS_NAME
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [HazardWindow(**w) for w in payload.get("windows", [])]
