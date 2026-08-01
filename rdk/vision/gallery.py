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
        duration_s: float | None = None,
        fps: float | None = None,
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
        # Absent, not 0, when unknown: reconciled clips have no trustworthy
        # clock, and "unknown" and "instant" must not read the same.
        if duration_s is not None:
            payload["duration_s"] = duration_s
        # The rate the writer *achieved*, not the nominal RECORDING_FPS: the
        # measured pair-20260801-000444-2 wrote at 3.65 fps against 10 nominal,
        # and playing it at the nominal rate compressed an 8.3-minute ride
        # into a 3-minute timelapse. Absent when unknown, same as duration.
        if fps is not None:
            payload["fps"] = fps
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

    def delete_pair(self, pair_id: str) -> str:
        """Remove one capture. Returns "deleted", "unknown", or "recording".

        The unit is the pair directory — deleting one file inside it would
        leave a manifest claiming media that is gone, the broken-tile state
        ``reconcile`` exists to repair. The id comes straight off a URL, so it
        is trusted for nothing: it must resolve to a directory directly under
        the root holding a manifest. "recording" refuses the clip the writer
        is still appending to; ``reconcile`` runs before anything can record,
        so a live flag at runtime can only be the live recording.

        An unreadable manifest still deletes — a crash-damaged capture must be
        removable without SSH.
        """
        root = Path(self.root).resolve()
        try:
            candidate = (root / pair_id).resolve()
        except (OSError, ValueError, RuntimeError):
            return "unknown"
        manifest_path = candidate / "manifest.json"
        if candidate.parent != root or not candidate.is_dir() or not manifest_path.is_file():
            return "unknown"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}
        if manifest.get("recording"):
            return "recording"
        shutil.rmtree(candidate)
        return "deleted"

    def list_pairs(self) -> list[dict]:
        # Newest first by the manifest's mtime, name as the tiebreak — NOT by
        # pair id. The id embeds the clock at capture start, and this board
        # has no RTC: the first seconds after boot run months wrong until NTP
        # steps the clock, so a capture from that window gets a
        # pair-20000101-… id and filed itself at the bottom of the gallery
        # (measured 2026-08-01, on a clip recorded one minute after
        # power-on). NTP lands before the manifest is finalised, so the
        # file's mtime carries the truth the id lost.
        entries: list[tuple[float, str, dict]] = []
        for directory in Path(self.root).iterdir():
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
            try:
                stamp = manifest.stat().st_mtime
            except OSError:  # deleted between exists() and here
                continue
            entries.append((stamp, directory.name, payload))
        # Unique directory names break any mtime tie, so the payload dicts
        # are never compared.
        entries.sort(reverse=True)
        return [payload for _, _, payload in entries]
