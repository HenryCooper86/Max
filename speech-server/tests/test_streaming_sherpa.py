"""SherpaStreamingStt logic against a fake recognizer, plus real-model tests (models marker)."""

from __future__ import annotations

import os
import threading

import numpy as np
import pytest

from max_speech.engines import streaming_sherpa
from max_speech.engines.streaming_sherpa import SherpaStreamingStt


class FakeSherpaStream:
    def __init__(self):
        self.waves: list[tuple[int, np.ndarray]] = []
        self.finished = False

    def accept_waveform(self, rate, audio):
        assert not self.finished, "accept after input_finished"
        self.waves.append((rate, audio))

    def input_finished(self):
        self.finished = True


class FakeRecognizer:
    """Becomes ready after every accepted chunk and 'decodes' one word per chunk."""

    def __init__(self):
        self.streams: list[FakeSherpaStream] = []
        self.decoded: dict[int, int] = {}
        self.in_decode = 0
        self.max_concurrent = 0

    def create_stream(self):
        s = FakeSherpaStream()
        self.streams.append(s)
        self.decoded[id(s)] = 0
        return s

    def is_ready(self, s):
        return self.decoded[id(s)] < len(s.waves)

    def decode_stream(self, s):
        self.in_decode += 1
        self.max_concurrent = max(self.max_concurrent, self.in_decode)
        self.decoded[id(s)] += 1
        self.in_decode -= 1

    def get_result(self, s):
        # Plain str in sherpa-onnx 2.x; the engine must also accept objects with .text.
        n = self.decoded[id(s)]
        words = ["hello", "there", "friend", "tail"]
        return " ".join(words[: min(n, 3)] if not s.finished else words[:n])


@pytest.fixture
def rec(monkeypatch):
    r = FakeRecognizer()
    monkeypatch.setattr(streaming_sherpa, "_build_recognizer", lambda model_dir, kind: r)
    return r


def chunk(n=1600):
    return np.zeros(n, dtype=np.float32)


def test_identity(rec, tmp_path):
    engine = SherpaStreamingStt(tmp_path, "transducer", model_id="x-asr-zh-en-480ms")
    assert engine.id == "sherpa-onnx"
    assert engine.model_id == "x-asr-zh-en-480ms"


def test_accept_returns_text_only_when_it_changes(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    assert stream.accept(chunk()) == "hello"
    assert stream.accept(chunk()) == "hello there"
    assert stream.accept(chunk()) == "hello there friend"
    assert stream.accept(chunk()) is None  # capped at 3 words by the fake: unchanged
    assert rec.streams[0].waves[0][0] == 16000


def test_accept_decodes_while_ready(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    stream.accept(np.zeros(1600, dtype=np.float32))
    assert rec.decoded[id(rec.streams[0])] == 1


def test_accept_casts_to_float32(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    stream.accept(np.zeros(160, dtype=np.float64))
    assert rec.streams[0].waves[0][1].dtype == np.float32


def test_finish_pads_the_tail_and_returns_final_text(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    stream.accept(chunk())
    text = stream.finish()
    s = rec.streams[0]
    assert s.finished
    rate, pad = s.waves[-1]
    assert rate == 16000 and len(pad) == int(streaming_sherpa.TAIL_PAD_S * 16000) and not pad.any()
    assert streaming_sherpa.TAIL_PAD_S >= 1.0  # less loses the last word (see the real-model test)
    assert text == "hello there"


def test_finish_with_no_audio_is_empty_or_text(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    assert stream.finish() == "hello"  # the pad chunk is decoded too


def test_reset_makes_a_fresh_sherpa_stream(rec, tmp_path):
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    stream.accept(chunk())
    stream.finish()
    stream.reset()
    assert len(rec.streams) == 2
    assert stream.accept(chunk()) == "hello"  # last-text tracking restarted too


def test_text_result_objects_are_supported(rec, tmp_path, monkeypatch):
    class Res:
        text = " hi "

    monkeypatch.setattr(rec, "get_result", lambda s: Res())
    stream = SherpaStreamingStt(tmp_path, "transducer", model_id="m").new_stream()
    assert stream.accept(chunk()) == "hi"


def test_keyterms_and_language_are_accepted_and_ignored(rec, tmp_path):
    engine = SherpaStreamingStt(tmp_path, "paraformer", model_id="m")
    assert engine.new_stream(language="zh", keyterms=("Max",)).accept(chunk()) == "hello"


def test_decoding_is_serialized_across_streams(rec, tmp_path):
    engine = SherpaStreamingStt(tmp_path, "transducer", model_id="m")
    streams = [engine.new_stream() for _ in range(4)]

    def run(s):
        for _ in range(20):
            s.accept(chunk(160))

    threads = [threading.Thread(target=run, args=(s,)) for s in streams]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert rec.max_concurrent == 1


def test_warm_up_runs_a_stream_through(rec, tmp_path):
    SherpaStreamingStt(tmp_path, "transducer", model_id="m").warm_up()
    assert rec.streams and rec.streams[0].finished


def test_unknown_kind_rejected(tmp_path):
    with pytest.raises(ValueError, match="kind"):
        SherpaStreamingStt(tmp_path, "nope", model_id="m")


def test_build_recognizer_wiring(tmp_path, monkeypatch):
    """The int8 files are picked, endpointing is off, and a bpe model switches the modeling unit."""
    import sherpa_onnx

    for name in ("tokens.txt", "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "bpe.model"):
        (tmp_path / name).write_text("x")
    seen = {}
    monkeypatch.setattr(
        sherpa_onnx.OnlineRecognizer, "from_transducer", classmethod(lambda cls, **kw: seen.update(kw))
    )
    streaming_sherpa._build_recognizer(tmp_path, "transducer")
    assert seen["encoder"].endswith("encoder.int8.onnx") and seen["joiner"].endswith("joiner.int8.onnx")
    assert seen["decoder"].endswith("decoder.onnx")
    assert seen["enable_endpoint_detection"] is False and seen["num_threads"] == 2
    assert seen["modeling_unit"] == "bpe" and seen["bpe_vocab"].endswith("bpe.model")


def test_build_recognizer_descends_into_a_single_top_level_dir(tmp_path, monkeypatch):
    import sherpa_onnx

    inner = tmp_path / "sherpa-onnx-streaming-thing"
    inner.mkdir()
    for name in ("tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx"):
        (inner / name).write_text("x")
    seen = {}
    monkeypatch.setattr(
        sherpa_onnx.OnlineRecognizer, "from_paraformer", classmethod(lambda cls, **kw: seen.update(kw))
    )
    streaming_sherpa._build_recognizer(tmp_path, "paraformer")
    assert seen["encoder"] == str(inner / "encoder.int8.onnx")
    assert seen["enable_endpoint_detection"] is False


def test_build_recognizer_missing_files_is_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError, match="tokens.txt"):
        streaming_sherpa._build_recognizer(tmp_path, "transducer")


# ---- real models -----------------------------------------------------------------------------------------------

real = pytest.mark.skipif(
    os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1", reason="set MAX_SPEECH_MODEL_TESTS=1"
)


def _wer(ref: str, hyp: str, chars: bool = False) -> float:
    import re

    def norm(t):
        t = re.sub(r"[^\w\s]", "", t.lower())
        return list(t.replace(" ", "")) if chars else t.split()

    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
    return d[-1] / max(len(r), 1)


@pytest.fixture(scope="module")
def real_engines():
    from max_speech.engines.select import build_engines
    from max_speech.settings import Settings

    settings = Settings(stt_engine="off", vad_model="off", turn_model="off")
    eng = build_engines(settings, "cpu")
    return eng.stt_stream, eng.tts


@pytest.mark.models
@real
@pytest.mark.parametrize(
    ("text", "lang", "chars", "limit"),
    [
        ("Hello there. How are you doing today?", "en", False, 0.2),
        ("你好，今天天气很好，我们去公园散步吧。", "zh", True, 0.2),
    ],
)
def test_streaming_transcription_of_kokoro_speech(real_engines, text, lang, chars, limit):
    from max_speech.audio import resample

    stt_stream, tts = real_engines
    audio = np.concatenate(list(tts.synthesize(text, tts.default_voice("female", lang), language=lang)))
    audio = resample(audio, tts.sample_rate, 16000).astype(np.float32)
    stream = stt_stream.new_stream(language=lang)
    partials = []
    for i in range(0, len(audio), 1600):  # 100 ms
        got = stream.accept(audio[i : i + 1600])
        if got:
            partials.append(got)
    assert partials, "no partial before the end of the audio"
    final = stream.finish()
    assert _wer(text, final, chars) <= limit, (text, final)
    stream.reset()
    assert stream.finish() == ""


@pytest.mark.models
@real
@pytest.mark.parametrize(
    ("text", "lang", "last"),
    [
        ("What is the capital of France?", "en", "france"),
        ("Tell me a fun fact about the moon.", "en", "moon"),
        ("Set a timer for ten minutes, please.", "en", "please"),
        ("今天天气怎么样？", "zh", "样"),
    ],
)
def test_finish_keeps_the_last_word_when_the_turn_ends_early(real_engines, text, lang, last):
    """The session ends a turn ~120-200 ms into the quiet after speech, so `finish` must flush the model's
    lookahead itself: with too little tail padding the streaming model drops the final word."""
    from max_speech.audio import resample

    stt_stream, tts = real_engines
    audio = np.concatenate(list(tts.synthesize(text, tts.default_voice("female", lang), language=lang)))
    audio = resample(audio, tts.sample_rate, 16000).astype(np.float32)
    voiced = np.flatnonzero(np.abs(audio) > 0.01)
    audio = np.concatenate([audio[: voiced[-1] + 1], np.zeros(int(0.12 * 16000), np.float32)])
    stream = stt_stream.new_stream(language=lang)
    for i in range(0, len(audio), 512):
        stream.accept(audio[i : i + 512])
    final = stream.finish()
    assert last in final.lower(), (text, final)


def test_the_engine_declares_what_it_can_transcribe():
    from max_speech.engines.streaming_sherpa import SherpaStreamingStt

    assert SherpaStreamingStt.languages == ("zh", "en")
    assert SherpaStreamingStt.keyterms is False
