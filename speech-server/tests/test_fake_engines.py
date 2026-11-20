import numpy as np
import pytest

from max_speech.engines.base import UnknownVoiceError
from max_speech.engines.fake import FakeStt, FakeTts


def test_fake_tts_voices():
    t = FakeTts()
    assert t.sample_rate == 22050
    by_id = {v.id: v for v in t.voices()}
    assert by_id["alpha"].languages == ("en",) and by_id["alpha"].gender == "female"
    assert by_id["bravo"].languages == ("zh",) and by_id["bravo"].gender == "male"
    assert t.default_voice() == "alpha"
    assert t.default_voice("male") == "bravo"
    assert t.default_voice(language="zh") == "bravo"


def test_fake_tts_duration_per_word_and_cjk_char():
    t = FakeTts()
    chunks = list(t.synthesize("one two three. four", "alpha"))
    assert len(chunks) == 2
    assert all(c.dtype == np.float32 for c in chunks)
    assert [len(c) for c in chunks] == [round(0.3 * 22050), round(0.1 * 22050)]
    zh = list(t.synthesize("你好。今天天气不错！", "bravo"))
    assert [len(c) for c in zh] == [round(0.2 * 22050), round(0.6 * 22050)]


def test_fake_tts_unknown_voice():
    with pytest.raises(UnknownVoiceError):
        list(FakeTts().synthesize("hi", "nope"))


def test_fake_stt():
    s = FakeStt()
    r = s.transcribe(np.zeros(16000, dtype=np.float32), 16000)
    assert r.text == "heard 1.0s" and r.duration_s == 1.0
    assert s.transcribe(np.zeros(8000, dtype=np.float32), 16000, prompt="echo").text == "echo"
    assert s.transcribe(np.zeros(8000, dtype=np.float32), 16000, prompt="x").text == "heard 0.5s"
