"""Designed-voice candidates kept in memory until the admin picks one or they expire."""

from __future__ import annotations

import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

CID_RE = re.compile(r"^c_[0-9a-f]{12}$")
TTL_SECONDS = 15 * 60
MAX_CANDIDATES = 30


@dataclass(frozen=True)
class Candidate:
    id: str
    audio: np.ndarray  # 24 kHz mono float32
    rate: int
    text: str
    description: str
    language: str
    seed: int
    model: str
    expires_at: float  # on the cache's clock


def expires_iso(seconds_from_now: float) -> str:
    """A wall-clock timestamp for the response; the cache itself runs on its own (monotonic) clock."""
    when = datetime.fromtimestamp(time.time() + seconds_from_now, UTC)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


class CandidateCache:
    """At most `limit` candidates, each alive for `ttl` seconds; the oldest is evicted to make room."""

    def __init__(
        self,
        *,
        ttl: float = TTL_SECONDS,
        limit: int = MAX_CANDIDATES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ttl = ttl
        self.limit = limit
        self._clock = clock
        self._lock = threading.Lock()
        self._items: OrderedDict[str, Candidate] = OrderedDict()

    def _purge(self) -> None:
        now = self._clock()
        for cid in [c for c, item in self._items.items() if item.expires_at <= now]:
            del self._items[cid]

    def add(
        self,
        *,
        audio: np.ndarray,
        rate: int,
        text: str,
        description: str,
        language: str,
        seed: int,
        model: str,
    ) -> Candidate:
        with self._lock:
            self._purge()
            cid = next(i for i in (f"c_{secrets.token_hex(6)}" for _ in range(100)) if i not in self._items)
            item = Candidate(
                cid, audio, rate, text, description, language, seed, model, self._clock() + self.ttl
            )
            self._items[cid] = item
            while len(self._items) > self.limit:
                self._items.popitem(last=False)  # insertion order: the oldest goes first
            return item

    def get(self, cid: str) -> Candidate | None:
        if not isinstance(cid, str) or not CID_RE.fullmatch(cid):
            return None
        with self._lock:
            self._purge()
            return self._items.get(cid)

    def take(self, cid: str) -> Candidate | None:
        """Remove and return a candidate (it is consumed by saving); None when unknown or expired. Atomic, so two
        concurrent saves cannot both get it."""
        if not isinstance(cid, str) or not CID_RE.fullmatch(cid):
            return None
        with self._lock:
            self._purge()
            return self._items.pop(cid, None)

    def restore(self, item: Candidate) -> None:
        """Put back a candidate taken by `take` when saving it failed, keeping its original expiry."""
        with self._lock:
            self._purge()
            self._items[item.id] = item

    def __len__(self) -> int:
        with self._lock:
            self._purge()
            return len(self._items)
