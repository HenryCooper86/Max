"""Per-frame metadata sidecar.

One JSONL file per video segment. Every record is flushed as it is written:
a ride ends when the bike's power does, and a buffered writer would lose the
tail of exactly the clip we most wanted.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class FrameMeta:
    frame_index: int
    #: Monotonic capture time. Used for inter-frame deltas; immune to clock steps.
    mono_ns: int
    #: Wall-clock milliseconds. Used to align a clip with a ride log.
    wall_ms: int
    camera: str


class MetadataWriter:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("w", encoding="utf-8")

    def append(self, meta: FrameMeta) -> None:
        self._fh.write(json.dumps(asdict(meta), ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> "MetadataWriter":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def read_metadata(path: Path | str) -> list[FrameMeta]:
    """Read a sidecar. A torn final line — the signature of a power cut — is
    dropped rather than raised, so one bad ride does not poison the corpus."""
    file_path = Path(path)
    if not file_path.exists():
        return []
    out: list[FrameMeta] = []
    for line in file_path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(FrameMeta(**json.loads(line)))
        except (json.JSONDecodeError, TypeError):
            continue
    return out
