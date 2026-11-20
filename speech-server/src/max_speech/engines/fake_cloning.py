"""Test double for a cloning engine: deterministic audio whose pitch depends on the reference voice."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import numpy as np

from max_speech.chunker import split_sentences
from max_speech.engines.base import ReferenceVoice
from max_speech.engines.fake import _UNIT_S, _units


def pitch_for(voice_id: str) -> float:
    return 200.0 + int(hashlib.sha256(voice_id.encode()).hexdigest()[:4], 16) % 400


class FakeCloningTts:
    id = "fake-cloning"
    model_id = "fake-cloning-tts"
    sample_rate = 16000  # differs from FakeTts, so tests exercise the router's resampling
    languages = ("en", "zh")

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []  # (text, reference id, language)
        self.analyses = 0  # how many times a reference was "analysed" (cache misses)

    def synthesize_cloned(
        self, text: str, reference: ReferenceVoice, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        self.calls.append((text, reference.id, language))
        if "pitch" not in reference.cache:
            self.analyses += 1
            reference.cache["pitch"] = pitch_for(reference.id)
        pitch = reference.cache["pitch"]
        for sentence in split_sentences(text):
            n = round(_units(sentence) * _UNIT_S * self.sample_rate)
            if n == 0:
                continue
            t = np.arange(n, dtype=np.float32) / self.sample_rate
            yield (0.3 * np.sin(2 * np.pi * pitch * t)).astype(np.float32)

    def warm_up(self) -> None:
        pass
