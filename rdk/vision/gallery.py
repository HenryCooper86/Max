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
    #: How often a running recording re-checks free space, in frames. At the
    #: RECORDING_FPS of 10 this is every ~5 s. Checking every frame would stat
    #: the filesystem ten times a second for a number that moves slowly.
    SPACE_CHECK_FRAMES = 50

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

    def write_manifest(
        self,
        pair_id: str,
        front: str | None,
        rear: str | None,
        kind: str,
        recording: bool = False,
    ) -> Path:
        """Write the pair manifest atomically, so a reader never sees a partial
        record if power is cut mid-write.

        ``recording`` marks a clip whose writer is still appending. It is written
        at the *start* of a recording, not only at the stop: a manifest that only
        appeared on a clean stop is why an 835 MB clip measured on the board was
        invisible in the gallery — the board lost power mid-ride and nothing ever
        described the file. See ``reconcile``.
        """
        directory = self.pair_dir(pair_id)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": pair_id,
            "kind": kind,
            "front": front,
            "rear": rear,
            "degraded": front is None or rear is None,
            "recording": recording,
        }
        final = directory / "manifest.json"
        temporary = directory / "manifest.json.tmp"
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, final)
        return final

    def reconcile(self) -> list[str]:
        """Repair captures left behind by a crash. Returns the ids repaired.

        Called once at service start, before anything can record, so a manifest
        still flagged ``recording`` can only belong to a process that is gone.

        Three cases, all measured on the board:
        - a manifest flagged ``recording`` — the writer died; present it finished
        - no manifest, or an unreadable one — an older build wrote the manifest
          only on stop, so the media is on disk undescribed; rebuild from disk
        - a directory holding no media at all — a start that never wrote a
          frame. There is no capture in it, so it is removed rather than listed
          as a permanently broken tile.
        """
        repaired: list[str] = []
        for directory in sorted(Path(self.root).iterdir()):
            if not directory.is_dir():
                continue

            manifest_path = directory / "manifest.json"
            existing: dict | None = None
            if manifest_path.exists():
                try:
                    existing = json.loads(manifest_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    existing = None
                if existing is not None and not existing.get("recording"):
                    continue  # already final — leave it exactly as it is

            sides = self._media_on_disk(directory)
            if not sides:
                # Nothing was ever captured here. Remove the directory rather
                # than leave debris that accumulates one entry per crash.
                shutil.rmtree(directory, ignore_errors=True)
                repaired.append(directory.name)
                continue

            kind = "video" if any(name.endswith(".mjpeg") for name in sides.values()) else "photo"
            self.write_manifest(
                directory.name, sides.get("front"), sides.get("rear"), kind, recording=False
            )
            repaired.append(directory.name)
        return repaired

    @staticmethod
    def _media_on_disk(directory: Path) -> dict[str, str]:
        """The capture files actually present, keyed by side.

        Named from disk rather than from the manifest so a side the manifest
        claims but that never landed is dropped — the tile would render broken.
        A zero-byte file counts as never landed.
        """
        found: dict[str, str] = {}
        for side in ("front", "rear"):
            for suffix in (".mjpeg", ".jpg"):
                candidate = directory / f"{side}{suffix}"
                if candidate.exists() and candidate.stat().st_size > 0:
                    found[side] = candidate.name
                    break
        return found

    def list_pairs(self) -> list[dict]:
        pairs: list[dict] = []
        for directory in sorted(Path(self.root).iterdir(), reverse=True):
            manifest = directory / "manifest.json"
            if not directory.is_dir() or not manifest.exists():
                continue
            try:
                payload = json.loads(manifest.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            # Manifests written before the in-progress flag existed describe
            # finished captures; say so rather than leaving the key absent.
            payload.setdefault("recording", False)
            pairs.append(payload)
        return pairs
