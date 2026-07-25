"""Keep-until-deleted capture storage for the helmet.

Storage rules mirror the iOS gallery: nothing auto-deletes, captures are refused
when free space runs low, and a recording stops itself at ten minutes.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

#: Matches the iOS recording cap.
MAX_RECORDING_SECONDS = 600


class Gallery:
    def __init__(self, root: str, min_free_mb: int) -> None:
        self.root = root
        self.min_free_mb = min_free_mb
        Path(self.root).mkdir(parents=True, exist_ok=True)
        self._counter = 0

    def has_space(self) -> bool:
        free_mb = shutil.disk_usage(self.root).free / (1024 * 1024)
        return free_mb >= self.min_free_mb

    def new_pair_id(self, now: datetime) -> str:
        """Sortable identifier. A monotonic suffix is appended after the first
        capture in a given second, so two fast captures cannot collide."""
        base = f"pair-{now:%Y%m%d-%H%M%S}"
        self._counter += 1
        return base if self._counter == 1 else f"{base}-{self._counter}"

    def pair_dir(self, pair_id: str) -> Path:
        return Path(self.root) / pair_id

    def write_manifest(self, pair_id: str, front: str | None, rear: str | None, kind: str) -> Path:
        """Write the pair manifest atomically, so a reader never sees a partial
        record if power is cut mid-write."""
        directory = self.pair_dir(pair_id)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": pair_id,
            "kind": kind,
            "front": front,
            "rear": rear,
            "degraded": front is None or rear is None,
        }
        final = directory / "manifest.json"
        temporary = directory / "manifest.json.tmp"
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, final)
        return final

    def list_pairs(self) -> list[dict]:
        pairs: list[dict] = []
        for directory in sorted(Path(self.root).iterdir(), reverse=True):
            manifest = directory / "manifest.json"
            if not directory.is_dir() or not manifest.exists():
                continue
            try:
                pairs.append(json.loads(manifest.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        return pairs
