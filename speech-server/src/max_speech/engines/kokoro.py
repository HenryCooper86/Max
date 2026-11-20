"""Kokoro-82M through kokoro-onnx. Heavy imports stay inside the constructor so importing this is free."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import numpy as np

from max_speech.chunker import split_sentences
from max_speech.engines.base import UnknownVoiceError, VoiceInfo

_MIN_SPEED, _MAX_SPEED = 0.5, 2.0

# Kokoro voice ids start with a language letter; kokoro-onnx wants an espeak language code.
_LANG_BY_LETTER = {
    "a": ("en", "en-us"),
    "b": ("en", "en-gb"),
    "e": ("es", "es"),
    "f": ("fr", "fr-fr"),
    "h": ("hi", "hi"),
    "i": ("it", "it"),
    "j": ("ja", "ja"),
    "p": ("pt", "pt-br"),
    "z": ("zh", "cmn"),
}
_DEFAULT_VOICES = {
    ("female", "en"): "af_heart",
    ("female", "zh"): "zf_xiaobei",
    ("male", "en"): "am_michael",
    ("male", "zh"): "zm_yunjian",
}
# Language names a client may pass, mapped to the espeak code to use regardless of the voice.
_ESPEAK_BY_LANGUAGE = {"en": "en-us", "es": "es", "fr": "fr-fr", "hi": "hi", "it": "it", "ja": "ja"}
_ESPEAK_BY_LANGUAGE |= {"pt": "pt-br", "zh": "cmn"}


def _script_language(sentence: str) -> str | None:
    """The language a sentence's script forces, or None when the script does not decide it.

    Kokoro voices are monolingual: an English voice's phonemizer reads each Chinese character as
    "Chinese letter". Clients (Max's relay among them) send one voice for every language the
    assistant speaks and no language hint, so the sentence's own script has to pick the voice.
    Latin script is left to the voice, since it cannot tell English from Spanish or French.
    """
    han = False
    for ch in sentence:
        code = ord(ch)
        # Hiragana and katakana letters occur only in Japanese. U+30FB (middle dot) and U+30FC (prolonged
        # sound mark) are also used in Chinese and punctuation contexts, so they do not count.
        if 0x3040 <= code <= 0x30FF and code not in (0x30FB, 0x30FC):
            return "ja"
        if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            han = True
    return "zh" if han else None


def _voice_info(voice_id: str) -> VoiceInfo:
    letter = voice_id[:1]
    language = _LANG_BY_LETTER.get(letter, ("en", "en-us"))[0]
    gender = "female" if voice_id[1:2] == "f" else "male"
    return VoiceInfo(
        id=voice_id, name=voice_id.split("_", 1)[-1].title(), languages=(language,), gender=gender
    )


class KokoroTts:
    id = "kokoro"
    sample_rate = 24000

    def __init__(self, model_dir: Path, model_id: str = "kokoro-v1.0", *, use_cuda: bool = False):
        from kokoro_onnx import Kokoro

        model_path = str(model_dir / "kokoro-v1.0.onnx")
        voices_path = str(model_dir / "voices-v1.0.bin")
        self.model_id = model_id
        if use_cuda:
            import onnxruntime as ort

            providers = ort.get_available_providers()
            if "CUDAExecutionProvider" in providers:
                # kokoro-onnx only picks GPU providers for the onnxruntime-gpu wheel, so hand it a session.
                session = ort.InferenceSession(
                    model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
                )
                self._kokoro = Kokoro.from_session(session, voices_path)
            else:
                self._kokoro = Kokoro(model_path, voices_path)
        else:
            self._kokoro = Kokoro(model_path, voices_path)
        self._voices = [_voice_info(v) for v in self._kokoro.get_voices()]
        self._ids = {v.id for v in self._voices}

    def voices(self) -> list[VoiceInfo]:
        return list(self._voices)

    def default_voice(self, gender: str = "female", language: str | None = None) -> str:
        lang = language or "en"
        preferred = _DEFAULT_VOICES.get((gender, lang))
        if preferred in self._ids:
            return preferred
        for v in self._voices:
            if v.gender == gender and lang in v.languages:
                return v.id
        for v in self._voices:
            if v.gender == gender:
                return v.id
        return self._voices[0].id

    def synthesize(
        self, text: str, voice: str, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        if voice not in self._ids:
            raise UnknownVoiceError(voice)
        # Kokoro itself only supports 0.5-2.0; the API accepts the wider OpenAI range, so clamp here.
        speed = min(max(speed, _MIN_SPEED), _MAX_SPEED)
        info = _voice_info(voice)
        for sentence in split_sentences(text):
            sentence_voice, lang = self._voice_for(sentence, info, language)
            # Yielding per sentence lets the caller send the first one before the rest are synthesized.
            samples, _ = self._kokoro.create(sentence, voice=sentence_voice, speed=speed, lang=lang)
            if len(samples):
                yield samples.astype(np.float32, copy=False)

    def _voice_for(self, sentence: str, info: VoiceInfo, language: str | None) -> tuple[str, str]:
        """The voice and espeak code for one sentence: the script decides first, then `language`,
        then the requested voice's own language."""
        forced = _script_language(sentence)
        if forced == "zh" and language == "ja":
            forced = "ja"  # Japanese written in kanji only: the hint breaks the tie with Chinese
        if forced and forced not in info.languages:
            substitute = self.default_voice(info.gender, forced)
            if forced in _voice_info(substitute).languages:
                return substitute, _ESPEAK_BY_LANGUAGE[forced]
        if language in _ESPEAK_BY_LANGUAGE and not forced:
            if language not in info.languages:
                # The voice cannot speak the hinted language: use a voice that can, if there is one.
                substitute = self.default_voice(info.gender, language)
                if language in _voice_info(substitute).languages:
                    return substitute, _ESPEAK_BY_LANGUAGE[language]
            elif language == "en":
                # Keep the voice's own dialect (British b* voices) when the hint is just "en".
                return info.id, _LANG_BY_LETTER.get(info.id[:1], ("en", "en-us"))[1]
            return info.id, _ESPEAK_BY_LANGUAGE[language]
        return info.id, _LANG_BY_LETTER.get(info.id[:1], ("en", "en-us"))[1]

    def warm_up(self) -> None:
        for _ in self.synthesize("Ready.", self.default_voice()):
            pass
