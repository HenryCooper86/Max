import pytest

from max_speech.engines import select
from max_speech.licenses import LicenseError
from max_speech.settings import Settings


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
    stt, tts = select.build_engines(Settings(), profile)
    assert stt[0] == stt_name
    assert tts[0] == "kokoro"
    assert patched["ensure"] == [stt_model, "kokoro-v1.0", "kokoro-v1.1-zh"]


def test_kokoro_gets_the_zh_model_dir_and_id(patched, tmp_path):
    _, tts = select.build_engines(Settings(stt_engine="off"), "cpu")
    assert tts[2]["zh_model_dir"] == tmp_path / "kokoro-v1.1-zh"
    assert tts[2]["zh_model_id"] == "kokoro-v1.1-zh"


def test_zh_model_off_loads_only_v1_0(patched):
    _, tts = select.build_engines(Settings(stt_engine="off", tts_zh_model="off"), "cpu")
    assert patched["ensure"] == ["kokoro-v1.0"]
    assert tts[2]["zh_model_dir"] is None


def test_zh_model_override_is_license_checked_before_any_download(patched):
    with pytest.raises(LicenseError):
        select.build_engines(Settings(tts_zh_model="not-registered"), "cpu")
    with pytest.raises(LicenseError):
        select.build_engines(Settings(tts_zh_model="faster-whisper-small"), "cpu")
    assert patched["ensure"] == []


def test_no_zh_model_without_tts(patched):
    select.build_engines(Settings(tts_engine="off", stt_engine="off"), "cpu")
    assert patched["ensure"] == []


def test_ct2_devices(patched):
    cuda, _ = select.build_engines(Settings(), "cuda")
    assert cuda[2] == {"device": "cuda", "compute_type": "float16"}
    cpu, _ = select.build_engines(Settings(), "cpu")
    assert cpu[2] == {"device": "cpu", "compute_type": "int8"}


def test_off_disables_roles(patched):
    stt, tts = select.build_engines(Settings(stt_engine="off", tts_engine="off"), "cpu")
    assert stt is None and tts is None
    assert patched["ensure"] == []


def test_model_override(patched):
    stt, _ = select.build_engines(
        Settings(stt_model="faster-whisper-large-v3-turbo", tts_engine="off"), "cpu"
    )
    assert stt[0] == "ct2"
    assert patched["ensure"] == ["faster-whisper-large-v3-turbo"]


def test_engine_override_picks_matching_model(patched):
    select.build_engines(Settings(stt_engine="whisper-mlx", tts_engine="off"), "cpu")
    assert patched["ensure"] == ["mlx-whisper-large-v3-turbo"]


def test_unknown_engine_rejected(patched):
    with pytest.raises(ValueError, match="unknown stt engine"):
        select.build_engines(Settings(stt_engine="nope"), "cpu")


def test_unregistered_model_fails_before_any_download(patched):
    with pytest.raises(LicenseError):
        select.build_engines(Settings(stt_model="not-registered"), "cpu")
    assert patched["ensure"] == []


def test_wrong_kind_rejected(patched):
    with pytest.raises(LicenseError):
        select.build_engines(Settings(tts_model="faster-whisper-small"), "cpu")
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
        stt, _ = select.build_engines(Settings(tts_engine="off"), "cuda")
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
        stt, _ = select.build_engines(Settings(tts_engine="off"), "cuda")
    assert built == ["cuda", "cpu"] and stt.device == "cpu"
    assert "cuDNN missing" in caplog.text
