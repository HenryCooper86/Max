"""Real voice design on Apple Silicon: design two voices, check they differ as described, save one, speak a new
sentence with it through the router (cloning) and let mlx Whisper check it is intelligible."""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # for bench/

from test_cloning_real import _median_f0

from max_speech.audio import INPUT_RATE, resample
from max_speech.engines.router import VoiceRouter
from max_speech.engines.select import build_engines
from max_speech.profile import detect_profile
from max_speech.settings import Settings
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore, reference_from_samples

pytestmark = [
    pytest.mark.models,
    pytest.mark.skipif(
        os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1", reason="set MAX_SPEECH_MODEL_TESTS=1"
    ),
    pytest.mark.skipif(detect_profile() != "mlx", reason="Qwen3-TTS voice design runs on Apple Silicon only"),
]

SAMPLE = "Hello! This is how I sound when I read a few sentences aloud, so you can hear my voice."
NEW = "The meeting has been moved to Thursday afternoon, so please update your calendar."
MALE = "A deep, low-pitched older male voice"
FEMALE = "A bright young female voice"


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    off = {"vad_model": "off", "turn_model": "off", "stream_stt_model": "off"}
    engines = build_engines(Settings(**off), "mlx")
    assert engines.cloning is not None and engines.design is not None
    assert not engines.design.loaded  # building the engine does not read 4.5 GB of weights
    engines.cloning.warm_up()
    root = tmp_path_factory.mktemp("voices")
    store = VoiceStore(root / "voices")
    router = VoiceRouter(engines.tts, engines.cloning, store, Lexicon(root / "lexicon.json"))
    yield engines, store, router
    engines.design.close()


def test_designed_voices_differ_and_a_saved_one_speaks_new_text(stack):
    from bench.latency import wer

    engines, store, router = stack
    male = engines.design.design(MALE, SAMPLE, "en", 1)
    assert engines.design.loaded
    female = engines.design.design(FEMALE, SAMPLE, "en", 2)
    again = engines.design.design(MALE, SAMPLE, "en", 1)
    assert np.array_equal(male, again), "the same seed, text and description must repeat"
    rate = engines.design.sample_rate
    f0_male, f0_female = _median_f0(male, rate), _median_f0(female, rate)
    assert f0_male < f0_female, (f0_male, f0_female)

    voice = store.create_designed(
        audio=reference_from_samples(male, rate),
        name="Grandpa",
        transcript=SAMPLE,
        description=MALE,
        seed=1,
        model=engines.design.model_id,
        languages="en",
        gender="male",
    )
    audio = np.concatenate(list(router.synthesize(NEW, voice.id)))
    heard = engines.stt.transcribe(resample(audio, router.sample_rate, INPUT_RATE), INPUT_RATE, language="en")
    assert wer(NEW, heard.text) <= 0.15, heard.text
