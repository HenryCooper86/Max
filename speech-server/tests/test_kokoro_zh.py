"""Chinese routing to Kokoro v1.1-zh, with fake kokoro objects and a fake G2P."""

from __future__ import annotations

import numpy as np
import pytest

from max_speech.engines.base import UnknownVoiceError
from max_speech.engines.kokoro import KokoroTts, _voice_info
from max_speech.licenses import load_registry, require

V10_VOICES = ["af_heart", "am_michael", "jf_alpha", "zf_xiaobei", "zm_yunjian"]
ZH_VOICES = ["af_maple", "zf_002", "zf_003", "zm_009", "zm_010"]  # the file also holds non-Chinese voices


class _FakeKokoro:
    def __init__(self, voices):
        self._voices = voices
        self.calls: list[dict] = []

    def get_voices(self):
        return list(self._voices)

    def create(self, text, voice, speed=1.0, lang="en-us", is_phonemes=False):
        self.calls.append({"text": text, "voice": voice, "lang": lang, "is_phonemes": is_phonemes})
        return np.zeros(240, dtype=np.float32), 24000


class _FakeG2P:
    def __init__(self):
        self.seen: list[str] = []

    def __call__(self, text):
        self.seen.append(text)
        return f"<{text}>", None


def _engine(with_zh=True):
    engine = object.__new__(KokoroTts)
    engine.model_id = "kokoro-v1.0"
    engine._kokoro = _FakeKokoro(V10_VOICES)
    voices = [_voice_info(v) for v in V10_VOICES]
    if with_zh:
        engine._zh = _FakeKokoro(ZH_VOICES)
        engine._legacy_zh_ids = frozenset({"zf_xiaobei", "zm_yunjian"})
        zh = [_voice_info(v) for v in ZH_VOICES if v[0] == "z"]
        engine._zh_ids = frozenset(v.id for v in zh)
        voices = [v for v in voices if "zh" not in v.languages] + zh
        engine._zh_g2p = _FakeG2P()
        engine.extra_model_ids = ("kokoro-v1.1-zh",)
    engine._voices = voices
    engine._ids = {v.id for v in voices}
    return engine


def test_chinese_goes_to_the_zh_model_as_phonemes():
    engine = _engine()
    list(engine.synthesize("你好。", "zf_003"))
    assert engine._zh.calls == [{"text": "<你好。>", "voice": "zf_003", "lang": "en-us", "is_phonemes": True}]
    assert engine._kokoro.calls == []


def test_english_stays_on_v1_0():
    engine = _engine()
    list(engine.synthesize("Hello there.", "af_heart"))
    assert engine._kokoro.calls == [
        {"text": "Hello there.", "voice": "af_heart", "lang": "en-us", "is_phonemes": False}
    ]
    assert engine._zh.calls == []


def test_mixed_text_is_routed_per_sentence():
    engine = _engine()
    list(engine.synthesize("好的。Next one.", "am_michael"))
    assert [c["voice"] for c in engine._zh.calls] == ["zm_009"]
    assert [c["text"] for c in engine._kokoro.calls] == ["Next one."]


def test_english_voice_with_chinese_text_uses_the_default_zh_voice_of_its_gender():
    engine = _engine()
    list(engine.synthesize("你好。", "af_heart"))
    list(engine.synthesize("你好。", "am_michael"))
    assert [c["voice"] for c in engine._zh.calls] == ["zf_002", "zm_009"]


def test_legacy_v1_0_chinese_voice_ids_are_accepted_and_mapped():
    engine = _engine()
    list(engine.synthesize("你好。", "zf_xiaobei"))
    list(engine.synthesize("你好。", "zm_yunjian"))
    assert [c["voice"] for c in engine._zh.calls] == ["zf_002", "zm_009"]
    assert engine._kokoro.calls == []


def test_language_hint_zh_for_latin_text_uses_the_zh_model():
    engine = _engine()
    list(engine.synthesize("Hello.", "af_heart", language="zh"))
    assert [c["text"] for c in engine._zh.calls] == ["<Hello.>"]


def test_voices_lists_zh_model_voices_and_hides_the_v1_0_chinese_ones():
    engine = _engine()
    listed = {v.id: v for v in engine.voices()}
    assert set(listed) == {"af_heart", "am_michael", "jf_alpha", "zf_002", "zf_003", "zm_009", "zm_010"}
    assert listed["zf_002"].languages == ("zh",) and listed["zm_009"].gender == "male"
    assert "af_maple" not in listed  # non-Chinese voices of the zh voices file are skipped


def test_default_voices_are_zh_model_voices():
    engine = _engine()
    assert engine.default_voice("female", "zh") == "zf_002"
    assert engine.default_voice("male", "zh") == "zm_009"
    assert engine.default_voice("female") == "af_heart"


def test_unknown_voice_still_rejected():
    with pytest.raises(UnknownVoiceError):
        list(_engine().synthesize("你好。", "zf_999"))


def test_without_the_zh_model_behaviour_is_the_old_one():
    engine = _engine(with_zh=False)
    list(engine.synthesize("你好。", "af_heart"))
    assert engine._kokoro.calls == [
        {"text": "你好。", "voice": "zf_xiaobei", "lang": "cmn", "is_phonemes": False}
    ]
    assert {v.id for v in engine.voices()} == set(V10_VOICES)
    assert engine.default_voice("male", "zh") == "zm_yunjian"


def test_g2p_is_built_once_with_an_english_callable(monkeypatch):
    import misaki.zh

    built = []

    class G2P:
        def __init__(self, version=None, unk="?", en_callable=None):
            built.append((version, en_callable))

        def __call__(self, text):
            return text, None

    monkeypatch.setattr(misaki.zh, "ZHG2P", G2P)
    engine = _engine()
    engine._zh_g2p = None
    engine._kokoro.tokenizer = type("T", (), {"phonemize": lambda self, text, lang: f"{lang}:{text}"})()
    list(engine.synthesize("你好。再见。", "zf_002"))
    assert len(built) == 1
    version, en_callable = built[0]
    assert version == "1.1" and en_callable("Spotify") == "en-us:Spotify"


def test_zh_registry_entry_passes_require():
    entry = require("kokoro-v1.1-zh", "tts", registry=load_registry())
    assert entry.weights_license == "Apache-2.0"
    assert [f.url.rsplit("/", 1)[-1] for f in entry.files] == ["kokoro-v1.1-zh.onnx", "voices-v1.1-zh.bin"]
