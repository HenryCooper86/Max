"""Voice cloning with Qwen3-TTS Base on Apple Silicon, through mlx-audio.

The model is given a reference clip and its transcript on every call. mlx-audio accepts the clip as an array, so
no temporary files are written; the prepared array is kept in the voice's `cache` so it is converted once.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from max_speech.audio import resample
from max_speech.chunker import split_sentences
from max_speech.engines.base import ReferenceVoice

MODEL_RATE = 24000
# primary language tag -> the name Qwen3-TTS expects as lang_code
LANG_CODES = {
    "zh": "chinese",
    "en": "english",
    "ja": "japanese",
    "ko": "korean",
    "de": "german",
    "fr": "french",
    "ru": "russian",
    "pt": "portuguese",
    "es": "spanish",
    "it": "italian",
}
_KANA = re.compile(r"[぀-ヿ]")
_HANGUL = re.compile(r"[가-힯ᄀ-ᇿ]")
_HAN = re.compile(r"[㐀-䶿一-鿿]")
_CJK_CODES = ("chinese", "japanese", "korean")
_CACHE_KEY = "qwen3-mlx-reference"
# Seconds of audio per streamed chunk. See the README for the measurements behind the default.
DEFAULT_STREAMING_INTERVAL = 0.5


def _mx_array(samples: np.ndarray):
    import mlx.core as mx

    array = mx.array(samples)
    mx.eval(array)
    return array


def _script_code(sentence: str) -> str | None:
    # Kana before Han: Japanese text mixes both, Chinese has no kana.
    if _KANA.search(sentence):
        return "japanese"
    if _HANGUL.search(sentence):
        return "korean"
    if _HAN.search(sentence):
        return "chinese"
    return None


def lang_code_for(sentence: str, language: str | None, reference_language: str | None) -> str:
    """The model's language name for one sentence.

    An explicit language wins, except that a sentence in a CJK script is never read as a Latin-script language
    (a voice tagged "en" asked to say Chinese text must still speak Chinese). With no explicit language, the
    sentence's script decides, then the reference's language, then English.
    """
    script = _script_code(sentence)
    if language and (code := LANG_CODES.get(language.strip().replace("_", "-").split("-", 1)[0].lower())):
        if code not in _CJK_CODES:
            return script or code
        if script:
            return code
        # A CJK language for a sentence with no CJK characters ("OK", "2024"): not a CJK read, so fall through
        # to the reference's language, then English.
    elif script:
        return script
    if reference_language and (code := LANG_CODES.get(reference_language.split("-", 1)[0].lower())):
        return code
    return "english"


class Qwen3MlxCloning:
    id = "qwen3-mlx"
    sample_rate = MODEL_RATE
    languages = tuple(LANG_CODES)

    def __init__(
        self,
        model_dir: Path,
        model_id: str,
        *,
        streaming_interval: float = DEFAULT_STREAMING_INTERVAL,
        model=None,
        to_array=None,
    ) -> None:
        """`model` and `to_array` (numpy -> the model's array type) are for tests; by default the real ones load."""
        self.model_id = model_id
        self.streaming_interval = streaming_interval
        if model is None:
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model

            model = load_model(str(model_dir))
            mx.eval(model.parameters())
        self._model = model
        self._to_array = to_array or _mx_array

    def _reference_audio(self, reference: ReferenceVoice):
        """The reference as an mx.array at the model's rate, prepared once per voice."""
        cached = reference.cache.get(_CACHE_KEY)
        if cached is None:
            samples = resample(np.asarray(reference.audio, dtype=np.float32), reference.rate, MODEL_RATE)
            cached = self._to_array(samples)
            reference.cache[_CACHE_KEY] = cached
        return cached

    def synthesize_cloned(
        self, text: str, reference: ReferenceVoice, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        # `speed` is not supported by the model; it is accepted so callers need not special-case it.
        ref_audio = self._reference_audio(reference)
        for sentence in split_sentences(text):
            if not sentence.strip():
                continue
            lang_code = lang_code_for(sentence, language, reference.language)
            for result in self._model.generate(
                text=sentence,
                ref_audio=ref_audio,
                ref_text=reference.transcript,
                lang_code=lang_code,
                stream=True,
                streaming_interval=self.streaming_interval,
            ):
                chunk = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                if chunk.size:
                    yield chunk

    def warm_up(self) -> None:
        """Compile the kernels with one short sentence cloned from a synthetic reference (3 s of voiced noise)."""
        t = np.arange(3 * MODEL_RATE, dtype=np.float32) / MODEL_RATE
        buzz = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 12))
        audio = (0.1 * buzz * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)
        reference = ReferenceVoice("warm-up", audio, MODEL_RATE, "Hello, this is a test.", "en")
        for _ in self.synthesize_cloned("Hello there.", reference):
            pass

    def close(self) -> None:
        self._model = None
