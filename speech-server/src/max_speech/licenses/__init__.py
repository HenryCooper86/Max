"""License registry: the gate every model passes before it is downloaded or loaded."""

from __future__ import annotations

import importlib.resources
import re
import tomllib
from dataclasses import dataclass
from datetime import date

ALLOWED_WEIGHTS_LICENSES = frozenset(
    {"Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-4.0", "CC0-1.0"}
)
KINDS = ("stt", "tts", "vad", "turn")
SOURCES = ("hf", "url")

_SHA1 = re.compile(r"[0-9a-f]{40}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


class RegistryError(ValueError):
    pass


class LicenseError(Exception):
    pass


@dataclass(frozen=True)
class RemoteFile:
    url: str
    sha256: str


@dataclass(frozen=True)
class ModelEntry:
    id: str
    kind: str
    source: str
    weights_license: str
    code_license: str
    license_url: str
    checked: str
    attribution: str
    files: tuple[RemoteFile, ...] = ()
    repo: str | None = None
    revision: str | None = None
    runtime_licenses: tuple[str, ...] = ()
    note: str | None = None


def _parse(model_id: str, raw: dict) -> ModelEntry:
    def fail(field: str, why: str) -> RegistryError:
        return RegistryError(f"model {model_id!r}: field {field!r} {why}")

    def text(field: str) -> str:
        value = raw.get(field)
        if not isinstance(value, str) or not value:
            raise fail(field, "is required")
        return value

    kind = text("kind")
    if kind not in KINDS:
        raise fail("kind", f"must be one of {', '.join(KINDS)}")
    source = text("source")
    if source not in SOURCES:
        raise fail("source", "must be 'hf' or 'url'")

    checked = text("checked")
    try:
        date.fromisoformat(checked)
    except ValueError:
        raise fail("checked", "must be an ISO date (YYYY-MM-DD)") from None

    repo = revision = None
    files: tuple[RemoteFile, ...] = ()
    if source == "hf":
        repo = text("repo")
        revision = text("revision")
        if not _SHA1.fullmatch(revision):
            raise fail("revision", "must be a 40-character lowercase hex commit sha")
    else:
        raw_files = raw.get("files")
        if not isinstance(raw_files, list) or not raw_files:
            raise fail("files", "must list at least one file for a url source")
        parsed = []
        for item in raw_files:
            url, digest = item.get("url"), item.get("sha256")
            if not isinstance(url, str) or not url:
                raise fail("files", "entries need a url")
            if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
                raise fail("sha256", f"must be 64 lowercase hex characters (file {url})")
            parsed.append(RemoteFile(url=url, sha256=digest))
        files = tuple(parsed)

    return ModelEntry(
        id=model_id,
        kind=kind,
        source=source,
        weights_license=text("weights_license"),
        code_license=text("code_license"),
        license_url=text("license_url"),
        checked=checked,
        attribution=text("attribution"),
        files=files,
        repo=repo,
        revision=revision,
        runtime_licenses=tuple(raw.get("runtime_licenses", ())),
        note=raw.get("note"),
    )


def load_registry(text: str | None = None) -> dict[str, ModelEntry]:
    if text is None:
        text = (importlib.resources.files(__package__) / "registry.toml").read_text(encoding="utf-8")
    data = tomllib.loads(text)
    return {model_id: _parse(model_id, raw) for model_id, raw in data.get("models", {}).items()}


def require(model_id: str, kind: str, *, registry: dict[str, ModelEntry] | None = None) -> ModelEntry:
    """Return the entry only if it is registered, of the right kind, and has an allowed weights license."""
    registry = load_registry() if registry is None else registry
    entry = registry.get(model_id)
    if entry is None:
        raise LicenseError(
            f"{model_id} is not in the license registry; add it to licenses/registry.toml after reading its license"
        )
    if entry.kind != kind:
        raise LicenseError(f"{model_id} is a {entry.kind} model, not a {kind} model")
    if entry.weights_license not in ALLOWED_WEIGHTS_LICENSES:
        raise LicenseError(
            f"{model_id} has weights license {entry.weights_license}, which is not allowed; "
            f"allowed: {', '.join(sorted(ALLOWED_WEIGHTS_LICENSES))}"
        )
    return entry
