"""MOSS-TTS-Nano cloning engine: pure logic with fakes, plus real-model checks (MAX_SPEECH_MODEL_TESTS=1)."""

from __future__ import annotations

import json
import os
import resource
import time
from pathlib import Path

import numpy as np
import pytest

from max_speech.engines import moss_onnx as m
from max_speech.engines.base import ReferenceVoice

CFG = {
    "n_vq": 4,
    "audio_pad_token_id": 99,
    "audio_start_token_id": 6,
    "audio_end_token_id": 7,
    "audio_user_slot_token_id": 8,
    "audio_assistant_slot_token_id": 9,
}
TEMPLATES = {
    "user_prompt_prefix_token_ids": [100, 101],
    "user_prompt_after_reference_token_ids": [102],
    "assistant_prompt_prefix_token_ids": [103, 104],
}


def words(text: str) -> int:
    return len(text.split()) + sum(1 for c in text if m._is_cjk(c))


# ---- text splitting ---------------------------------------------------------------------------------------------


def test_split_keeps_short_text_whole():
    assert m.split_text("Hello there. How are you?", words, 75) == ["Hello there. How are you?"]


def test_split_respects_budget_at_sentence_ends():
    text = "One two three. Four five six. Seven eight nine."
    assert m.split_text(text, words, 6) == ["One two three. Four five six.", "Seven eight nine."]


def test_split_falls_back_to_clauses_then_words():
    clauses = m.split_text("a b c d, e f g h, i j k l", words, 4)
    assert clauses == ["a b c d,", "e f g h,", "i j k l"]
    hard = m.split_text("a b c d e f g h i j", words, 4)
    assert hard == ["a b c d", "e f g h", "i j"]
    assert all(words(p) <= 4 for p in hard)


def test_split_does_not_cut_decimals_or_abbreviations_midword():
    assert m.split_text("It costs 3.5 dollars.", words, 3) == ["It costs 3.5", "dollars."]


def test_split_chinese_without_spaces():
    pieces = m.split_text("今天天气很好。我们去公园散步吧。", words, 10)
    assert pieces == ["今天天气很好。", "我们去公园散步吧。"]
    assert (
        "".join(m.split_text("今天天气很好，我们去公园散步吧，然后回家。", words, 6))
        == "今天天气很好，我们去公园散步吧，然后回家。"
    )


def test_split_empty_and_whitespace():
    assert m.split_text("  \n ", words) == []


def test_pause_longer_after_short_pieces():
    assert m.pause_seconds("Yes.") > m.pause_seconds("This one has quite a few more words.")


# ---- prompt, sampler inputs, streaming budget --------------------------------------------------------------------


def test_prompt_rows_layout():
    codes = np.array([[1, 2, 3, 4], [5, 6, 7, 8]])
    rows = m.build_prompt_rows(codes, [50, 51], CFG, TEMPLATES)
    assert rows.dtype == np.int32 and rows.shape[1] == 5
    assert rows[:, 0].tolist() == [100, 101, 6, 8, 8, 7, 102, 50, 51, 103, 104, 6]
    assert rows[3, 1:].tolist() == [1, 2, 3, 4] and rows[4, 1:].tolist() == [5, 6, 7, 8]
    assert (rows[0, 1:] == 99).all() and (rows[-1, 1:] == 99).all()


def test_frame_row_and_repetition_mask():
    row = m.frame_row([1, 2, 3, 4], CFG)
    assert row.shape == (1, 1, 5) and row[0, 0].tolist() == [9, 1, 2, 3, 4]
    mask = m.repetition_mask([{0, 5}, set(), {2}, {7, 2000}], 8)
    assert mask.shape == (1, 4, 8)
    assert mask[0, 0].tolist() == [1, 0, 0, 0, 0, 1, 0, 0] and mask[0, 3, 7] == 1 and mask.sum() == 4


def test_random_uniforms_are_strictly_below_one():
    class One:
        def random(self, n):
            return np.ones(n)

    assistant, audio = m.random_uniforms(One(), 4)
    assert assistant.shape == (1,) and audio.shape == (1, 4)
    assert assistant.dtype == np.float32 and float(audio.max()) < 1.0


def test_random_uniforms_seeded_reproducible():
    a = m.random_uniforms(np.random.default_rng(3), 16)
    b = m.random_uniforms(np.random.default_rng(3), 16)
    assert np.array_equal(a[1], b[1])


@pytest.mark.parametrize(("lead", "frames"), [(None, 1), (0.0, 1), (0.3, 2), (0.8, 4), (2.0, 8), (-1.0, 1)])
def test_decode_budget_grows_with_lead(lead, frames):
    assert m.decode_budget(lead) == frames


def test_to_mono_averages_channels_and_trims():
    audio = np.stack([np.ones(10), -np.ones(10) * 0.5])[None].astype(np.float32)
    out = m.to_mono(audio, 6)
    assert out.shape == (6,) and out.dtype == np.float32 and np.allclose(out, 0.25)


def test_prepare_reference_resamples_duplicates_and_caps():
    audio = np.random.default_rng(0).standard_normal(24000 * 20).astype(np.float32)
    wave = m.prepare_reference(audio, 24000, 48000, 2)
    assert wave.shape == (1, 2, int(m.MAX_REFERENCE_S * 48000)) and wave.dtype == np.float32
    assert np.array_equal(wave[0, 0], wave[0, 1])


# ---- the engine with fake graphs ---------------------------------------------------------------------------------


class FakeSession:
    def __init__(self, fn):
        self.fn = fn
        self.calls = []

    def run(self, _names, feeds):
        self.calls.append(feeds)
        return self.fn(feeds)


class FakeSp:
    def encode(self, text, out_type=int):
        return [10 + len(w) for w in text.split()]


class FakeStream:
    def __init__(self):
        self.batches = []
        self.resets = 0

    def reset(self):
        self.resets += 1

    def decode(self, frames):
        self.batches.append(len(frames))
        return np.full(len(frames) * 4, 0.1, dtype=np.float32)


def make_engine(tmp_path: Path, frames_per_piece: int = 3):
    (tmp_path / "browser_poc_manifest.json").write_text(
        json.dumps({"tts_config": CFG, "prompt_templates": TEMPLATES})
    )
    tts_meta = {
        "files": {},
        "model_config": {"audio_codebook_sizes": [16] * 4},
        "onnx": {
            "prefill_output_names": ["global_hidden", "present_key_0", "present_value_0"],
            "decode_input_names": ["input_ids", "past_valid_lengths", "past_key_0", "past_value_0"],
            "decode_output_names": ["global_hidden", "present_key_0", "present_value_0"],
        },
    }
    (tmp_path / "tts_browser_onnx_meta.json").write_text(json.dumps(tts_meta))
    (tmp_path / "codec_browser_onnx_meta.json").write_text(
        json.dumps({"codec_config": {"sample_rate": 48000, "channels": 2, "num_quantizers": 4}})
    )
    engine = m.MossNanoCloning(tmp_path, tmp_path, seed=0)
    state = {"n": 0}

    def prefill(feeds):
        n = feeds["input_ids"].shape[1]
        return [
            np.zeros((1, n, 8), np.float32),
            np.zeros((1, n, 1, 1), np.float32),
            np.zeros((1, n, 1, 1), np.float32),
        ]

    def decode(feeds):
        n = feeds["past_key_0"].shape[1] + 1
        return [
            np.zeros((1, 1, 8), np.float32),
            np.zeros((1, n, 1, 1), np.float32),
            np.zeros((1, n, 1, 1), np.float32),
        ]

    def frame(feeds):
        state["n"] += 1
        go = state["n"] % (frames_per_piece + 1) != 0
        return [np.array([[1 if go else 0]], np.int32), np.arange(4, dtype=np.int32)[None] + state["n"]]

    def encode(feeds):
        n = feeds["waveform"].shape[-1] // 3840
        return [np.arange(n * 4, dtype=np.int32).reshape(1, n, 4) % 16, np.array([n], np.int32)]

    engine._sessions = {
        "prefill": FakeSession(prefill),
        "decode": FakeSession(decode),
        "frame": FakeSession(frame),
        "encode": FakeSession(encode),
    }
    engine._sp = FakeSp()
    engine._stream = FakeStream()
    return engine


def voice(seconds: float = 1.0, rate: int = 24000) -> ReferenceVoice:
    return ReferenceVoice(id="v", audio=np.zeros(int(seconds * rate), np.float32), rate=rate, transcript="x")


def test_engine_attributes(tmp_path):
    e = make_engine(tmp_path)
    assert e.id == "moss-tts-nano" and e.model_id == "moss-tts-nano-onnx" and e.sample_rate == 48000
    assert {"zh", "en"} <= set(e.languages)


def test_reference_encoded_once_and_cached_on_the_voice(tmp_path):
    e = make_engine(tmp_path)
    v = voice()
    first = e.encode_reference(v)
    assert first.shape == (12, 4) and m.CACHE_KEY in v.cache
    list(e.synthesize_cloned("Hello there.", v))
    list(e.synthesize_cloned("Another one.", v))
    assert len(e._sessions["encode"].calls) == 1


def test_too_short_reference_is_rejected(tmp_path):
    e = make_engine(tmp_path)
    with pytest.raises(ValueError, match="too short"):
        e.encode_reference(voice(0.01))


def test_generation_stops_when_model_says_stop_and_streams_in_small_batches(tmp_path):
    e = make_engine(tmp_path, frames_per_piece=3)
    chunks = list(e.synthesize_cloned("Hello there.", voice()))
    assert len(e._sessions["frame"].calls) == 4  # 3 frames and the stop
    assert len(e._sessions["decode"].calls) == 3
    assert e._stream.batches[0] == 1  # first chunk after a single frame
    assert sum(len(c) for c in chunks) == 3 * 4
    assert all(c.dtype == np.float32 for c in chunks)


def test_decode_step_gets_growing_valid_length_and_frame_row(tmp_path):
    e = make_engine(tmp_path)
    list(e.synthesize_cloned("Hello there.", voice()))
    calls = e._sessions["decode"].calls
    prompt_len = len(e._sessions["prefill"].calls[0]["input_ids"][0])
    assert [int(c["past_valid_lengths"][0]) for c in calls] == [prompt_len, prompt_len + 1, prompt_len + 2]
    assert calls[0]["input_ids"][0, 0, 0] == CFG["audio_assistant_slot_token_id"]


def test_repetition_mask_accumulates_across_frames(tmp_path):
    e = make_engine(tmp_path)
    list(e.synthesize_cloned("Hello there.", voice()))
    masks = [c["repetition_seen_mask"].sum() for c in e._sessions["frame"].calls]
    assert masks == [0, 4, 8, 12]


def test_long_text_gets_one_prompt_per_piece_with_silence_between(tmp_path):
    e = make_engine(tmp_path)
    text = " ".join(["word"] * 60) + ". " + " ".join(["more"] * 60) + "."
    chunks = list(e.synthesize_cloned(text, voice()))
    assert len(e._sessions["prefill"].calls) == 2
    silence = [c for c in chunks if not c.any()]
    assert len(silence) == 1 and len(silence[0]) == round(0.24 * 48000)
    assert e._stream.resets >= 4  # reset before and after each piece


def test_empty_text_yields_nothing(tmp_path):
    e = make_engine(tmp_path)
    assert list(e.synthesize_cloned("   ", voice())) == []
    assert not e._sessions["prefill"].calls


def test_frame_cap_scales_with_tokens_and_never_exceeds_the_ceiling():
    assert m.frame_cap(1) == 33 and m.frame_cap(10) == 105
    assert m.frame_cap(75) == m.MAX_NEW_FRAMES  # a full piece keeps the whole 30 s


def test_a_piece_that_never_stops_is_cut_at_the_cap(tmp_path):
    e = make_engine(tmp_path, frames_per_piece=10**9)  # the fake never says stop
    assert list(e.synthesize_cloned("Hi", voice()))
    assert sum(e._stream.batches) == m.frame_cap(1)  # FakeSp counts "Hi" as one token


def test_pieces_without_letters_or_digits_are_skipped(tmp_path):
    e = make_engine(tmp_path)
    assert list(e.synthesize_cloned("😊 ... !?", voice())) == []
    assert not e._sessions["prefill"].calls


# ---- real models -------------------------------------------------------------------------------------------------

REF_TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs, and then we walked home slowly."
EN = [
    "The weather is lovely today, so we decided to walk to the park.",
    "Please remember to bring your umbrella tomorrow morning.",
]
REF_ZH = "今天天气很好，我们一起去公园散步，然后在湖边喝一杯热茶，聊聊最近发生的有趣的事情。"
ZH = ["今天天气很好，我们一起去公园散步吧。", "请你明天早上记得带上雨伞。"]


def _model_dirs() -> tuple[Path, Path]:
    from max_speech.licenses import require
    from max_speech.models import ensure_model
    from max_speech.settings import Settings

    dirs = []
    for model_id in ("moss-tts-nano-onnx", "moss-audio-tokenizer-nano-onnx"):
        try:
            entry = require(model_id, "tts")
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"{model_id} is not in the registry yet: {exc}")
        dirs.append(ensure_model(entry, Settings().models_dir))
    return dirs[0], dirs[1]


@pytest.fixture(scope="module")
def real_engine():
    if os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1":
        pytest.skip("set MAX_SPEECH_MODEL_TESTS=1")
    tts_dir, codec_dir = _model_dirs()
    engine = m.MossNanoCloning(tts_dir, codec_dir, seed=7)
    engine.warm_up()
    return engine


@pytest.fixture(scope="module")
def preset_and_stt():
    """Kokoro (preset voices) and the profile's default Whisper, so this runs on Linux as well as macOS."""
    if os.environ.get("MAX_SPEECH_MODEL_TESTS") != "1":
        pytest.skip("set MAX_SPEECH_MODEL_TESTS=1")
    from max_speech.engines.select import build_engines
    from max_speech.profile import detect_profile
    from max_speech.settings import Settings

    off = {"vad_model": "off", "turn_model": "off", "stream_stt_model": "off", "cloning_model": "off"}
    engines = build_engines(Settings(**off), detect_profile())
    return engines.tts, engines.stt


@pytest.fixture(scope="module")
def references(preset_and_stt) -> dict[str, ReferenceVoice]:
    """One Kokoro-made reference per language: a cross-language reference makes the Chinese output unreliable."""
    tts, _ = preset_and_stt
    out = {}
    for lang, text in (("en", REF_TEXT), ("zh", REF_ZH)):
        audio = np.concatenate(list(tts.synthesize(text, tts.default_voice("female", lang), language=lang)))
        out[lang] = ReferenceVoice(f"kokoro-{lang}", audio, tts.sample_rate, text, lang)
    return out


@pytest.fixture(scope="module")
def reference(references) -> ReferenceVoice:
    return references["en"]


@pytest.fixture(scope="module")
def stt(preset_and_stt):
    return preset_and_stt[1]


@pytest.mark.models
def test_real_clone_round_trip(real_engine, references, stt):
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from bench.latency import cer, wer

    report = {}
    t0 = time.perf_counter()
    real_engine.encode_reference(references["en"])
    report["encode_s"] = round(time.perf_counter() - t0, 3)
    for lang, sentences, score in (("en", EN, wer), ("zh", ZH, cer)):
        errors, firsts, rtfs = [], [], []
        reference = references[lang]
        for sentence in sentences:
            start = time.perf_counter()
            chunks, first = [], None
            for chunk in real_engine.synthesize_cloned(sentence, reference):
                first = first if first is not None else time.perf_counter() - start
                chunks.append(chunk)
            took = time.perf_counter() - start
            audio = np.concatenate(chunks)
            assert audio.dtype == np.float32 and 0.1 < np.abs(audio).max() <= 1.5
            seconds = len(audio) / real_engine.sample_rate
            firsts.append(first)
            rtfs.append(took / seconds)
            heard = stt.transcribe(audio, real_engine.sample_rate, language=lang).text
            errors.append(score(sentence, heard))
        report[lang] = {"error": errors, "first_chunk_s": firsts, "rtf": rtfs}
    report["peak_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS
    print("\nMOSS-TTS-Nano:", json.dumps(report, indent=1))
    # The mean, not the worst sentence: one short Chinese sentence in two sometimes loses a character or two.
    for lang in ("en", "zh"):
        assert sum(report[lang]["error"]) / len(report[lang]["error"]) <= 0.2, report


@pytest.mark.models
def test_real_frame_cap_is_generous_for_normal_speech(real_engine, reference):
    long_en = (
        "When the committee finally met on Thursday afternoon, nobody expected the discussion to run so long, "
        "but every member had a different opinion about the budget."
    )
    ratios = []
    for text in (*EN, *ZH, long_en):
        ids = real_engine._sp.encode(text, out_type=int)
        rows = m.build_prompt_rows(
            real_engine.encode_reference(reference), ids, real_engine._cfg, real_engine._templates
        )
        frames = sum(1 for _ in real_engine._frames(rows, m.MAX_NEW_FRAMES))
        ratios.append(frames / m.frame_cap(len(ids)))
    print("\nframes / cap:", [round(r, 2) for r in ratios])
    assert max(ratios) < 0.6, ratios  # normal speech uses well under the cap
