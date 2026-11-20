"""Sentence chunking for TTS.

One decision function serves both the batch and the streaming API. While streaming, any break whose
outcome depends on characters that have not arrived yet (the text after "Dr.", the rest of
"example.com", what follows an ellipsis) is held back, so streaming and batch give the same chunks.
"""

from __future__ import annotations

import re

_HARD = "。！？；!?;"
_ABBREVIATIONS = frozenset(
    ("mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc")
    + ("e.g", "i.e", "a.m", "p.m", "fig", "approx", "inc", "ltd", "co")
)
_OPENERS = "\"'([{“‘"


def _is_cjk(ch: str) -> bool:
    return "぀" <= ch <= "ヿ" or "㐀" <= ch <= "鿿" or "豈" <= ch <= "﫿"


def _token_before(buf: str, i: int) -> str:
    start = i
    while start > 0 and not buf[start - 1].isspace():
        start -= 1
    return buf[start:i].lstrip(_OPENERS)


def _next_break(buf: str, final: bool) -> int | None:
    """End index of the first sentence in buf, or None when it is not decided yet."""
    n = len(buf)
    i = 0
    while i < n:
        c = buf[i]
        if c == "\n":
            return i + 1
        if c in _HARD:
            j = i + 1
            while j < n and buf[j] in _HARD:  # "?!" belongs to one sentence
                j += 1
            if j == n:
                return n if final else None
            # An ASCII "?" or ";" glued to a URL ("x?y=1") is part of the URL, not a break.
            if c in "?;" and not buf[j].isspace() and any(m in _token_before(buf, i) for m in "/@"):
                i = j
                continue
            return j
        if c in ".…":
            j = i
            while j < n and buf[j] in ".…":
                j += 1
            ellipsis = c == "…" or j - i > 1
            if j == n:
                return n if final else None
            if not buf[j].isspace():
                i = j  # "3.5", "example.com", "a.b@c.d"
                continue
            if ellipsis:
                k = j
                while k < n and buf[k].isspace():
                    k += 1
                if k == n:
                    return n if final else None
                if buf[k].isupper() or _is_cjk(buf[k]):
                    return j
                i = j
                continue
            token = _token_before(buf, i)
            if token.lower() == "no":
                # "No. 5" is an abbreviation but "I said no." is a sentence end; only the next word tells.
                k = j
                while k < n and buf[k].isspace():
                    k += 1
                if k == n:
                    return n if final else None
                if buf[k].isdigit():
                    i = j
                    continue
                return j
            if token.lower() in _ABBREVIATIONS or (len(token) == 1 and token.isupper()):
                i = j
                continue
            return j
        i += 1
    return n if final and n else None


_COMMA_LIKE = ",，、:：—"
_ENDERS = ".…!?;。！？；"
_TOKEN = re.compile(r"\S+")


def _comma_ok(text: str, max_words: int, max_chars: int) -> bool:
    """3+ Latin words or 4+ CJK characters before the comma, but no more than the limits.

    Past the limits the word/char-limit cut takes over; allowing the comma there too would make the
    streaming decision (the comma arrives first) differ from the whole-text one.
    """
    cjk = sum(_is_cjk(c) for c in text)
    words = sum(1 for t in text.split() if not all(_is_cjk(c) for c in t))
    return (words >= 3 or cjk >= 4) and words <= max_words and cjk <= max_chars


def _comma_cut(buf: str, start: int, stop: int, max_words: int, max_chars: int) -> int | None:
    for i in range(start, stop):
        ch = buf[i]
        if ch not in _COMMA_LIKE or not _comma_ok(buf[start:i], max_words, max_chars):
            continue
        if ch in ",:":
            # "1,000", "12:30", "https://x", "a,b": only a break when whitespace follows.
            if i + 1 >= len(buf):
                return None  # undecided until the next character arrives
            if not buf[i + 1].isspace():
                continue
        elif ch == "—" and i > start and buf[i - 1].isdigit():
            if i + 1 >= len(buf):
                return None
            if buf[i + 1].isdigit():  # "2020—2021"
                continue
        return i + 1
    return None


def _word_limit_cut(buf: str, start: int, stop: int, max_words: int) -> int | None:
    """Cut after max_words Latin words, only when at least two more words follow."""
    if max_words < 1:
        return None
    toks = list(_TOKEN.finditer(buf, start, stop))
    for k, m in enumerate(toks[: max_words + 1]):
        if any(_is_cjk(c) for c in m.group()):
            return None
        if k == max_words:
            last = toks[k - 1].group()
            if len(toks) < max_words + 2 or last[-1] in _ENDERS:
                return None
            return toks[k - 1].end()
    return None


def _char_limit_cut(buf: str, start: int, stop: int, max_chars: int) -> int | None:
    """Cut after max_chars CJK characters, only when two more CJK characters follow directly."""
    if max_chars < 1:
        return None
    pos = [i for i in range(start, stop) if _is_cjk(buf[i])]
    if len(pos) < max_chars + 2:
        return None
    cut = pos[max_chars - 1] + 1
    return cut if pos[max_chars] == cut else None


def _early_cut(buf: str, end: int | None, max_words: int, max_chars: int) -> int | None:
    """Where the first chunk may be cut before the sentence ends (end), or None."""
    stop = len(buf) if end is None else end
    start = len(buf) - len(buf.lstrip())
    if start >= stop:
        return None
    cuts = (
        _comma_cut(buf, start, stop, max_words, max_chars),
        _word_limit_cut(buf, start, stop, max_words),
        _char_limit_cut(buf, start, stop, max_chars),
    )
    found = [c for c in cuts if c is not None]
    return min(found) if found else None


def _drain(buf: str, final: bool, early: tuple[int, int] | None = None) -> tuple[list[str], str, bool]:
    """Split buf into chunks; early=(max_words, max_chars) enables the early cut for the first piece.

    Returns (chunks, rest, early_still_pending).
    """
    out: list[str] = []
    while buf:
        end = _next_break(buf, final)
        if early is not None:
            cut = _early_cut(buf, end, *early)
            if cut is not None:
                end = cut
        if end is None:
            break
        piece = buf[:end].strip()
        if piece:
            out.append(piece)
            early = None
        buf = buf[end:]
    return out, buf, early is not None


def split_sentences(text: str) -> list[str]:
    return _drain(text, True)[0]


class SentenceChunker:
    def __init__(
        self,
        early_first_chunk: bool = False,
        first_chunk_max_words: int = 6,
        first_chunk_max_chars: int = 10,
    ) -> None:
        self._buf = ""
        self._early_enabled = early_first_chunk
        self._limits = (first_chunk_max_words, first_chunk_max_chars)
        self._first = True

    def _drain(self, final: bool) -> list[str]:
        early = self._limits if self._early_enabled and self._first else None
        out, self._buf, self._first = _drain(self._buf, final, early)
        return out

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        return self._drain(False)

    def flush(self) -> list[str]:
        return self._drain(True)

    def reset(self) -> None:
        """Start a new reply: drop any buffered text; the next chunk is a first chunk again."""
        self._buf = ""
        self._first = True
