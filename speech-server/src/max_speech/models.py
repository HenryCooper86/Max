"""Model downloads. Takes a ModelEntry so nothing is fetched unless it went through the license registry."""

from __future__ import annotations

import hashlib
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


def ensure_model(
    entry: ModelEntry,
    models_dir: Path,
    *,
    progress: Progress | None = None,
    client: httpx.Client | None = None,
) -> Path:
    target = models_dir / entry.id
    if entry.source == "hf":
        try:
            snapshot_download(entry.repo, revision=entry.revision, local_dir=target)
        except Exception as exc:  # noqa: BLE001 - any network or hub failure falls back to the local copy
            # A server that has its models must still start without a network.
            try:
                snapshot_download(
                    entry.repo, revision=entry.revision, local_dir=target, local_files_only=True
                )
            except Exception:  # noqa: BLE001
                raise ModelDownloadError(f"downloading {entry.repo}@{entry.revision} failed: {exc}") from exc
        return target

    target.mkdir(parents=True, exist_ok=True)
    owns_client = client is None
    client = client or httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0))
    try:
        for file in entry.files:
            _fetch(file, target / Path(urlparse(file.url).path).name, client, progress)
    finally:
        if owns_client:
            client.close()
    return target
