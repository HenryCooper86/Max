"""Sentence chunking for TTS.

One decision function serves both the batch and the streaming API. While streaming, any break whose
outcome depends on characters that have not arrived yet (the text after "Dr.", the rest of
"example.com", what follows an ellipsis) is held back, so streaming and batch give the same chunks.
"""

from __future__ import annotations

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


def _drain(buf: str, final: bool) -> tuple[list[str], str]:
    out: list[str] = []
    while buf:
        end = _next_break(buf, final)
        if end is None:
            break
        piece = buf[:end].strip()
        if piece:
            out.append(piece)
        buf = buf[end:]
    return out, buf


def split_sentences(text: str) -> list[str]:
    return _drain(text, True)[0]


class SentenceChunker:
    def __init__(self) -> None:
        self._buf = ""

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        out, self._buf = _drain(self._buf, False)
        return out

    def flush(self) -> list[str]:
        out, self._buf = _drain(self._buf, True)
        return out
