"""Voice and phonemizer choice per sentence, without loading the model."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from max_speech.engines.kokoro import KokoroTts, _script_language, _voice_info

VOICE_IDS = ["af_heart", "am_michael", "zf_xiaobei", "zm_yunjian", "jf_alpha", "ef_dora"]


class _FakeKokoro:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    tokenizer = SimpleNamespace(phonemize=lambda text, lang: f"{lang}<{text}>")

    def create(self, text, voice, speed, lang=None, is_phonemes=False):
        import numpy as np

        self.calls.append((text, voice, "phonemes" if is_phonemes else lang))
        return np.zeros(240, dtype=np.float32), 24000


def _engine() -> tuple[KokoroTts, _FakeKokoro]:
    engine = object.__new__(KokoroTts)
    fake = _FakeKokoro()
    engine._kokoro = fake
    engine._ja_g2p = lambda text: (f"ja<{text}>", None)
    engine._voices = [_voice_info(v) for v in VOICE_IDS]
    engine._ids = set(VOICE_IDS)
    engine.model_id = "kokoro-v1.0"
    return engine, fake


def test_script_language():
    assert _script_language("你好。") == "zh"
    assert _script_language("打开 Spotify。") == "zh"
    assert _script_language("こんにちは、世界。") == "ja"
    assert _script_language("Hello there.") is None
    assert _script_language("¿Dónde está?") is None


def test_chinese_text_with_an_english_voice_switches_to_a_chinese_voice_of_the_same_gender():
    engine, fake = _engine()
    list(engine.synthesize("你好。今天天气不错！", "af_heart"))
    assert [(v, lang) for _, v, lang in fake.calls] == [("zf_xiaobei", "cmn"), ("zf_xiaobei", "cmn")]
    fake.calls.clear()
    list(engine.synthesize("你好。", "am_michael"))
    assert fake.calls == [("你好。", "zm_yunjian", "cmn")]


def test_mixed_text_picks_the_voice_per_sentence():
    engine, fake = _engine()
    list(engine.synthesize("好的。Next one. OK。", "af_heart"))
    assert fake.calls == [
        ("好的。", "zf_xiaobei", "cmn"),
        ("Next one.", "af_heart", "en-us"),
        ("OK。", "af_heart", "en-us"),
    ]


def test_latin_text_keeps_the_requested_voice_and_honours_language():
    engine, fake = _engine()
    list(engine.synthesize("Hola amigo.", "ef_dora"))
    list(engine.synthesize("Hola amigo.", "ef_dora", language="es"))
    assert fake.calls == [("Hola amigo.", "ef_dora", "es"), ("Hola amigo.", "ef_dora", "es")]


def test_a_chinese_voice_reading_chinese_is_unchanged():
    engine, fake = _engine()
    list(engine.synthesize("你好。", "zf_xiaobei", language="en"))
    assert fake.calls == [("你好。", "zf_xiaobei", "cmn")]


def test_hint_for_a_language_the_voice_does_not_speak_switches_voice():
    engine, fake = _engine()
    list(engine.synthesize("Hola amigo.", "af_heart", language="es"))
    list(engine.synthesize("Hello.", "am_michael", language="zh"))
    assert fake.calls == [("Hola amigo.", "ef_dora", "es"), ("Hello.", "zm_yunjian", "cmn")]


def test_hint_without_a_voice_for_that_language_keeps_voice_and_uses_the_phonemes():
    engine, fake = _engine()
    list(engine.synthesize("Bonjour.", "af_heart", language="fr"))
    assert fake.calls == [("Bonjour.", "af_heart", "fr-fr")]


def test_british_voice_keeps_en_gb_for_an_english_hint():
    engine, fake = _engine()
    engine._voices.append(_voice_info("bf_emma"))
    engine._ids.add("bf_emma")
    list(engine.synthesize("Hello.", "bf_emma", language="en"))
    assert fake.calls == [("Hello.", "bf_emma", "en-gb")]


def test_prolonged_sound_mark_and_middle_dot_alone_are_not_japanese():
    assert _script_language("ー") is None
    assert _script_language("・") is None
    assert _script_language("コーヒー") == "ja"


def test_ja_hint_with_han_only_text_uses_the_japanese_voice():
    engine, fake = _engine()
    list(engine.synthesize("東京大学。", "af_heart", language="ja"))
    assert fake.calls == [("ja<東京大学。>", "jf_alpha", "phonemes")]
    fake.calls.clear()
    list(engine.synthesize("東京大学。", "af_heart"))
    assert fake.calls == [("東京大学。", "zf_xiaobei", "cmn")]


def test_kana_text_uses_the_japanese_g2p_and_voice():
    engine, fake = _engine()
    list(engine.synthesize("こんにちは。", "af_heart"))
    assert fake.calls == [("ja<こんにちは。>", "jf_alpha", "phonemes")]


def test_latin_words_inside_japanese_go_through_the_english_phonemizer():
    engine, fake = _engine()
    list(engine.synthesize("GPSをオンにして、Wi-Fiも。", "jf_alpha"))
    assert fake.calls == [("en-us<GPS> ja<をオンにして、> en-us<Wi-Fi> ja<も。>", "jf_alpha", "phonemes")]


def test_the_assistants_name_is_read_in_katakana_inside_japanese():
    engine, fake = _engine()
    list(engine.synthesize("MAXさん、Maximumです。", "jf_alpha"))
    assert fake.calls == [("ja<マックスさん、> en-us<Maximum> ja<です。>", "jf_alpha", "phonemes")]


def test_full_width_latin_inside_japanese_is_normalised_first():
    engine, fake = _engine()
    list(engine.synthesize("ＧＰＳです。", "jf_alpha"))
    assert fake.calls == [("en-us<GPS> ja<です。>", "jf_alpha", "phonemes")]


def test_japanese_with_nothing_to_say_produces_no_audio():
    engine, fake = _engine()
    engine._ja_g2p = lambda text: ("", None)
    assert list(engine.synthesize("・", "jf_alpha", language="ja")) == []
    assert fake.calls == []


def test_the_real_japanese_g2p_reads_kanji_as_words():
    engine, _ = _engine()
    engine._ja_g2p = None
    phonemes = engine._phonemize_ja("東京へ行きます。")
    assert "toːkʲoː" in phonemes
    assert "letter" not in phonemes and "(en)" not in phonemes


def test_speed_is_clamped_to_the_range_kokoro_accepts():
    engine, fake = _engine()
    seen = []
    fake.create = lambda text, voice, speed, lang: (seen.append(speed), (np.zeros(10, np.float32), 24000))[1]
    list(engine.synthesize("Hi.", "af_heart", speed=4.0))
    list(engine.synthesize("Hi.", "af_heart", speed=0.25))
    list(engine.synthesize("Hi.", "af_heart", speed=1.2))
    assert seen == [2.0, 0.5, 1.2]
