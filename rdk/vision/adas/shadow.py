"""The shadow-mode alert log — M2's actual deliverable.

Every alert the pipeline would have fired, with enough context to explain
itself without re-running anything. The ride is over by the time anyone reads
this, so a record that only says "forward_collision at 12:04" is not evidence,
it is a rumour.

Records are appended and flushed one at a time. A ride ends when the bike's
power does, and a buffered writer would lose exactly the tail worth reviewing.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .tuning import Tuning, fingerprint as tuning_fingerprint


@dataclass(frozen=True)
class ShadowRecord:
    threat_id: str
    severity: str
    camera: str
    #: Pipeline time, matching the frame timestamps.
    t_ms: int
    #: Wall clock, for lining a ride up against a transcript.
    wall_ms: int
    ttc_s: float | None

    #: Provenance — which recording, and where in it.
    ride_id: str
    segment: str
    segment_offset_ms: int

    #: The pipeline's own view, so a false alarm can be diagnosed offline.
    track_id: int
    box_height: float
    closing_rate: float | None
    track_frames: int
    ego_moving: bool

    #: Populated only when armed.
    latency_ms: float | None = None

    #: 12-hex fingerprint of the Tuning that produced this record. "" on
    #: records written before fingerprints existed.
    tuning: str = ""


class ShadowLog:
    def __init__(self, path: Path | str, tuning: Tuning | None = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Append, never truncate: a restart mid-ride must not erase the alerts
        # that already fired.
        self._fh = self.path.open("a", encoding="utf-8")
        if tuning is not None:
            header = {
                "shadow_header": 1,
                "fingerprint": tuning_fingerprint(tuning),
                "tuning": asdict(tuning),
            }
            # A restart mid-ride appends a second header. That is a feature:
            # the log then records exactly which constants govern which records.
            self._fh.write(json.dumps(header, ensure_ascii=False) + "\n")
            self._fh.flush()

    def append(self, record: ShadowRecord) -> None:
        # ensure_ascii=False so the Chinese labels stay readable — a person
        # reads these when deciding whether the audio may be armed.
        self._fh.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> "ShadowLog":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def read_shadow(path: Path | str) -> list[ShadowRecord]:
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        return []
    records = []
    for line in text.split("\n"):
        data = json.loads(line)
        if "shadow_header" in data:
            continue
        records.append(ShadowRecord(**data))
    return records


def read_tuning(path: Path | str) -> list[dict]:
    """The header lines, in order. Empty for pre-fingerprint logs."""
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        return []
    return [json.loads(line) for line in text.split("\n") if '"shadow_header"' in line]
