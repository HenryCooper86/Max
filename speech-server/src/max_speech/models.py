"""Model downloads. Takes a ModelEntry so nothing is fetched unless it went through the license registry."""

from __future__ import annotations

import hashlib
import shutil
import tarfile
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import httpx
from huggingface_hub import snapshot_download

from max_speech.licenses import ModelEntry, RemoteFile

Progress = Callable[[str, int, int | None], None]


class ModelDownloadError(Exception):
    pass


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _fetch(file: RemoteFile, dest: Path, client: httpx.Client, progress: Progress | None) -> None:
    if dest.exists() and _sha256_of(dest) == file.sha256:
        return
    part = dest.with_name(dest.name + ".part")
    digest = hashlib.sha256()
    try:
        with client.stream("GET", file.url) as response:
            response.raise_for_status()
            total = int(response.headers["content-length"]) if "content-length" in response.headers else None
            done = 0
            with part.open("wb") as f:
                for chunk in response.iter_bytes(1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    done += len(chunk)
                    if progress:
                        progress(dest.name, done, total)
    except httpx.HTTPError as exc:
        part.unlink(missing_ok=True)
        raise ModelDownloadError(f"downloading {file.url} failed: {exc}") from exc
    if digest.hexdigest() != file.sha256:
        part.unlink(missing_ok=True)
        raise ModelDownloadError(
            f"sha256 mismatch for {file.url}: expected {file.sha256}, got {digest.hexdigest()}"
        )
    part.replace(dest)


_MARKER = ".extracted"


def _extract(archive: Path, target: Path, sha256: str) -> None:
    """Unpack a verified tar.bz2 into `target` (filter="data": no absolute paths, "..", links or devices)."""
    try:
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(target, filter="data")
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise ModelDownloadError(f"extracting {archive.name} failed: {exc}") from exc
    finally:
        archive.unlink(missing_ok=True)
    (target / _MARKER).write_text(sha256 + "\n")


def extracted_root(model_dir: Path, marker: str | None = None) -> Path:
    """Where a model's files are: `model_dir` itself when `marker` is a file in it (a flat download), else the
    single top-level directory of an extracted archive (sherpa archives contain exactly one)."""
    if marker is not None and (model_dir / marker).exists():
        return model_dir
    dirs = [p for p in model_dir.iterdir() if p.is_dir()] if model_dir.is_dir() else []
    if len(dirs) != 1 or (marker is not None and not (dirs[0] / marker).exists()):
        raise ModelDownloadError(
            f"expected {'a ' + marker + ' in ' if marker else 'one top-level directory in '}{model_dir}"
            f"{' or its single subdirectory' if marker else f', found {len(dirs)}'}"
        )
    return dirs[0]


def ensure_model(
    entry: ModelEntry,
    models_dir: Path,
    *,
    progress: Progress | None = None,
    client: httpx.Client | None = None,
) -> Path:
    target = models_dir / entry.id
    if entry.source == "hf":
        patterns = {"allow_patterns": list(entry.allow_patterns)} if entry.allow_patterns else {}
        try:
            snapshot_download(entry.repo, revision=entry.revision, local_dir=target, **patterns)
        except Exception as exc:  # noqa: BLE001 - any network or hub failure falls back to the local copy
            # A server that has its models must still start without a network.
            try:
                snapshot_download(
                    entry.repo, revision=entry.revision, local_dir=target, local_files_only=True, **patterns
                )
            except Exception:  # noqa: BLE001
                raise ModelDownloadError(f"downloading {entry.repo}@{entry.revision} failed: {exc}") from exc
        return target

    if entry.archive:
        marker = target / _MARKER
        if marker.is_file() and marker.read_text().strip() == entry.files[0].sha256:
            return target
        # A different (or unfinished) extraction: start clean, or the old root would sit beside the new one.
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    owns_client = client is None
    client = client or httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0))
    try:
        for file in entry.files:
            dest = target / Path(urlparse(file.url).path).name
            _fetch(file, dest, client, progress)
            if entry.archive:
                _extract(dest, target, file.sha256)
    finally:
        if owns_client:
            client.close()
    return target
