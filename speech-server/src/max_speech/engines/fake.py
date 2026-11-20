"""Test doubles. They are not models, so they skip the license registry on purpose."""

from __future__ import annotations

from collections.abc import Iterator
from typing import ClassVar

import numpy as np

from max_speech.chunker import split_sentences
from max_speech.engines.base import Transcript, UnknownVoiceError, VoiceInfo

_UNIT_S = 0.1


def _is_cjk(ch: str) -> bool:
    return "㐀" <= ch <= "鿿"


def _units(sentence: str) -> int:
    # One unit per CJK character and one per run of other text in a whitespace-separated word.
    total = 0
    for word in sentence.split():
        total += sum(_is_cjk(ch) for ch in word)
        if any(not _is_cjk(ch) and ch.isalnum() for ch in word):
            total += 1
    return total


class FakeTts:
    id = "fake"
    model_id = "fake-tts"
    sample_rate = 22050

    _VOICES: ClassVar[list[VoiceInfo]] = [
        VoiceInfo("alpha", "Alpha", ("en",), "female"),
        VoiceInfo("bravo", "Bravo", ("zh",), "male"),
    ]

    def voices(self) -> list[VoiceInfo]:
        return list(self._VOICES)

    def default_voice(self, gender: str = "female", language: str | None = None) -> str:
        for v in self._VOICES:
            if v.gender == gender and (language is None or language in v.languages):
                return v.id
        for v in self._VOICES:
            if language is not None and language in v.languages:
                return v.id
        return self._VOICES[0].id

    def synthesize(
        self, text: str, voice: str, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        if voice not in {v.id for v in self._VOICES}:
            raise UnknownVoiceError(voice)
        for sentence in split_sentences(text):
            n = round(_units(sentence) * _UNIT_S * self.sample_rate)
            if n == 0:
                continue
            t = np.arange(n, dtype=np.float32) / self.sample_rate
            yield (0.3 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)

    def warm_up(self) -> None:
        pass


class FakeStt:
    id = "fake"
    model_id = "fake-stt"

    def transcribe(
        self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None
    ) -> Transcript:
        duration = len(audio) / rate
        text = prompt if prompt == "echo" else f"heard {duration:.1f}s"
        return Transcript(text=text, language=language, duration_s=duration)

    def warm_up(self) -> None:
        pass
