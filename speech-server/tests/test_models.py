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


# ---- archives and allow_patterns ----------------------------------------------------------------------------


def _tar_bz2(members: dict[str, bytes]) -> bytes:
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def archive_entry(body: bytes) -> ModelEntry:
    return ModelEntry(
        id="arch",
        kind="stt",
        source="url",
        files=(
            RemoteFile(url="https://example.com/dl/pack.tar.bz2", sha256=hashlib.sha256(body).hexdigest()),
        ),
        archive="tar.bz2",
        weights_license="MIT",
        code_license="MIT",
        license_url="https://example.com",
        checked="2026-11-20",
        attribution="x",
    )


def client_for(body: bytes, calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def test_archive_is_verified_extracted_and_deleted(tmp_path: Path):
    body = _tar_bz2({"pack-1/tokens.txt": b"a", "pack-1/model.onnx": b"bb"})
    entry = archive_entry(body)
    out = ensure_model(entry, tmp_path, client=client_for(body, []))
    assert out == tmp_path / "arch"
    assert (out / "pack-1" / "model.onnx").read_bytes() == b"bb"
    assert not (out / "pack.tar.bz2").exists()
    assert (out / ".extracted").read_text().strip() == entry.files[0].sha256
    assert models.extracted_root(out) == out / "pack-1"


def test_matching_marker_skips_the_download(tmp_path: Path):
    body = _tar_bz2({"pack-1/tokens.txt": b"a"})
    entry = archive_entry(body)
    ensure_model(entry, tmp_path, client=client_for(body, []))
    calls: list[str] = []
    ensure_model(entry, tmp_path, client=client_for(body, calls))
    assert calls == []


def test_stale_marker_re_extracts(tmp_path: Path):
    body = _tar_bz2({"pack-1/tokens.txt": b"a"})
    (tmp_path / "arch").mkdir()
    (tmp_path / "arch" / ".extracted").write_text("0" * 64)
    calls: list[str] = []
    ensure_model(archive_entry(body), tmp_path, client=client_for(body, calls))
    assert len(calls) == 1
    assert (tmp_path / "arch" / "pack-1" / "tokens.txt").exists()


def test_a_changed_archive_replaces_the_old_extraction(tmp_path: Path):
    old = archive_entry(_tar_bz2({"old-pack/tokens.txt": b"a"}))
    ensure_model(old, tmp_path, client=client_for(_tar_bz2({"old-pack/tokens.txt": b"a"}), []))
    assert (tmp_path / "arch" / "old-pack").is_dir()
    body = _tar_bz2({"new-pack/tokens.txt": b"b"})
    out = ensure_model(archive_entry(body), tmp_path, client=client_for(body, []))
    assert not (out / "old-pack").exists()
    assert models.extracted_root(out) == out / "new-pack"


def test_extracted_root_accepts_a_flat_dir_with_the_marker_file(tmp_path: Path):
    (tmp_path / "tokens.txt").write_text("x")
    assert models.extracted_root(tmp_path, "tokens.txt") == tmp_path
    (tmp_path / "tokens.txt").unlink()
    with pytest.raises(ModelDownloadError, match="tokens.txt"):
        models.extracted_root(tmp_path, "tokens.txt")


def test_archive_hash_mismatch_raises_and_extracts_nothing(tmp_path: Path):
    body = _tar_bz2({"pack-1/tokens.txt": b"a"})
    entry = archive_entry(body)
    with pytest.raises(ModelDownloadError, match="sha256"):
        ensure_model(entry, tmp_path, client=client_for(b"tampered", []))
    assert not (tmp_path / "arch" / ".extracted").exists()
    assert not (tmp_path / "arch" / "pack-1").exists()


@pytest.mark.parametrize("name", ["../evil.txt", "pack-1/../../evil.txt"])
def test_traversal_member_is_rejected(tmp_path: Path, name: str):
    body = _tar_bz2({name: b"x"})
    with pytest.raises(ModelDownloadError):
        ensure_model(archive_entry(body), tmp_path, client=client_for(body, []))
    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path / "arch" / ".extracted").exists()


def test_absolute_member_is_kept_inside_the_model_dir(tmp_path: Path):
    # filter="data" strips the leading slash, so the file cannot land outside the target.
    body = _tar_bz2({"/abs-evil/x.txt": b"x"})
    out = ensure_model(archive_entry(body), tmp_path, client=client_for(body, []))
    assert (out / "abs-evil" / "x.txt").read_bytes() == b"x"
    assert not Path("/abs-evil").exists()


def test_link_member_is_rejected(tmp_path: Path):
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        info = tarfile.TarInfo("pack-1/link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        tar.addfile(info)
    body = buf.getvalue()
    with pytest.raises(ModelDownloadError):
        ensure_model(archive_entry(body), tmp_path, client=client_for(body, []))


def test_extracted_root_needs_exactly_one_directory(tmp_path: Path):
    (tmp_path / ".extracted").write_text("x")
    with pytest.raises(ModelDownloadError):
        models.extracted_root(tmp_path)
    (tmp_path / "a").mkdir()
    assert models.extracted_root(tmp_path) == tmp_path / "a"
    (tmp_path / "b").mkdir()
    with pytest.raises(ModelDownloadError):
        models.extracted_root(tmp_path)


def test_hf_allow_patterns_are_passed(tmp_path: Path, monkeypatch):
    seen: dict = {}

    def fake_snapshot_download(repo_id, **kwargs):
        seen.update(kwargs)
        return str(kwargs["local_dir"])

    monkeypatch.setattr(models, "snapshot_download", fake_snapshot_download)
    import dataclasses

    entry = dataclasses.replace(_hf_entry(), allow_patterns=("a.onnx", "tokens.txt"))
    ensure_model(entry, tmp_path)
    assert seen["allow_patterns"] == ["a.onnx", "tokens.txt"]
    seen.clear()
    ensure_model(_hf_entry(), tmp_path)
    assert seen.get("allow_patterns") is None
