"""Qwen3MlxCloning with a fake mlx-audio model: language choice, reference caching and chunk conversion."""

from types import SimpleNamespace

import numpy as np
import pytest

from max_speech.engines.base import ReferenceVoice
from max_speech.engines.qwen3_mlx import LANG_CODES, Qwen3MlxCloning, lang_code_for


class FakeModel:
    def __init__(self, chunks=None):
        self.calls: list[dict] = []
        self.chunks = chunks if chunks is not None else [np.ones(2400, dtype=np.float32) * 0.1]

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        for c in self.chunks:
            yield SimpleNamespace(audio=c, sample_rate=24000)


def make(model=None, **kw):
    converted = []

    def to_array(samples):
        converted.append(samples)
        return ("array", len(samples))

    model = model or FakeModel()
    return Qwen3MlxCloning(None, "qwen3-tts-0.6b-mlx", model=model, to_array=to_array, **kw), model, converted


def ref(language=None, rate=24000, n=48000):
    return ReferenceVoice("v_abc", np.zeros(n, dtype=np.float32), rate, "Hello world.", language)


@pytest.mark.parametrize(
    ("sentence", "language", "ref_lang", "expected"),
    [
        ("Hello there.", None, None, "english"),
        ("你好，今天天气很好。", None, "en", "chinese"),
        ("こんにちは、元気ですか。", None, "en", "japanese"),  # kana beats Han
        ("안녕하세요.", None, "en", "korean"),
        ("Bonjour.", None, "fr", "french"),  # no script clue: the reference's language
        ("Bonjour.", None, "xx", "english"),  # unknown reference language
        ("Hello there.", "zh", None, "english"),  # a CJK language tag for Latin-only text is not a CJK read
        ("Hello there.", "zh", "fr", "french"),  # ... it uses the reference's language
        ("OK 2024", "ja", "en", "english"),
        ("Bonjour.", "de", None, "german"),  # a Latin language tag still wins over no script
        ("你好，今天天气很好。", "en", None, "chinese"),  # a Latin language tag cannot read Han text
        ("こんにちは。", "zh", None, "chinese"),  # within CJK the explicit language wins
        ("Hello there.", "en-US", None, "english"),
        ("你好。", "klingon", None, "chinese"),  # unknown explicit language falls through to the script
    ],
)
def test_lang_code_for(sentence, language, ref_lang, expected):
    assert lang_code_for(sentence, language, ref_lang) == expected


def test_languages_cover_the_ten_the_model_speaks():
    assert set(Qwen3MlxCloning.languages) == {"zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"}
    assert len(set(LANG_CODES.values())) == 10


def test_each_sentence_gets_its_own_language_and_the_reference_text():
    engine, model, _ = make()
    list(engine.synthesize_cloned("Hello there. 你好，很高兴见到你。 Bye now.", ref("en")))
    assert [c["lang_code"] for c in model.calls] == ["english", "chinese", "english"]
    assert [c["text"] for c in model.calls] == ["Hello there.", "你好，很高兴见到你。", "Bye now."]
    assert all(c["ref_text"] == "Hello world." and c["stream"] is True for c in model.calls)
    assert all(c["streaming_interval"] == engine.streaming_interval for c in model.calls)


def test_the_reference_is_prepared_once_per_voice():
    engine, model, converted = make()
    voice = ref()
    list(engine.synthesize_cloned("One. Two. Three.", voice))
    list(engine.synthesize_cloned("Four.", voice))
    assert len(converted) == 1
    assert len({id(c["ref_audio"]) for c in model.calls}) == 1 and len(model.calls) == 4
    # a new voice (or one whose cache was dropped) is prepared again
    list(engine.synthesize_cloned("Hi.", ref()))
    voice.cache.clear()
    list(engine.synthesize_cloned("Hi.", voice))
    assert len(converted) == 3


def test_the_reference_is_resampled_to_24k():
    engine, _, converted = make()
    list(engine.synthesize_cloned("Hi.", ref(rate=16000, n=32000)))
    assert len(converted[0]) == 48000


def test_chunks_are_float32_mono_numpy_and_empty_ones_are_dropped():
    odd = [np.zeros((1, 100), dtype=np.float64), np.zeros(0, dtype=np.float32), np.ones(50, dtype=np.float16)]
    engine, _, _ = make(FakeModel(odd))
    out = list(engine.synthesize_cloned("Hi.", ref()))
    assert [c.shape for c in out] == [(100,), (50,)]
    assert all(c.dtype == np.float32 for c in out)


def test_speed_is_accepted_and_blank_text_yields_nothing():
    engine, model, _ = make()
    assert list(engine.synthesize_cloned("   ", ref(), speed=1.2)) == []
    assert model.calls == []


def test_warm_up_runs_one_short_cloned_sentence():
    engine, model, _ = make()
    engine.warm_up()
    assert len(model.calls) == 1 and model.calls[0]["lang_code"] == "english"


def test_identity():
    engine, _, _ = make()
    assert (engine.id, engine.model_id, engine.sample_rate) == ("qwen3-mlx", "qwen3-tts-0.6b-mlx", 24000)
