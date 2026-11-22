"""One TTS engine that serves both the preset voices and the custom (cloned) ones."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np

from max_speech.audio import DownResampler, resample
from max_speech.chunker import split_sentences
from max_speech.engines.base import CloningTtsEngine, TtsEngine, UnknownVoiceError, VoiceInfo
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore, is_custom_id


def speakable(text: str) -> bool:
    """False for emoji-only, punctuation-only or blank text, which no engine can say."""
    return any(c.isalnum() for c in text)


def speech_engine_id(tts: TtsEngine, voice: str) -> str:
    """The engine that speaks `voice`, for the X-Max-Speech-Engine header: `tts.id` is always the preset's."""
    if isinstance(tts, VoiceRouter) and tts.cloning is not None and is_custom_id(voice):
        return tts.cloning.id
    return tts.id


class VoiceRouter:
    """Implements `TtsEngine`, so every caller of `slots.tts` works unchanged.

    `id`, `model_id` and `sample_rate` follow the preset engine; cloned audio is resampled to its rate.
    """

    def __init__(
        self, preset: TtsEngine, cloning: CloningTtsEngine | None, store: VoiceStore, lexicon: Lexicon
    ) -> None:
        self.preset = preset
        self.cloning = cloning
        self.store = store
        self.lexicon = lexicon

    @property
    def id(self) -> str:
        return self.preset.id

    @property
    def model_id(self) -> str:
        return self.preset.model_id

    @property
    def sample_rate(self) -> int:
        return self.preset.sample_rate

    def __getattr__(self, name: str):
        # Anything else an engine may carry (extra_model_ids, ...) is the preset's.
        if name == "preset":
            raise AttributeError(name)
        return getattr(self.preset, name)

    def voices(self) -> list[VoiceInfo]:
        out = list(self.preset.voices())
        if self.cloning is not None:
            out.extend(VoiceInfo(v.id, v.name, v.languages, v.gender) for v in self.store.list())  # type: ignore[arg-type]
        return out

    def default_voice(self, gender: str = "female", language: str | None = None) -> str:
        return self.preset.default_voice(gender, language)

    def sentences(self, text: str) -> list[str]:
        """What `synthesize` speaks, in order: the lexicon applied, then split, unspeakable pieces dropped."""
        return [s for s in split_sentences(self.lexicon.apply(text)) if speakable(s)]

    def down_resampler(self, voice: str) -> DownResampler | None:
        """A resampler to share across several `synthesize` calls for `voice` (see `resampler`), or None if its audio
        needs no streaming downsampling."""
        if self.cloning is None or not is_custom_id(voice):
            return None
        rate, target = self.cloning.sample_rate, self.preset.sample_rate
        return DownResampler(rate, target) if rate > target else None

    def synthesize(
        self,
        text: str,
        voice: str,
        *,
        speed: float = 1.0,
        language: str | None = None,
        lexicon: bool = True,
        resampler: DownResampler | None = None,
    ) -> Iterator[np.ndarray]:
        """`lexicon=False` for text that already went through `sentences` (applying it twice could re-replace).

        `resampler` (from `down_resampler`) continues one stream across calls, one sentence per call, so the audio is
        exactly that of a single call; the caller flushes it after the last one."""
        sentences = self.sentences(text) if lexicon else [s for s in split_sentences(text) if speakable(s)]
        if not is_custom_id(voice):
            for sentence in sentences:
                yield from self.preset.synthesize(sentence, voice, speed=speed, language=language)
            return
        if self.cloning is None:
            raise UnknownVoiceError(
                f"voice '{voice}' is a custom voice, but cloning is not available on this server"
            )
        reference = self.store.get(voice)  # UnknownVoiceError when it was deleted
        rate = self.cloning.sample_rate
        target = self.preset.sample_rate
        own = resampler is None
        down = (
            resampler if not own else (DownResampler(rate, target) if rate > target else None)
        )  # keeps state
        for sentence in sentences:
            for chunk in self.cloning.synthesize_cloned(sentence, reference, speed=speed, language=language):
                out = down.process(chunk) if down else resample(chunk, rate, target)
                if len(out):
                    yield out
        if down and own:
            tail = down.flush()
            if len(tail):
                yield tail

    def warm_up(self) -> None:
        self.preset.warm_up()
        if self.cloning is not None:
            self.cloning.warm_up()
