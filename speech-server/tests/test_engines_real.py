import os

import numpy as np
import pytest

from max_speech.audio import INPUT_RATE, resample
from max_speech.engines.select import build_engines
from max_speech.profile import detect_profile
from max_speech.settings import Settings

pytestmark = [
    pytest.mark.models,
    pytest.mark.skipif(
        os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1", reason="set MAX_SPEECH_MODEL_TESTS=1"
    ),
]


@pytest.fixture(scope="module")
def engines():
    engines = build_engines(Settings(), detect_profile())
    return engines.stt, engines.tts


def test_kokoro_synthesizes_chunks(engines):
    _, tts = engines
    chunks = list(tts.synthesize("Hello there. How are you?", "af_heart"))
    assert len(chunks) >= 2
    assert sum(len(c) for c in chunks) / tts.sample_rate > 0.5


def test_whisper_hears_kokoro(engines):
    stt, tts = engines
    audio = np.concatenate(list(tts.synthesize("Hello there. How are you?", "af_heart")))
    text = stt.transcribe(resample(audio, tts.sample_rate, INPUT_RATE), INPUT_RATE, language="en").text
    assert "hello" in text.lower()


def test_kokoro_chinese(engines):
    _, tts = engines
    chunks = list(tts.synthesize("你好，今天天气很好。", "zf_xiaobei"))
    assert chunks


def test_chinese_round_trip_cer(engines):
    from bench.latency import PHRASES, cer

    stt, tts = engines
    voice = tts.default_voice("female", "zh")
    assert voice.startswith("zf_") and "zf_xiaobei" not in {v.id for v in tts.voices()}
    scores = []
    for phrase in (p.text for p in PHRASES if p.lang == "zh"):
        audio = np.concatenate(list(tts.synthesize(phrase, voice)))
        heard = stt.transcribe(resample(audio, tts.sample_rate, INPUT_RATE), INPUT_RATE, language="zh").text
        scores.append(cer(phrase, heard))
    assert sum(scores) / len(scores) < 0.15, scores


def test_chinese_with_an_english_word(engines):
    _, tts = engines
    audio = np.concatenate(list(tts.synthesize("打开 Spotify 播放音乐。", tts.default_voice("female", "zh"))))
    assert len(audio) / tts.sample_rate > 1.0
