from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal, Protocol

import numpy as np


@dataclass(frozen=True)
class VoiceInfo:
    id: str  # what clients send as `voice`
    name: str
    languages: tuple[str, ...]  # BCP-47 primary tags, e.g. ("en",) or ("zh",)
    gender: Literal["female", "male", "neutral"]


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str | None
    duration_s: float
    segments: tuple[tuple[float, float, str], ...] = ()  # (start, end, text) for verbose_json


class UnknownVoiceError(ValueError):
    pass


class TtsEngine(Protocol):
    id: str  # engine id, e.g. "kokoro"
    model_id: str  # registry id, e.g. "kokoro-v1.0"
    sample_rate: int  # native rate; callers resample to 24 kHz

    def voices(self) -> list[VoiceInfo]: ...

    def default_voice(self, gender: str = "female", language: str | None = None) -> str: ...

    def synthesize(
        self, text: str, voice: str, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        """Yield float32 mono chunks at `sample_rate`; raise UnknownVoiceError for an unknown voice."""
        ...

    def warm_up(self) -> None: ...


class SttEngine(Protocol):
    id: str
    model_id: str

    def transcribe(
        self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None
    ) -> Transcript: ...

    def warm_up(self) -> None: ...
