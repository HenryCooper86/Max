import hashlib
from pathlib import Path

import httpx
import pytest

from max_speech import models
from max_speech.licenses import ModelEntry, RemoteFile
from max_speech.models import ModelDownloadError, ensure_model

BODY = b"model-bytes" * 100
GOOD = hashlib.sha256(BODY).hexdigest()


def url_entry(sha256: str) -> ModelEntry:
    return ModelEntry(
        id="fake",
        kind="tts",
        source="url",
        files=(RemoteFile(url="https://example.com/dir/weights.bin", sha256=sha256),),
        weights_license="MIT",
        code_license="MIT",
        license_url="https://example.com",
        checked="2026-11-20",
        attribution="x",
    )


def make_client(calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=BODY)

    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def test_url_download_verifies_and_renames(tmp_path: Path):
    calls: list[str] = []
    out = ensure_model(url_entry(GOOD), tmp_path, client=make_client(calls))
    assert out == tmp_path / "fake"
    assert (out / "weights.bin").read_bytes() == BODY
    assert not (out / "weights.bin.part").exists()


def test_url_hash_mismatch_deletes_part_and_raises(tmp_path: Path):
    with pytest.raises(ModelDownloadError):
        ensure_model(url_entry("0" * 64), tmp_path, client=make_client([]))
    assert list((tmp_path / "fake").iterdir()) == []


def test_existing_matching_file_is_skipped(tmp_path: Path):
    (tmp_path / "fake").mkdir()
    (tmp_path / "fake" / "weights.bin").write_bytes(BODY)
    calls: list[str] = []
    ensure_model(url_entry(GOOD), tmp_path, client=make_client(calls))
    assert calls == []


def test_existing_corrupt_file_is_redownloaded(tmp_path: Path):
    (tmp_path / "fake").mkdir()
    (tmp_path / "fake" / "weights.bin").write_bytes(b"stale")
    calls: list[str] = []
    ensure_model(url_entry(GOOD), tmp_path, client=make_client(calls))
    assert len(calls) == 1
    assert (tmp_path / "fake" / "weights.bin").read_bytes() == BODY


def test_hf_download_uses_pinned_revision(tmp_path: Path, monkeypatch):
    seen: dict = {}

    def fake_snapshot_download(repo_id, **kwargs):
        seen["repo_id"] = repo_id
        seen.update(kwargs)
        return str(kwargs["local_dir"])

    monkeypatch.setattr(models, "snapshot_download", fake_snapshot_download)
    entry = ModelEntry(
        id="hfm",
        kind="stt",
        source="hf",
        repo="x/y",
        revision="c" * 40,
        weights_license="MIT",
        code_license="MIT",
        license_url="https://example.com",
        checked="2026-11-20",
        attribution="x",
    )
    out = ensure_model(entry, tmp_path)
    assert out == tmp_path / "hfm"
    assert seen["repo_id"] == "x/y"
    assert seen["revision"] == "c" * 40
    assert Path(seen["local_dir"]) == tmp_path / "hfm"


def _hf_entry() -> ModelEntry:
    return ModelEntry(
        id="hfm",
        kind="stt",
        source="hf",
        repo="x/y",
        revision="c" * 40,
        weights_license="MIT",
        code_license="MIT",
        license_url="https://example.com",
        checked="2026-11-20",
        attribution="x",
    )


def test_hf_download_falls_back_to_local_copy_when_offline(tmp_path: Path, monkeypatch):
    calls: list[bool] = []

    def fake_snapshot_download(repo_id, **kwargs):
        offline = kwargs.get("local_files_only", False)
        calls.append(offline)
        if not offline:
            raise OSError("network unreachable")
        return str(kwargs["local_dir"])

    monkeypatch.setattr(models, "snapshot_download", fake_snapshot_download)
    assert ensure_model(_hf_entry(), tmp_path) == tmp_path / "hfm"
    assert calls == [False, True]


def test_hf_download_failure_without_local_copy_raises(tmp_path: Path, monkeypatch):
    def fake_snapshot_download(repo_id, **kwargs):
        raise OSError("network unreachable")

    monkeypatch.setattr(models, "snapshot_download", fake_snapshot_download)
    with pytest.raises(ModelDownloadError, match="network unreachable"):
        ensure_model(_hf_entry(), tmp_path)
