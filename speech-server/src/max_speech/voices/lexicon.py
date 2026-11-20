"""Pronunciation lexicon: text replacements applied before synthesis ("Dr" -> "Doctor", "GIF" -> "jiff")."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
from pathlib import Path

log = logging.getLogger(__name__)

MAX_ENTRIES = 500
MAX_KEY_CHARS = 64
MAX_VALUE_CHARS = 128

# Alphanumerics (any script) minus underscore and minus CJK (Han, kana, hangul, CJK punctuation), which has no
# word boundaries, so a Latin key matches next to it ("我喜欢GIF图片"). Hyphens and apostrophes join words too.
_CJK_CLASS = "\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\U00020000-\U0002ffff"
_WORD = rf"[^\W_{_CJK_CLASS}]"
_BEFORE = rf"(?<!{_WORD})(?<!-)(?<!{_WORD}')"
_AFTER = rf"(?!{_WORD})(?!-)(?!'{_WORD})"


class LexiconError(ValueError):
    pass


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x2E80 <= cp <= 0x9FFF  # radicals, kana, CJK symbols, unified ideographs
        or 0xAC00 <= cp <= 0xD7AF  # hangul syllables
        or 0xF900 <= cp <= 0xFAFF
        or 0xFF00 <= cp <= 0xFFEF
        or 0x20000 <= cp <= 0x2FFFF
    )


def _validate(entries: object) -> dict[str, str]:
    if not isinstance(entries, dict):
        raise LexiconError("entries must be an object of text to replacement")
    if len(entries) > MAX_ENTRIES:
        raise LexiconError(f"at most {MAX_ENTRIES} entries are allowed")
    clean: dict[str, str] = {}
    seen: set[str] = set()
    for key, value in entries.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise LexiconError("keys and values must be strings")
        if not key or key != key.strip():
            raise LexiconError("keys must be non-empty and have no leading or trailing spaces")
        if len(key) > MAX_KEY_CHARS:
            raise LexiconError(f"keys must be at most {MAX_KEY_CHARS} characters")
        if len(value) > MAX_VALUE_CHARS:
            raise LexiconError(f"values must be at most {MAX_VALUE_CHARS} characters")
        if any(ord(c) < 32 or ord(c) == 127 for c in key + value):
            raise LexiconError("keys and values must not contain control characters")
        folded = key.lower()
        if folded in seen:
            raise LexiconError(f"key '{key}' appears twice (keys are case-insensitive)")
        seen.add(folded)
        clean[key] = value
    return clean


def _compile(entries: dict[str, str]) -> tuple[re.Pattern | None, dict[str, str]]:
    if not entries:
        return None, {}
    alternatives = []
    lookup = {}
    for key in sorted(entries, key=lambda k: (-len(k), k)):  # longest first, so "Dr." beats "Dr"
        lookup[key.lower()] = entries[key]
        body = re.escape(key)
        if any(_is_cjk(c) for c in key):
            alternatives.append(body)  # CJK has no word boundaries: match inside text
        else:
            alternatives.append(f"{_BEFORE}{body}{_AFTER}")
    return re.compile("|".join(f"(?:{a})" for a in alternatives), re.IGNORECASE), lookup


class Lexicon:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._entries: dict[str, str] = {}
        self._compiled: tuple[re.Pattern | None, dict[str, str]] = (None, {})
        if path is not None and path.is_file():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                self._set(_validate(raw.get("entries", {})))
            except (OSError, ValueError, AttributeError):
                log.warning("ignoring unreadable lexicon %s", path, exc_info=True)

    def _set(self, entries: dict[str, str]) -> None:
        self._compiled = _compile(entries)  # swapped in one assignment, so apply() never sees a half state
        self._entries = entries

    @property
    def entries(self) -> dict[str, str]:
        return dict(self._entries)

    def replace(self, entries: object) -> dict[str, str]:
        """Validate, persist (atomically) and activate a whole new lexicon."""
        clean = _validate(entries)
        with self._lock:
            if self.path is not None:
                self._write(clean)
            self._set(clean)
        return dict(clean)

    def _write(self, entries: dict[str, str]) -> None:
        assert self.path is not None
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.path.with_name(f".{self.path.name}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(json.dumps({"entries": entries}, ensure_ascii=False, indent=2).encode("utf-8"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def apply(self, text: str) -> str:
        pattern, lookup = self._compiled
        if pattern is None:
            return text
        return pattern.sub(lambda m: lookup.get(m.group(0).lower(), m.group(0)), text)
