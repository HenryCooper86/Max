import os
import threading

import numpy as np
import pytest

from max_speech.engines.silero_vad import SileroVad


class FakeSession:
    """Echoes a counter into the state so tests can see it threaded from call to call."""

    def __init__(self):
        self.calls = []
        self.in_run = 0
        self.max_in_run = 0

    def run(self, _outputs, feeds):
        self.in_run += 1
        self.max_in_run = max(self.max_in_run, self.in_run)
        self.calls.append(
            {"input": feeds["input"].copy(), "state": feeds["state"].copy(), "sr": feeds["sr"].copy()}
        )
        state = feeds["state"] + 1.0
        self.in_run -= 1
        return [np.array([[0.25 * len(self.calls)]], dtype=np.float32), state]


def frame(value: float) -> np.ndarray:
    return np.full(512, value, dtype=np.float32)


def test_stream_shape_and_first_call_inputs():
    session = FakeSession()
    stream = SileroVad(None, model_id="silero-test", session=session).new_stream()
    assert stream.frame_samples == 512
    assert stream.probability(frame(0.1)) == pytest.approx(0.25)
    call = session.calls[0]
    assert call["input"].shape == (1, 576) and call["input"].dtype == np.float32
    assert not call["input"][0, :64].any()  # context starts at zero
    assert np.allclose(call["input"][0, 64:], 0.1)
    assert call["state"].shape == (2, 1, 128) and not call["state"].any()
    assert call["sr"].dtype == np.int64 and int(call["sr"]) == 16000 and call["sr"].shape == ()


def test_state_and_context_thread_through_calls():
    session = FakeSession()
    stream = SileroVad(None, model_id="silero-test", session=session).new_stream()
    first = np.arange(512, dtype=np.float32) / 1000
    stream.probability(first)
    stream.probability(frame(0.5))
    second = session.calls[1]
    assert np.allclose(second["state"], 1.0)
    assert np.array_equal(second["input"][0, :64], first[-64:])


def test_reset_zeroes_state_and_context():
    session = FakeSession()
    stream = SileroVad(None, model_id="silero-test", session=session).new_stream()
    stream.probability(frame(0.3))
    stream.probability(frame(0.3))
    stream.reset()
    stream.probability(frame(0.3))
    last = session.calls[-1]
    assert not last["state"].any()
    assert not last["input"][0, :64].any()


def test_streams_have_independent_state():
    session = FakeSession()
    vad = SileroVad(None, model_id="silero-test", session=session)
    a, b = vad.new_stream(), vad.new_stream()
    a.probability(frame(0.2))
    a.probability(frame(0.2))
    b.probability(frame(0.9))
    assert not session.calls[2]["state"].any()
    assert not session.calls[2]["input"][0, :64].any()


def test_wrong_frame_size_rejected():
    stream = SileroVad(None, model_id="silero-test", session=FakeSession()).new_stream()
    with pytest.raises(ValueError):
        stream.probability(np.zeros(100, dtype=np.float32))


def test_session_calls_are_serialized_across_streams():
    class SlowSession(FakeSession):
        def run(self, outputs, feeds):
            import time

            self.in_run += 1
            self.max_in_run = max(self.max_in_run, self.in_run)
            time.sleep(0.002)
            self.in_run -= 1
            return [np.array([[0.5]], dtype=np.float32), feeds["state"]]

    session = SlowSession()
    vad = SileroVad(None, model_id="silero-test", session=session)

    def work():
        stream = vad.new_stream()
        for _ in range(10):
            stream.probability(frame(0.1))

    threads = [threading.Thread(target=work) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert session.max_in_run == 1


# ---- real model ---------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_vad():
    from max_speech.licenses import require
    from max_speech.models import ensure_model
    from max_speech.settings import Settings

    entry = require("silero-vad-v6.2", "vad")
    return SileroVad(ensure_model(entry, Settings().models_dir), model_id=entry.id)


def _probabilities(vad: SileroVad, audio: np.ndarray) -> np.ndarray:
    stream = vad.new_stream()
    return np.array([stream.probability(audio[i : i + 512]) for i in range(0, len(audio) - 511, 512)])


@pytest.mark.models
@pytest.mark.skipif(os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1", reason="set MAX_SPEECH_MODEL_TESTS=1")
def test_real_model_hears_speech_and_silence(real_vad):
    from max_speech.audio import INPUT_RATE, resample
    from max_speech.engines.kokoro import KokoroTts
    from max_speech.licenses import require
    from max_speech.models import ensure_model
    from max_speech.settings import Settings

    entry = require("kokoro-v1.0", "tts")
    tts = KokoroTts(ensure_model(entry, Settings().models_dir), entry.id)
    speech = np.concatenate(list(tts.synthesize("Hello there. How are you doing today?", "af_heart")))
    speech = resample(speech, tts.sample_rate, INPUT_RATE).astype(np.float32)
    # Pad with silence so voiced and quiet frames are both present.
    padded = np.concatenate([np.zeros(8000, np.float32), speech, np.zeros(16000, np.float32)])

    probs = _probabilities(real_vad, padded)
    voiced = probs[8000 // 512 + 2 : (8000 + len(speech)) // 512 - 2]
    assert np.mean(voiced > 0.5) > 0.7

    silence = _probabilities(real_vad, np.zeros(16000, np.float32))
    assert silence.max() < 0.1
    tail = probs[-(8000 // 512) :]
    assert tail.max() < 0.35


def test_model_id_is_the_one_given():
    assert SileroVad(None, model_id="silero-vad-x", session=FakeSession()).model_id == "silero-vad-x"
