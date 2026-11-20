import json
import os
import shutil
import stat
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from voice_helpers import STATEMENT, good_wav, speech_like, wav_of

from max_speech.engines.base import UnknownVoiceError
from max_speech.voices.store import ID_RE, CustomVoice, VoiceError, VoiceStore, is_custom_id


def make(store, **kw):
    args = {
        "audio": good_wav(),
        "name": "Ava",
        "transcript": "hello there this is my voice",
        "consent": True,
        "consent_statement": STATEMENT,
        "consent_speaker": "Ava Lee",
        "created_by": "admin",
    }
    args.update(kw)
    return store.create(**args)


@pytest.fixture
def store(tmp_path):
    return VoiceStore(tmp_path / "voices")


def code(exc_info):
    return exc_info.value.code


# ---- create and persistence ------------------------------------------------------------------------------------
def test_create_stores_voice_json_and_reference(store, tmp_path):
    v = make(store, languages="en, zh", gender="female")
    assert ID_RE.fullmatch(v.id)
    d = tmp_path / "voices" / v.id
    assert sorted(p.name for p in d.iterdir()) == ["reference.wav", "voice.json"]
    meta = json.loads((d / "voice.json").read_text())
    assert meta["id"] == v.id and meta["name"] == "Ava" and meta["languages"] == ["en", "zh"]
    assert meta["gender"] == "female" and meta["transcript_source"] == "given" and meta["engine_hint"] is None
    assert meta["created_by"] == "admin" and meta["created_at"].endswith("Z")
    assert meta["consent"]["statement"] == STATEMENT and meta["consent"]["speaker"] == "Ava Lee"
    assert meta["consent"]["recorded_at"].endswith("Z")
    audio, rate = sf.read(d / "reference.wav", dtype="float32")
    assert rate == 24000 and audio.ndim == 1
    assert sf.info(d / "reference.wav").subtype == "PCM_16"
    assert abs(float(np.max(np.abs(audio))) - 10 ** (-1 / 20)) < 0.01  # peak-normalised to -1 dBFS


def test_defaults(store):
    v = make(store, languages=None, gender=None, created_by=None, transcript="你好，这是我的声音")
    assert v.languages == ("zh",) and v.gender == "neutral" and v.created_by == "unknown"
    assert make(store, languages="").languages == ("en",)


def test_files_and_directories_are_private(store, tmp_path):
    v = make(store)
    root = tmp_path / "voices"
    assert stat.S_IMODE(os.stat(root).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(root / v.id).st_mode) == 0o700
    for name in ("reference.wav", "voice.json"):
        assert stat.S_IMODE(os.stat(root / v.id / name).st_mode) == 0o600


def test_no_temp_files_left_behind(store, tmp_path):
    v = make(store)
    store.update(v.id, name="Eve")
    assert sorted(p.name for p in (tmp_path / "voices" / v.id).iterdir()) == ["reference.wav", "voice.json"]


def test_reload_from_disk(store, tmp_path):
    a = make(store, name="A")
    b = make(store, name="B")
    store.update(b.id, name="B2", gender="male")
    again = VoiceStore(tmp_path / "voices")
    assert {v.id: v.name for v in again.list()} == {a.id: "A", b.id: "B2"}
    assert again.info(b.id).gender == "male"
    ref = again.get(a.id)
    assert ref.rate == 24000 and ref.transcript == a.transcript and ref.language == "en"


def test_nothing_is_created_until_the_first_voice(tmp_path):
    VoiceStore(tmp_path / "voices")
    assert not (tmp_path / "voices").exists()


def test_failed_write_leaves_no_voice(store, tmp_path, monkeypatch):
    def boom(path, data):
        raise OSError("disk full")

    monkeypatch.setattr("max_speech.voices.store._atomic_write", boom)
    with pytest.raises(OSError):
        make(store)
    assert store.list() == []
    assert list((tmp_path / "voices").iterdir()) == []


def test_load_skips_broken_and_foreign_directories(store, tmp_path):
    v = make(store)
    root = tmp_path / "voices"
    (root / "v_0000000000").mkdir()  # no voice.json
    (root / "not-a-voice").mkdir()
    (root / "v_1111111111").mkdir()
    (root / "v_1111111111" / "voice.json").write_text("{bad")
    mismatched = root / "v_2222222222"
    mismatched.mkdir()
    (mismatched / "voice.json").write_text((root / v.id / "voice.json").read_text())
    (mismatched / "reference.wav").write_bytes(b"")
    assert [x.id for x in VoiceStore(root).list()] == [v.id]


# ---- ids and path safety -----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad",
    [
        "../x",
        "v_../../etc",
        "..",
        "",
        "v_ABCDEF0123",
        "v_123",
        "v_0123456789a",
        "V_0123456789",
        "af_heart",
        "v_0123456789/",
    ],
)
def test_malformed_ids_never_reach_the_filesystem(store, bad):
    assert not is_custom_id(bad)
    for call in (
        store.info,
        store.get,
        store.delete,
        store.reference_path,
        lambda i: store.update(i, name="x"),
    ):
        with pytest.raises(UnknownVoiceError):
            call(bad)


def test_traversal_id_does_not_delete_outside(store, tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("x")
    with pytest.raises(UnknownVoiceError):
        store.delete("../victim")
    assert (victim / "keep.txt").exists()


def test_unknown_but_well_formed_id(store):
    with pytest.raises(UnknownVoiceError):
        store.get("v_0123456789")


def test_is_custom_id_never_matches_presets():
    assert is_custom_id("v_0123456789") and not is_custom_id("af_heart")


# ---- consent --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "kw",
    [
        {"consent": False},
        {"consent": None},
        {"consent": "true"},  # only the boolean counts at store level
        {"consent": 1},
        {"consent_statement": None},
        {"consent_statement": "too short"},
        {"consent_statement": "x" * 19},
        {"consent_statement": "x" * 1001},
        {"consent_statement": "   " + "x" * 10 + "   "},
        {"consent_speaker": ""},
        {"consent_speaker": "   "},
        {"consent_speaker": None},
        {"consent_speaker": "x" * 129},
    ],
)
def test_consent_is_enforced_by_the_store(store, kw):
    with pytest.raises(VoiceError) as e:
        make(store, **kw)
    assert code(e) == "consent_required"
    assert store.list() == []


def test_consent_at_limits_is_accepted(store):
    make(store, consent_statement="x" * 20, consent_speaker="s" * 128)
    make(store, consent_statement="x" * 1000)


def test_consent_is_refused_before_the_audio_is_looked_at(store):
    with pytest.raises(VoiceError) as e:
        make(store, audio=b"not audio", consent=False)
    assert code(e) == "consent_required"


# ---- field validation -----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "kw",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "n" * 65},
        {"name": None},
        {"name": "a\x00b"},
        {"transcript": "t " * 600},
        {"created_by": "c" * 129},
        {"gender": "robot"},
        {"languages": "english"},
        {"languages": "en,../"},
        {"languages": "en,zh,fr,de,es,it,ja,ko,pt"},
    ],
)
def test_invalid_fields(store, kw):
    with pytest.raises(VoiceError) as e:
        make(store, **kw)
    assert code(e) == "invalid_field"


def test_field_limits_at_the_boundary(store):
    v = make(store, name="n" * 64, transcript="t" * 1000, created_by="c" * 128)
    assert len(v.name) == 64 and len(v.transcript) == 1000 and len(v.created_by) == 128


def test_blank_transcript_is_refused(store):
    for t in (None, "", "   "):
        with pytest.raises(VoiceError) as e:
            make(store, transcript=t)
        assert code(e) == "transcript_required"


def test_whitespace_is_normalised(store):
    assert make(store, name="  Ava \n Lee ").name == "Ava Lee"


# ---- reference validation -----------------------------------------------------------------------------------------
def test_too_short(store):
    with pytest.raises(VoiceError) as e:
        make(store, audio=good_wav(4.0))
    assert code(e) == "reference_too_short"


def test_too_short_once_silence_is_trimmed(store):
    audio = wav_of(speech_like(3.0, lead=3.0, tail=3.0))
    with pytest.raises(VoiceError) as e:
        make(store, audio=audio)
    assert code(e) == "reference_too_short"


def test_too_long(store):
    with pytest.raises(VoiceError) as e:
        make(store, audio=good_wav(31.0))
    assert code(e) == "reference_too_long"


def test_boundaries_are_accepted(store):
    assert make(store, audio=good_wav(5.5)).duration_s >= 5.0
    assert make(store, audio=good_wav(30.0)).duration_s <= 30.0


def test_silent(store):
    for samples in (np.zeros(24000 * 8, np.float32), speech_like(8.0, amp=0.0002)):
        with pytest.raises(VoiceError) as e:
            make(store, audio=wav_of(samples))
        assert code(e) == "reference_silent"


def test_clipped(store):
    square = np.where(np.sin(np.arange(24000 * 8) / 20.0) > 0, 1.0, -1.0).astype(np.float32)
    with pytest.raises(VoiceError) as e:
        make(store, audio=wav_of(square))
    assert code(e) == "reference_clipped"


def test_a_little_clipping_is_tolerated(store):
    x = speech_like(8.0)
    x[:100] = 1.0  # well under 1%
    make(store, audio=wav_of(x))


def test_undecodable_audio(store):
    with pytest.raises(VoiceError) as e:
        make(store, audio=b"definitely not audio")
    assert code(e) == "invalid_audio"


def test_trims_resamples_and_mixes_down(store, tmp_path):
    mono = speech_like(7.0, rate=48000, lead=1.0, tail=1.0)
    stereo = np.stack([mono, mono * 0.5], axis=1)
    v = make(store, audio=wav_of(stereo, 48000))
    assert 6.9 < v.duration_s < 7.3  # ~1 s of silence each side removed, small padding kept
    audio, rate = sf.read(tmp_path / "voices" / v.id / "reference.wav")
    assert rate == 24000 and audio.ndim == 1 and len(audio) / rate == pytest.approx(v.duration_s, abs=0.01)


def test_accepts_flac(store):
    make(store, audio=wav_of(speech_like(8.0), fmt="FLAC"))


# ---- update, get cache, delete ---------------------------------------------------------------------------------------
def test_update_changes_only_what_is_sent(store):
    v = make(store, languages="en", gender="female")
    u = store.update(v.id, name="Eve", languages=["zh", "en"])
    assert (u.name, u.languages, u.gender, u.transcript) == ("Eve", ("zh", "en"), "female", v.transcript)
    assert u.consent == v.consent and u.created_at == v.created_at and u.duration_s == v.duration_s
    assert store.info(v.id) == u


def test_update_validates(store):
    v = make(store)
    for kw in ({"name": ""}, {"gender": "x"}, {"languages": []}, {"transcript": " "}, {"name": "n" * 65}):
        with pytest.raises(VoiceError) as e:
            store.update(v.id, **kw)
        assert code(e) == "invalid_field"
    assert store.info(v.id).name == "Ava"


def test_update_unknown(store):
    with pytest.raises(UnknownVoiceError):
        store.update("v_0123456789", name="x")


def test_get_caches_decoded_audio_until_update(store):
    v = make(store)
    first = store.get(v.id)
    assert store.get(v.id) is first
    first.cache["prepared"] = 1
    store.update(v.id, name="Eve")  # any change drops the engine cache
    second = store.get(v.id)
    assert second is not first and second.cache == {}
    store.update(v.id, transcript="a new transcript")
    assert store.get(v.id).transcript == "a new transcript"


def test_delete_removes_everything(store, tmp_path):
    v = make(store)
    other = make(store)
    store.get(v.id)
    store.delete(v.id)
    assert not (tmp_path / "voices" / v.id).exists()
    assert (tmp_path / "voices" / other.id).exists()
    assert [x.id for x in store.list()] == [other.id]
    assert [x.id for x in VoiceStore(tmp_path / "voices").list()] == [other.id]
    for call in (store.get, store.info, store.delete):
        with pytest.raises(UnknownVoiceError):
            call(v.id)


def test_transcript_source_is_recorded(store):
    assert make(store, transcript_source="stt").transcript_source == "stt"


# ---- cache invalidation, crash safety, read-only consent ---------------------------------------------------------------
def test_a_languages_only_update_invalidates_the_cached_reference(store):
    v = make(store, languages="en")
    first = store.get(v.id)
    store.update(v.id, languages=["zh"])
    second = store.get(v.id)
    assert second is not first and second.language == "zh"


def test_a_reference_read_across_an_update_is_not_cached(store, monkeypatch):
    v = make(store, languages="en")
    real_read = sf.read

    def read_then_update(*a, **kw):
        out = real_read(*a, **kw)
        monkeypatch.setattr(sf, "read", real_read)
        store.update(v.id, languages=["zh"])  # lands while get() holds the old record
        return out

    monkeypatch.setattr(sf, "read", read_then_update)
    stale = store.get(v.id)
    assert stale.language == "en"  # the caller asked before the update
    assert store.get(v.id).language == "zh"  # but the stale object was not kept


def test_load_removes_a_directory_without_voice_json(store, tmp_path, caplog):
    root = tmp_path / "voices"
    other = make(store)
    orphan = root / "v_aaaaaaaaaa"
    orphan.mkdir()
    (orphan / "reference.wav").write_bytes(b"RIFF")
    with caplog.at_level("WARNING"):
        again = VoiceStore(root)
    assert not orphan.exists() and "v_aaaaaaaaaa" in caplog.text
    assert [x.id for x in again.list()] == [other.id]


def test_load_keeps_an_unreadable_voice_directory(tmp_path):
    root = tmp_path / "voices"
    bad = root / "v_bbbbbbbbbb"
    bad.mkdir(parents=True)
    (bad / "voice.json").write_text("{not json")
    VoiceStore(root)
    assert bad.exists()  # has a voice.json: left for a human to look at


def test_load_cleans_leftover_trash(store, tmp_path):
    root = tmp_path / "voices"
    make(store)
    trash = root / ".trash-v_cccccccccc-1a2b3c4d"
    trash.mkdir()
    (trash / "reference.wav").write_bytes(b"x")
    VoiceStore(root)
    assert not trash.exists()


def test_delete_renames_to_trash_before_removing(store, tmp_path, monkeypatch):
    v = make(store)
    seen = []
    real_rmtree = shutil.rmtree

    def spy(path, *a, **kw):
        seen.append((Path(path).name, (tmp_path / "voices" / v.id).exists()))
        real_rmtree(path, *a, **kw)

    monkeypatch.setattr(shutil, "rmtree", spy)
    store.delete(v.id)
    ((name, original_still_there),) = seen
    assert name.startswith(f".trash-{v.id}-") and not original_still_there


def test_a_failed_removal_is_logged_and_cleaned_on_next_start(store, tmp_path, monkeypatch, caplog):
    v = make(store)

    def broken(path, *a, **kw):
        raise OSError("disk says no")

    monkeypatch.setattr(shutil, "rmtree", broken)
    with caplog.at_level("WARNING"):
        store.delete(v.id)  # the voice is gone from the store even though the files stayed
    assert "disk says no" in caplog.text
    assert v.id not in store and store.list() == []
    (leftover,) = [p for p in (tmp_path / "voices").iterdir()]
    assert leftover.name.startswith(".trash-")
    monkeypatch.undo()
    VoiceStore(tmp_path / "voices")
    assert not leftover.exists()


def test_consent_is_read_only(store):
    v = make(store)
    with pytest.raises(TypeError):
        v.consent["speaker"] = "someone else"  # type: ignore[index]
    assert store.info(v.id).consent["speaker"] == "Ava Lee"
    source = {"statement": "s", "speaker": "p", "recorded_at": "t"}
    copy = CustomVoice.from_dict({**v.to_dict(), "consent": source})
    source["speaker"] = "changed"
    assert copy.consent["speaker"] == "p"
    assert isinstance(v.to_dict()["consent"], dict)


# ---- origin: recorded or designed ------------------------------------------------------------------------------
def designed(store, **kw):
    args = {
        "audio": good_wav(),
        "name": "Calm",
        "transcript": "Hello! This is a sample.",
        "description": "A calm, low voice",
        "seed": 11,
        "model": "qwen3-tts-1.7b-voicedesign-mlx",
        "created_by": "admin",
    }
    args.update(kw)
    return store.create_designed(**args)


def test_recorded_voices_have_origin_and_consent(store):
    v = make(store)
    d = v.to_dict()
    assert v.origin == "recorded" and d["origin"] == "recorded" and "consent" in d and "design" not in d


def test_the_store_still_refuses_a_recorded_voice_without_consent(store):
    with pytest.raises(VoiceError) as e:
        make(store, consent=None)
    assert code(e) == "consent_required"
    assert store.list() == []


def test_a_designed_voice_carries_its_design_and_no_consent(store, tmp_path):
    v = designed(store, languages="en")
    d = v.to_dict()
    assert v.origin == "designed" and "consent" not in d
    assert d["design"] == {
        "description": "A calm, low voice",
        "seed": 11,
        "model": "qwen3-tts-1.7b-voicedesign-mlx",
        "text": "Hello! This is a sample.",
    }
    meta = json.loads((tmp_path / "voices" / v.id / "voice.json").read_text())
    assert meta["origin"] == "designed" and "consent" not in meta
    reloaded = VoiceStore(tmp_path / "voices").info(v.id)
    assert reloaded.origin == "designed" and reloaded.design["description"] == "A calm, low voice"


def test_a_designed_voice_needs_a_description(store):
    for bad in (None, "", "   ", 5):
        with pytest.raises(VoiceError) as e:
            designed(store, description=bad)
        assert code(e) == "invalid_field"
    assert store.list() == []


def test_a_designed_voice_needs_an_integer_seed_and_a_transcript(store):
    with pytest.raises(VoiceError):
        designed(store, seed="7")
    with pytest.raises(VoiceError) as e:
        designed(store, transcript="")
    assert code(e) == "transcript_required"


def test_update_keeps_the_origin_and_design(store):
    v = designed(store)
    updated = store.update(v.id, name="Renamed")
    assert (
        updated.origin == "designed" and updated.design["seed"] == 11 and "consent" not in updated.to_dict()
    )


def test_voices_saved_before_origin_existed_load_as_recorded(store, tmp_path):
    v = make(store)
    path = tmp_path / "voices" / v.id / "voice.json"
    meta = json.loads(path.read_text())
    del meta["origin"]
    path.write_text(json.dumps(meta))
    assert VoiceStore(tmp_path / "voices").info(v.id).origin == "recorded"


def test_a_recorded_voice_file_without_consent_is_not_loaded(store, tmp_path):
    v = make(store)
    path = tmp_path / "voices" / v.id / "voice.json"
    meta = json.loads(path.read_text())
    del meta["consent"]
    path.write_text(json.dumps(meta))
    assert VoiceStore(tmp_path / "voices").list() == []


def test_a_designed_reference_needs_three_seconds():
    import numpy as np
    import pytest

    from max_speech.voices.store import MIN_DESIGN_SECONDS, VoiceError, reference_from_samples

    t = np.arange(24000 * 5) / 24000
    tone = (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
    assert MIN_DESIGN_SECONDS == 3.0
    with pytest.raises(VoiceError) as e:
        reference_from_samples(tone[: int(24000 * 2.8)], 24000)
    assert e.value.code == "reference_too_short"
    assert reference_from_samples(tone[: int(24000 * 3.2)], 24000).duration_s >= 3.0
