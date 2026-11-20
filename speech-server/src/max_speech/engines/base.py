from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
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


# ---- Realtime listening (milestone 2) -------------------------------------------------------------------------
# One conversation owns one stream of each kind; the engines that create them are shared between conversations.
# Audio is 16 kHz mono float32 in [-1, 1] throughout.


class SttStream(Protocol):
    def accept(self, audio: np.ndarray) -> str | None:
        """Feed more audio. Returns the cumulative text of the current utterance when it changed, else None."""
        ...

    def finish(self) -> str:
        """Flush what is buffered and return the final text of the current utterance (may be empty)."""
        ...

    def reset(self) -> None:
        """Start a new utterance. Audio already accepted is discarded."""
        ...


class StreamingSttEngine(Protocol):
    id: str
    model_id: str

    def new_stream(self, *, language: str | None = None, keyterms: tuple[str, ...] = ()) -> SttStream: ...

    def warm_up(self) -> None: ...


class VadStream(Protocol):
    frame_samples: int  # samples per call to `probability`, e.g. 512 at 16 kHz

    def probability(self, frame: np.ndarray) -> float:
        """Speech probability of exactly `frame_samples` samples, given everything this stream has seen."""
        ...

    def reset(self) -> None: ...


class VadEngine(Protocol):
    id: str
    model_id: str

    def new_stream(self) -> VadStream: ...


class TurnDetector(Protocol):
    id: str
    model_id: str

    def turn_complete(self, utterance: np.ndarray) -> float:
        """Probability (0-1) that the speaker has finished, given the utterance so far (latest audio last)."""
        ...

    def warm_up(self) -> None: ...


# ---- Voice cloning (milestone 3) -------------------------------------------------------------------------------


@dataclass
class ReferenceVoice:
    """A custom voice as a cloning engine sees it: what was recorded and what was said in it.

    The store owns the audio and transcript; `cache` is scratch space the engine may fill with its own prepared
    prompt (speaker embedding, codec tokens) so a voice is analysed once, not on every sentence. It is dropped
    when the voice changes, and never persisted by the store.
    """

    id: str
    audio: np.ndarray  # float32 mono in [-1, 1]
    rate: int
    transcript: str
    language: str | None = None
    cache: dict = field(default_factory=dict)


class CloningTtsEngine(Protocol):
    id: str
    model_id: str
    sample_rate: int  # native output rate; callers resample to 24 kHz
    languages: tuple[str, ...]  # primary language tags the model speaks

    def synthesize_cloned(
        self, text: str, reference: ReferenceVoice, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        """Yield float32 mono chunks at `sample_rate` in the reference's voice, first chunk as early as possible."""
        ...

    def warm_up(self) -> None: ...
