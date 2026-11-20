import pytest

from max_speech.engines import select
from max_speech.licenses import LicenseError
from max_speech.settings import Settings


def _s(**kw) -> Settings:
    """Settings with the live-conversation roles off, for the tests of the batch roles."""
    return Settings(**{"vad_model": "off", "turn_model": "off", "stream_stt_model": "off", **kw})


@pytest.fixture
def patched(monkeypatch, tmp_path):
    calls = {"ensure": [], "built": []}

    def fake_ensure(entry, models_dir, **kw):
        calls["ensure"].append(entry.id)
        return tmp_path / entry.id

    class Built(tuple):
        def warm_up(self):
            pass

    def ctor(name):
        def make(*args, **kw):
            calls["built"].append((name, args, kw))
            return Built((name, args, kw))

        return make

    monkeypatch.setattr(select, "ensure_model", fake_ensure)
    monkeypatch.setattr(select, "KokoroTts", ctor("kokoro"))
    monkeypatch.setattr(select, "WhisperCt2Stt", ctor("ct2"))
    monkeypatch.setattr(select, "WhisperMlxStt", ctor("mlx"))
    monkeypatch.setattr(select, "_build_vad", lambda path, model_id: ctor("vad")(path, model_id))
    monkeypatch.setattr(select, "_build_turn", lambda path, model_id: ctor("turn")(path, model_id))
    monkeypatch.setattr(select, "SherpaStreamingStt", ctor("sherpa"))
    return calls


@pytest.mark.parametrize(
    ("profile", "stt_model", "stt_name"),
    [
        ("cuda", "faster-whisper-large-v3-turbo", "ct2"),
        ("mlx", "mlx-whisper-large-v3-turbo", "mlx"),
        ("cpu", "faster-whisper-small", "ct2"),
    ],
)
def test_defaults(patched, profile, stt_model, stt_name):
    e = select.build_engines(_s(), profile)
    stt, tts = e.stt, e.tts
    assert stt[0] == stt_name
    assert tts[0] == "kokoro"
    assert patched["ensure"] == [stt_model, "kokoro-v1.0", "kokoro-v1.1-zh"]


def test_kokoro_gets_the_zh_model_dir_and_id(patched, tmp_path):
    tts = select.build_engines(_s(stt_engine="off"), "cpu").tts
    assert tts[2]["zh_model_dir"] == tmp_path / "kokoro-v1.1-zh"
    assert tts[2]["zh_model_id"] == "kokoro-v1.1-zh"


def test_zh_model_off_loads_only_v1_0(patched):
    tts = select.build_engines(_s(stt_engine="off", tts_zh_model="off"), "cpu").tts
    assert patched["ensure"] == ["kokoro-v1.0"]
    assert tts[2]["zh_model_dir"] is None


def test_zh_model_override_is_license_checked_before_any_download(patched):
    with pytest.raises(LicenseError):
        select.build_engines(_s(tts_zh_model="not-registered"), "cpu")
    with pytest.raises(LicenseError):
        select.build_engines(_s(tts_zh_model="faster-whisper-small"), "cpu")
    assert patched["ensure"] == []


def test_no_zh_model_without_tts(patched):
    select.build_engines(_s(tts_engine="off", stt_engine="off"), "cpu")
    assert patched["ensure"] == []


def test_ct2_devices(patched):
    cuda = select.build_engines(_s(), "cuda").stt
    assert cuda[2] == {"device": "cuda", "compute_type": "float16"}
    cpu = select.build_engines(_s(), "cpu").stt
    assert cpu[2] == {"device": "cpu", "compute_type": "int8"}


def test_off_disables_roles(patched):
    e = select.build_engines(_s(stt_engine="off", tts_engine="off"), "cpu")
    stt, tts = e.stt, e.tts
    assert stt is None and tts is None
    assert patched["ensure"] == []


def test_model_override(patched):
    stt = select.build_engines(_s(stt_model="faster-whisper-large-v3-turbo", tts_engine="off"), "cpu").stt
    assert stt[0] == "ct2"
    assert patched["ensure"] == ["faster-whisper-large-v3-turbo"]


def test_engine_override_picks_matching_model(patched):
    select.build_engines(_s(stt_engine="whisper-mlx", tts_engine="off"), "cpu")
    assert patched["ensure"] == ["mlx-whisper-large-v3-turbo"]


def test_unknown_engine_rejected(patched):
    with pytest.raises(ValueError, match="unknown stt engine"):
        select.build_engines(_s(stt_engine="nope"), "cpu")


def test_unregistered_model_fails_before_any_download(patched):
    with pytest.raises(LicenseError):
        select.build_engines(_s(stt_model="not-registered"), "cpu")
    assert patched["ensure"] == []


def test_wrong_kind_rejected(patched):
    with pytest.raises(LicenseError):
        select.build_engines(_s(tts_model="faster-whisper-small"), "cpu")
    assert patched["ensure"] == []


def test_cuda_stt_failure_falls_back_to_cpu(patched, monkeypatch, caplog):
    built = []

    class Ct2:
        def __init__(self, path, model_id, *, device, compute_type):
            built.append((device, compute_type, model_id))
            if device == "cuda":
                raise RuntimeError("libcublas.so.12 not found")

        def warm_up(self):
            pass

    monkeypatch.setattr(select, "WhisperCt2Stt", Ct2)
    with caplog.at_level("WARNING"):
        stt = select.build_engines(_s(tts_engine="off"), "cuda").stt
    assert built == [
        ("cuda", "float16", "faster-whisper-large-v3-turbo"),
        ("cpu", "int8", "faster-whisper-large-v3-turbo"),
    ]
    assert isinstance(stt, Ct2)
    assert "libcublas.so.12 not found" in caplog.text


def test_cuda_stt_warm_up_failure_falls_back_to_cpu(patched, monkeypatch, caplog):
    built = []

    class Ct2:
        def __init__(self, path, model_id, *, device, compute_type):
            self.device = device
            built.append(device)

        def warm_up(self):
            if self.device == "cuda":
                raise RuntimeError("cuDNN missing")

    monkeypatch.setattr(select, "WhisperCt2Stt", Ct2)
    with caplog.at_level("WARNING"):
        stt = select.build_engines(_s(tts_engine="off"), "cuda").stt
    assert built == ["cuda", "cpu"] and stt.device == "cpu"
    assert "cuDNN missing" in caplog.text


# ---- live conversation roles -------------------------------------------------------------------------------


def test_live_defaults_for_every_profile(patched):
    for profile in ("cuda", "mlx", "cpu"):
        patched["ensure"].clear()
        patched["built"].clear()
        e = select.build_engines(Settings(stt_engine="off", tts_engine="off"), profile)
        assert patched["ensure"] == ["silero-vad-v6.2", "smart-turn-v3.2", "x-asr-zh-en-480ms"]
        assert e.vad[0] == "vad" and e.turn[0] == "turn"
        assert e.vad[1][1] == "silero-vad-v6.2" and e.turn[1][1] == "smart-turn-v3.2"
        name, args, kw = e.stt_stream
        assert name == "sherpa" and args[1] == "transducer" and kw == {"model_id": "x-asr-zh-en-480ms"}
        assert args[0].name == "x-asr-zh-en-480ms"


def test_paraformer_override_selects_the_paraformer_kind(patched):
    e = select.build_engines(
        Settings(stt_engine="off", tts_engine="off", stream_stt_model="paraformer-zh-en-streaming"), "cpu"
    )
    assert e.stt_stream[1][1] == "paraformer"
    assert "paraformer-zh-en-streaming" in patched["ensure"]


def test_live_roles_can_each_be_turned_off(patched):
    e = select.build_engines(Settings(stt_engine="off", tts_engine="off", vad_model="off"), "cpu")
    assert e.vad is None and e.turn is not None and e.stt_stream is not None
    e = select.build_engines(Settings(stt_engine="off", tts_engine="off", turn_model="off"), "cpu")
    assert e.turn is None and e.vad is not None
    e = select.build_engines(Settings(stt_engine="off", tts_engine="off", stream_stt_model="off"), "cpu")
    assert e.stt_stream is None


@pytest.mark.parametrize(
    "override",
    [
        {"vad_model": "not-registered"},
        {"turn_model": "faster-whisper-small"},  # wrong kind
        {"stream_stt_model": "kokoro-v1.0"},  # wrong kind
        {"vad_model": "smart-turn-v3.2"},  # wrong kind
        {"stream_stt_model": "faster-whisper-small"},  # an stt model, but not a streaming one
    ],
)
def test_live_overrides_are_license_checked_before_any_download(patched, override):
    with pytest.raises(LicenseError):
        select.build_engines(Settings(**override), "cpu")
    assert patched["ensure"] == []


@pytest.mark.parametrize(
    ("mode", "profile", "expected"),
    [
        ("auto", "mlx", True),
        ("auto", "cuda", True),
        ("auto", "cpu", False),
        ("on", "cpu", True),
        ("off", "mlx", False),
    ],
)
def test_second_pass(patched, mode, profile, expected):
    e = select.build_engines(_s(second_pass=mode), profile)
    assert e.second_pass is expected


def test_second_pass_needs_the_batch_stt(patched):
    assert select.build_engines(_s(second_pass="on", stt_engine="off"), "mlx").second_pass is False


def test_plan_roles_and_kinds():
    p = select.plan(Settings(), "cpu")
    assert [r.role for r in p.roles()] == ["stt", "tts", "vad", "turn", "stt_stream"]
    assert [r.kind for r in p.roles()] == ["stt", "tts", "vad", "turn", "stt"]
    assert p.second_pass is False


def test_a_non_streaming_stt_for_the_session_names_the_streaming_ones(patched):
    with pytest.raises(
        LicenseError, match="not a streaming model.*paraformer-zh-en-streaming.*x-asr-zh-en-480ms"
    ):
        select.build_engines(Settings(stream_stt_model="faster-whisper-small"), "cpu")
    assert patched["ensure"] == []
    # the same model is fine as the batch stt
    select.build_engines(Settings(stt_model="faster-whisper-small", tts_engine="off"), "cpu")
