import numpy as np
import pytest
from voice_helpers import STATEMENT, good_wav

from max_speech.engines.base import UnknownVoiceError
from max_speech.engines.fake import FakeTts
from max_speech.engines.fake_cloning import FakeCloningTts, pitch_for
from max_speech.engines.router import VoiceRouter
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore


@pytest.fixture
def parts(tmp_path):
    store = VoiceStore(tmp_path / "voices")
    voice = store.create(
        audio=good_wav(),
        name="Ava",
        transcript="hello there",
        languages="en",
        gender="female",
        consent=True,
        consent_statement=STATEMENT,
        consent_speaker="Ava Lee",
    )
    return store, voice, Lexicon()


def run(router, text, voice, **kw):
    return list(router.synthesize(text, voice, **kw))


def dominant_hz(chunks, rate):
    x = np.concatenate(chunks)
    spectrum = np.abs(np.fft.rfft(x))
    return np.argmax(spectrum) * rate / len(x)


def test_follows_the_preset_engine(parts):
    store, _, lexicon = parts
    preset = FakeTts()
    r = VoiceRouter(preset, FakeCloningTts(), store, lexicon)
    assert (r.id, r.model_id, r.sample_rate) == ("fake", "fake-tts", 22050)
    assert r.preset is preset and isinstance(r.cloning, FakeCloningTts)
    assert r.default_voice("male") == "bravo" and r.default_voice("female", "zh") == "bravo"


def test_voices_include_custom_only_when_cloning_is_loaded(parts):
    store, voice, lexicon = parts
    with_cloning = VoiceRouter(FakeTts(), FakeCloningTts(), store, lexicon)
    ids = [v.id for v in with_cloning.voices()]
    assert ids == ["alpha", "bravo", voice.id]
    info = with_cloning.voices()[-1]
    assert (info.name, info.languages, info.gender) == ("Ava", ("en",), "female")
    assert [v.id for v in VoiceRouter(FakeTts(), None, store, lexicon).voices()] == ["alpha", "bravo"]


def test_preset_voice_goes_to_the_preset_engine(parts):
    store, _, lexicon = parts
    cloning = FakeCloningTts()
    r = VoiceRouter(FakeTts(), cloning, store, lexicon)
    chunks = run(r, "Hello there.", "alpha")
    assert dominant_hz(chunks, 22050) == pytest.approx(440, abs=6)
    assert cloning.calls == []


def test_custom_voice_goes_to_the_cloning_engine_and_is_resampled(parts):
    store, voice, lexicon = parts
    cloning = FakeCloningTts()
    r = VoiceRouter(FakeTts(), cloning, store, lexicon)
    chunks = run(r, "Hello there.", voice.id, language="en")
    assert cloning.calls == [("Hello there.", voice.id, "en")]
    # 0.2 s at the cloning engine's 16 kHz becomes 0.2 s at the preset's 22.05 kHz
    assert len(chunks[0]) == round(0.2 * 22050)
    assert dominant_hz(chunks, 22050) == pytest.approx(pitch_for(voice.id), abs=8)


def test_pitch_depends_on_the_voice(parts):
    store, voice, _ = parts
    other = store.create(
        audio=good_wav(),
        name="B",
        transcript="x y",
        consent=True,
        consent_statement=STATEMENT,
        consent_speaker="B",
    )
    assert pitch_for(voice.id) != pitch_for(other.id)


def test_same_rate_is_not_resampled(parts):
    store, voice, lexicon = parts

    class Same(FakeCloningTts):
        sample_rate = 22050

    chunks = run(VoiceRouter(FakeTts(), Same(), store, lexicon), "Hello there.", voice.id)
    assert len(chunks[0]) == round(0.2 * 22050)


def test_custom_voice_without_cloning_is_unknown(parts):
    store, voice, lexicon = parts
    r = VoiceRouter(FakeTts(), None, store, lexicon)
    with pytest.raises(UnknownVoiceError, match="cloning is not available"):
        run(r, "Hello.", voice.id)


def test_unknown_and_deleted_custom_voices(parts):
    store, voice, lexicon = parts
    r = VoiceRouter(FakeTts(), FakeCloningTts(), store, lexicon)
    with pytest.raises(UnknownVoiceError):
        run(r, "Hello.", "v_0000000000")
    with pytest.raises(UnknownVoiceError):
        run(r, "Hello.", "nobody")
    store.delete(voice.id)
    with pytest.raises(UnknownVoiceError):
        run(r, "Hello.", voice.id)


def test_lexicon_applies_to_both_engines(parts):
    store, voice, lexicon = parts
    lexicon.replace({"MAX": "Max speech"})
    seen = []

    class Spy(FakeTts):
        def synthesize(self, text, voice, **kw):
            seen.append(text)
            yield from super().synthesize(text, voice, **kw)

    cloning = FakeCloningTts()
    r = VoiceRouter(Spy(), cloning, store, lexicon)
    run(r, "hi MAX", "alpha")
    run(r, "hi MAX", voice.id)
    assert seen == ["hi Max speech"] and cloning.calls[0][0] == "hi Max speech"


def test_reference_analysis_is_cached_across_calls(parts):
    store, voice, lexicon = parts
    cloning = FakeCloningTts()
    r = VoiceRouter(FakeTts(), cloning, store, lexicon)
    run(r, "one", voice.id)
    run(r, "two", voice.id)
    assert cloning.analyses == 1
    store.update(voice.id, transcript="changed transcript")
    run(r, "three", voice.id)
    assert cloning.analyses == 2


def test_other_attributes_come_from_the_preset(parts):
    store, _, lexicon = parts
    preset = FakeTts()
    preset.extra_model_ids = ("m",)
    assert VoiceRouter(preset, None, store, lexicon).extra_model_ids == ("m",)


def test_warm_up_warms_both(parts):
    store, _, lexicon = parts
    warmed = []

    class P(FakeTts):
        def warm_up(self):
            warmed.append("p")

    class C(FakeCloningTts):
        def warm_up(self):
            warmed.append("c")

    VoiceRouter(P(), C(), store, lexicon).warm_up()
    assert warmed == ["p", "c"]


class _Recording(FakeTts):
    def __init__(self):
        self.calls = []

    def synthesize(self, text, voice, **kw):
        self.calls.append(text)
        return super().synthesize(text, voice, **kw)


@pytest.mark.parametrize("text", ["😊", "...", "   ", "😊 ... !?"])
def test_unspeakable_text_is_skipped_for_every_engine(parts, text):
    store, voice, lexicon = parts
    preset, cloning = _Recording(), FakeCloningTts()
    r = VoiceRouter(preset, cloning, store, lexicon)
    assert run(r, text, "alpha") == [] and run(r, text, voice.id) == []
    assert preset.calls == [] and cloning.calls == []


def test_unspeakable_sentences_are_dropped_but_the_rest_is_spoken(parts):
    store, voice, lexicon = parts
    preset, cloning = _Recording(), FakeCloningTts()
    r = VoiceRouter(preset, cloning, store, lexicon)
    assert run(r, "Hello there.\n😊\nBye now.", "alpha")
    assert run(r, "Hello there.\n😊\nBye now.", voice.id)
    assert preset.calls == ["Hello there.", "Bye now."] and [c[0] for c in cloning.calls] == preset.calls


def test_downsampled_cloned_audio_is_streamed_without_glitches(parts):
    store, voice, lexicon = parts

    class Hi(FakeCloningTts):
        sample_rate = 48_000

        def synthesize_cloned(self, text, reference, **kw):
            t = np.arange(4800 * 3) / 48_000
            x = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
            for i in range(0, len(x), 1000):
                yield x[i : i + 1000]

    r = VoiceRouter(FakeTts(), Hi(), store, lexicon)
    out = np.concatenate(run(r, "Hello there.", voice.id))
    assert abs(len(out) - 4800 * 3 * 22050 / 48_000) <= 2
    assert np.max(np.abs(np.diff(out))) < 0.5 * 2 * np.pi * 1000 / 22050 * 1.2
