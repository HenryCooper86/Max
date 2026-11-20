"""Test double for a design engine: a tone whose pitch depends on the description and the seed."""

from __future__ import annotations

import hashlib

import numpy as np


class FakeDesignEngine:
    id = "fake-design"
    model_id = "fake-design-tts"
    sample_rate = 24000
    languages = ("en", "zh")

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, int]] = []  # (description, text, language, seed)
        self.closed = False
        self.loads = 0

    def ensure_loaded(self) -> None:
        self.loads += 1

    def design(self, description: str, text: str, language: str, seed: int) -> np.ndarray:
        self.calls.append((description, text, language, seed))
        pitch = 120.0 + int(hashlib.sha256(f"{description}/{seed}".encode()).hexdigest()[:4], 16) % 200
        n = int(4.0 * self.sample_rate)
        t = np.arange(n, dtype=np.float32) / self.sample_rate
        return (0.3 * np.sin(2 * np.pi * pitch * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))).astype(
            np.float32
        )

    def close(self) -> None:
        self.closed = True
