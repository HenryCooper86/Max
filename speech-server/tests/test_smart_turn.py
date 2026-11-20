import os
from pathlib import Path

import numpy as np
import pytest

from max_speech.engines.smart_turn import N_SAMPLES, SAMPLE_RATE, mel_filters, whisper_log_mel

FIXTURES = Path(__file__).parent / "fixtures"


def _sine(hz, seconds=1.0, amp=0.5):
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def test_feature_shape_and_dtype():
    feats = whisper_log_mel(_sine(440))
    assert feats.shape == (80, 800) and feats.dtype == np.float32
    assert whisper_log_mel(np.zeros(0, dtype=np.float32)).shape == (80, 800)
    assert whisper_log_mel(_sine(440, 12)).shape == (80, 800)


def test_short_audio_is_padded_at_the_start():
    feats = whisper_log_mel(_sine(1000, 1.0))
    # Padding sits first: the first 7 s are flat, the last second carries the sine.
    assert feats[:, :600].std(axis=1).max() < 0.05
    assert feats[:, 720:790].mean() > feats[:, :600].mean()


def test_long_audio_keeps_the_end():
    loud_then_quiet = np.concatenate([_sine(1000, 4.0, 0.9), np.zeros(8 * SAMPLE_RATE, np.float32)])
    quiet_then_loud = np.concatenate([np.zeros(8 * SAMPLE_RATE, np.float32), _sine(1000, 4.0, 0.9)])
    assert len(loud_then_quiet) > N_SAMPLES
    a, b = whisper_log_mel(loud_then_quiet), whisper_log_mel(quiet_then_loud)
    assert a.std() < 0.05  # the sine fell outside the kept 8 s, only silence is left
    assert b[:, 500:].mean() > b[:, :300].mean()
    # Truncation equals passing the last 8 s directly.
    np.testing.assert_array_equal(b, whisper_log_mel(quiet_then_loud[-N_SAMPLES:]))


def test_sine_energy_lands_in_the_expected_mel_band():
    feats = whisper_log_mel(_sine(1000, 8.0))
    peak = int(np.argmax(feats.mean(axis=1)))
    centres = np.argmax(mel_filters(), axis=0)  # fft bin of each filter's peak
    expected_bin = round(1000 / (SAMPLE_RATE / 400))
    assert abs(centres[peak] - expected_bin) <= 2


def test_values_stay_in_range_and_are_deterministic():
    rng = np.random.default_rng(1)
    audio = (0.2 * rng.standard_normal(3 * SAMPLE_RATE)).astype(np.float32)
    a, b = whisper_log_mel(audio), whisper_log_mel(audio)
    np.testing.assert_array_equal(a, b)
    assert np.isfinite(a).all()
    assert a.max() - a.min() <= 2.0 + 1e-5  # (x + 4) / 4 after clamping to max - 8
    assert a.min() >= (a.max() * 4 - 8) / 4 - 1e-5


def test_matches_the_transformers_reference_features():
    # Reference produced once with transformers' WhisperFeatureExtractor(chunk_length=8) on the start-padded signal.
    signal = np.load(FIXTURES / "smart_turn_signal_1s.npy")
    reference = np.load(FIXTURES / "smart_turn_features_ref.npy")
    assert np.abs(whisper_log_mel(signal) - reference).max() < 1e-4


class _FakeSession:
    def __init__(self):
        self.seen = None

    def run(self, names, feed):
        self.seen = feed["input_features"]
        return [np.array([[1.7]], dtype=np.float32)]


def test_turn_complete_feeds_features_and_clips_output():
    from max_speech.engines.smart_turn import SmartTurn

    turn = SmartTurn.__new__(SmartTurn)
    import threading

    turn._session, turn._lock = _FakeSession(), threading.Lock()
    assert turn.turn_complete(_sine(440)) == 1.0
    assert turn._session.seen.shape == (1, 80, 800)


# ---- real model ------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_turn_and_tts():
    from max_speech.engines.select import build_engines
    from max_speech.engines.smart_turn import SmartTurn
    from max_speech.licenses import load_registry
    from max_speech.models import ensure_model
    from max_speech.profile import detect_profile
    from max_speech.settings import Settings

    entry = load_registry().get("smart-turn-v3.2")
    if entry is None:
        pytest.skip("smart-turn-v3.2 is not in the model registry yet")
    settings = Settings()
    turn = SmartTurn(ensure_model(entry, settings.models_dir), model_id=entry.id)
    built = build_engines(settings, detect_profile())
    tts = built.tts if hasattr(built, "tts") else built[1]
    return turn, tts


def _spoken(tts, text):
    from max_speech.audio import INPUT_RATE, resample

    audio = np.concatenate(list(tts.synthesize(text, "af_heart")))
    audio = resample(audio, tts.sample_rate, INPUT_RATE).astype(np.float32)
    return np.concatenate([audio, np.zeros(int(0.2 * INPUT_RATE), np.float32)])


@pytest.mark.models
@pytest.mark.skipif(os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1", reason="set MAX_SPEECH_MODEL_TESTS=1")
def test_real_model_separates_complete_from_incomplete(real_turn_and_tts):
    turn, tts = real_turn_and_tts
    turn.warm_up()
    complete = turn.turn_complete(_spoken(tts, "What's the weather like today?"))
    incomplete = turn.turn_complete(_spoken(tts, "I want to go to the"))
    assert complete > 0.5, complete
    assert incomplete < 0.5, incomplete
