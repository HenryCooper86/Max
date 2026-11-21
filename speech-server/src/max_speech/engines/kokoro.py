"""Kokoro-82M through kokoro-onnx. Heavy imports stay inside the constructor so importing this is free."""

from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from max_speech.chunker import split_sentences
from max_speech.engines.base import UnknownVoiceError, VoiceInfo

_MIN_SPEED, _MAX_SPEED = 0.5, 2.0
# Latin words inside Japanese text. The Japanese G2P passes them through as letters Kokoro cannot say.
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'’-]*")
# The assistant's own name, which it says often: English phonemes in a Japanese voice do not sound like マックス.
_JA_MAX = re.compile(r"(?<![A-Za-z0-9])max(?![A-Za-z0-9])", re.IGNORECASE)
# Guards building the Japanese G2P on first use and its tagger, which is not documented as thread-safe.
_JA_LOCK = threading.Lock()

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
# Defaults among the Kokoro v1.1-zh voices (kokoro-v1.1-zh.onnx), chosen by speak-then-transcribe CER.
# Each candidate spoke the five Chinese bench phrases and mlx Whisper large-v3-turbo transcribed them with
# language="zh"; the lowest mean CER won, the lowest id breaking ties. Mean CER, first 8 voices per gender:
#   female: zf_002 0.000 (tie with zf_004, zf_006), zf_003 0.010, zf_008 0.010, zf_001 0.083, zf_007 0.148, zf_005 0.155
#   male:   zm_009 0.000, zm_010/011/013/014 0.005, zm_015/016 0.010, zm_012 0.050
# For comparison the v1.0 espeak voices scored 0.676 (zf_xiaobei) and 0.394 (zm_yunjian).
_ZH_DEFAULTS = {"female": "zf_002", "male": "zm_009"}
# Japanese defaults, by the same speak-then-transcribe check on 20 assistant sentences, compared by reading.
# jf_gongitsune, jf_nezumi, jf_tebukuro and jm_kumo read all 20 correctly; jf_alpha read 19.
_DEFAULT_VOICES = {
    ("female", "en"): "af_heart",
    ("female", "ja"): "jf_gongitsune",
    ("female", "zh"): "zf_xiaobei",
    ("male", "en"): "am_michael",
    ("male", "ja"): "jm_kumo",
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


def _is_zh_voice(voice_id: str) -> bool:
    return voice_id[:1] == "z" and voice_id[1:2] in ("f", "m")


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

    # Class-level defaults keep an engine built without the zh model (and test doubles) working unchanged.
    extra_model_ids: tuple[str, ...] = ()
    _zh = None  # the Kokoro v1.1-zh instance, when the zh model is loaded
    _zh_g2p = None
    _ja_g2p = None  # built on the first Japanese sentence: its dictionary is only needed then
    _zh_ids: frozenset[str] = frozenset()
    _legacy_zh_ids: frozenset[str] = frozenset()  # v1.0 Chinese voice ids, accepted but not listed

    def __init__(
        self,
        model_dir: Path,
        model_id: str = "kokoro-v1.0",
        *,
        use_cuda: bool = False,
        zh_model_dir: Path | None = None,
        zh_model_id: str = "kokoro-v1.1-zh",
    ):
        self.model_id = model_id
        self.extra_model_ids = (zh_model_id,) if zh_model_dir is not None else ()
        self._kokoro = self._open(model_dir / "kokoro-v1.0.onnx", model_dir / "voices-v1.0.bin", use_cuda)
        voices = [_voice_info(v) for v in self._kokoro.get_voices()]
        if zh_model_dir is not None:
            self._zh = self._open(
                zh_model_dir / "kokoro-v1.1-zh.onnx", zh_model_dir / "voices-v1.1-zh.bin", use_cuda
            )
            self._legacy_zh_ids = frozenset(v.id for v in voices if "zh" in v.languages)
            zh_voices = [_voice_info(v) for v in sorted(self._zh.get_voices()) if _is_zh_voice(v)]
            voices = [v for v in voices if "zh" not in v.languages] + zh_voices
            self._zh_ids = frozenset(v.id for v in zh_voices)
        self._voices = voices
        self._ids = {v.id for v in self._voices}

    @staticmethod
    def _open(model_path: Path, voices_path: Path, use_cuda: bool):
        from kokoro_onnx import Kokoro

        model, voices = str(model_path), str(voices_path)
        if use_cuda:
            import onnxruntime as ort

            providers = ort.get_available_providers()
            if "CUDAExecutionProvider" in providers:
                # kokoro-onnx only picks GPU providers for the onnxruntime-gpu wheel, so hand it a session.
                session = ort.InferenceSession(
                    model, providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
                )
                return Kokoro.from_session(session, voices)
        return Kokoro(model, voices)

    def voices(self) -> list[VoiceInfo]:
        return list(self._voices)

    def default_voice(self, gender: str = "female", language: str | None = None) -> str:
        lang = language or "en"
        if lang == "zh" and self._zh_ids and _ZH_DEFAULTS.get(gender) in self._zh_ids:
            return _ZH_DEFAULTS[gender]
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
        if voice not in self._ids and voice not in self._legacy_zh_ids:
            raise UnknownVoiceError(voice)
        # Kokoro itself only supports 0.5-2.0; the API accepts the wider OpenAI range, so clamp here.
        speed = min(max(speed, _MIN_SPEED), _MAX_SPEED)
        info = _voice_info(voice)
        for sentence in split_sentences(text):
            sentence_voice, lang = self._voice_for(sentence, info, language)
            # Yielding per sentence lets the caller send the first one before the rest are synthesized.
            if self._zh is not None and lang == "cmn":
                samples = self._create_zh(sentence, sentence_voice, info, speed)
            elif lang == "ja":
                samples = self._create_ja(sentence, sentence_voice, speed)
            else:
                samples, _ = self._kokoro.create(sentence, voice=sentence_voice, speed=speed, lang=lang)
            if len(samples):
                yield samples.astype(np.float32, copy=False)

    def _create_zh(self, sentence: str, voice: str, info: VoiceInfo, speed: float) -> np.ndarray:
        """One Chinese sentence through Kokoro v1.1-zh with misaki's Chinese G2P."""
        if voice not in self._zh_ids:
            # A v1.0 Chinese voice id (zf_xiaobei, ...): the same gender's default v1.1-zh voice speaks it.
            voice = self.default_voice(info.gender, "zh")
        phonemes, _ = self._g2p_zh()(sentence)
        samples, _ = self._zh.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
        return samples

    def _create_ja(self, sentence: str, voice: str, speed: float) -> np.ndarray:
        """One Japanese sentence through misaki's G2P: espeak reads kanji as the words "Chinese letter"."""
        phonemes = self._phonemize_ja(sentence)
        if not phonemes:
            return np.zeros(0, dtype=np.float32)
        samples, _ = self._kokoro.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
        return samples

    def _phonemize_ja(self, sentence: str) -> str:
        text = _JA_MAX.sub("マックス", unicodedata.normalize("NFKC", sentence))
        pieces: list[str] = []
        at = 0
        with _JA_LOCK:
            g2p = self._g2p_ja()
            for word in _LATIN_WORD.finditer(text):
                if word.start() > at:
                    pieces.append(g2p(text[at : word.start()])[0])
                pieces.append(self._kokoro.tokenizer.phonemize(word.group(), "en-us"))
                at = word.end()
            if at < len(text):
                pieces.append(g2p(text[at:])[0])
        return " ".join(piece.strip() for piece in pieces if piece.strip())

    def _g2p_ja(self):
        if self._ja_g2p is None:
            # misaki.cutlet, not misaki.ja: this is the phoneme set the v1.0 voices use, and misaki.ja would
            # import pyopenjtalk, which has to be compiled and downloads a dictionary at run time.
            from misaki.cutlet import Cutlet

            self._ja_g2p = Cutlet()
        return self._ja_g2p

    def _g2p_zh(self):
        if self._zh_g2p is None:
            from misaki.zh import ZHG2P

            def english(text: str) -> str:
                # English words inside a Chinese sentence: v1.0's espeak path; unknown symbols are dropped
                # later by the v1.1-zh tokenizer.
                return self._kokoro.tokenizer.phonemize(text, "en-us")

            self._zh_g2p = ZHG2P(version="1.1", en_callable=english)
        return self._zh_g2p

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
        if self._zh is not None:
            # Builds the Chinese G2P (jieba loads its dictionary on first use) and runs the zh model once.
            for _ in self.synthesize("准备好了。", self.default_voice("female", "zh")):
                pass
