import pytest

from max_speech.engines import select
from max_speech.licenses import LicenseError
from max_speech.settings import Settings


def _s(**kw) -> Settings:
    """Settings with the live-conversation roles off, for the tests of the batch roles."""
    return Settings(
        **{"vad_model": "off", "turn_model": "off", "stream_stt_model": "off", "cloning_model": "off", **kw}
    )


GB = 1024**3
REAL_RAM = select.total_ram_bytes


@pytest.fixture(autouse=True)
def big_machine(monkeypatch):
    """Design is on by default only with enough RAM; the tests that care pass `total_ram` themselves."""
    monkeypatch.setattr(select, "total_ram_bytes", lambda: 64 * GB)


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
    monkeypatch.setattr(
        select,
        "_build_cloning",
        lambda role_plan, entry, paths: ctor("cloning")(role_plan.engine, entry.id, dict(paths)),
    )
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


def _failing_cuda(monkeypatch):
    class Ct2:
        def __init__(self, path, model_id, *, device, compute_type):
            if device == "cuda":
                raise RuntimeError("no gpu")

        def warm_up(self):
            pass

    monkeypatch.setattr(select, "WhisperCt2Stt", Ct2)


def test_cuda_fallback_turns_second_pass_off(patched, monkeypatch, caplog):
    _failing_cuda(monkeypatch)
    with caplog.at_level("WARNING"):
        e = select.build_engines(_s(tts_engine="off"), "cuda")
    assert e.second_pass is False
    assert "second pass is off" in caplog.text


def test_cuda_fallback_keeps_explicit_second_pass(patched, monkeypatch):
    _failing_cuda(monkeypatch)
    assert select.build_engines(_s(tts_engine="off", second_pass="on"), "cuda").second_pass is True


def test_cuda_with_gpu_keeps_auto_second_pass(patched, monkeypatch):
    class Ct2:
        def __init__(self, path, model_id, *, device, compute_type):
            pass

        def warm_up(self):
            pass

    monkeypatch.setattr(select, "WhisperCt2Stt", Ct2)
    assert select.build_engines(_s(tts_engine="off"), "cuda").second_pass is True


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
    p = select.plan(Settings(cloning_model="moss-tts-nano-onnx"), "cpu")
    assert [r.role for r in p.roles()] == ["stt", "tts", "cloning", "vad", "turn", "stt_stream"]
    assert [r.kind for r in p.roles()] == ["stt", "tts", "tts", "vad", "turn", "stt"]
    assert p.second_pass is False


def test_a_non_streaming_stt_for_the_session_names_the_streaming_ones(patched):
    with pytest.raises(
        LicenseError, match="not a streaming model.*paraformer-zh-en-streaming.*x-asr-zh-en-480ms"
    ):
        select.build_engines(Settings(stream_stt_model="faster-whisper-small"), "cpu")
    assert patched["ensure"] == []
    # the same model is fine as the batch stt
    select.build_engines(Settings(stt_model="faster-whisper-small", tts_engine="off"), "cpu")


# ---- voice cloning ----


@pytest.mark.parametrize(
    ("profile", "model", "engine"),
    [("mlx", "qwen3-tts-0.6b-mlx", "qwen3-mlx"), ("cpu", "moss-tts-nano-onnx", "moss-onnx")],
)
def test_cloning_defaults_and_cpu_opt_in(profile, model, engine):
    default = select.plan(_s(cloning_model=None), profile).cloning
    if profile == "cpu":
        assert default is None  # ~2 GB RAM and a 730 MB download: opt-in only
    else:
        assert (default.engine, default.model_id, default.kind) == (engine, model, "tts")
    p = select.plan(_s(cloning_model=model), profile)
    assert (p.cloning.engine, p.cloning.model_id, p.cloning.kind) == (engine, model, "tts")


def test_cloning_is_off_on_cuda_by_default():
    assert select.plan(_s(cloning_model=None), "cuda").cloning is None


def test_a_failing_default_cloning_engine_does_not_stop_the_rest(patched, monkeypatch, caplog):
    def boom(*a):
        raise RuntimeError("no memory")

    monkeypatch.setattr(select, "_build_cloning", boom)
    with caplog.at_level("WARNING"):
        e = select.build_engines(_s(cloning_model=None, stt_engine="off", tts_zh_model="off"), "mlx")
    assert e.cloning is None and e.tts is not None
    assert "no memory" in caplog.text


def test_a_failing_explicit_cloning_engine_fails_loudly(patched, monkeypatch):
    def boom(*a):
        raise RuntimeError("no memory")

    monkeypatch.setattr(select, "_build_cloning", boom)
    with pytest.raises(RuntimeError, match="no memory"):
        select.build_engines(_s(cloning_model="qwen3-tts-0.6b-mlx", stt_engine="off"), "mlx")


def test_cloning_off_and_needs_tts():
    assert select.plan(_s(cloning_model="off"), "mlx").cloning is None
    assert select.plan(_s(cloning_model=None, tts_engine="off"), "mlx").cloning is None


def test_cloning_override_and_engine_for_the_larger_model():
    p = select.plan(_s(cloning_model="qwen3-tts-1.7b-mlx"), "mlx")
    assert (p.cloning.engine, p.cloning.model_id) == ("qwen3-mlx", "qwen3-tts-1.7b-mlx")
    # an explicit model on a profile that has no default still works when the engine suits the profile
    assert select.plan(_s(cloning_model="moss-tts-nano-onnx"), "cuda").cloning.engine == "moss-onnx"


def test_cloning_engine_must_suit_the_profile():
    with pytest.raises(ValueError, match="mlx profile only"):
        select.plan(_s(cloning_model="qwen3-tts-0.6b-mlx"), "cpu")


def test_cloning_model_without_an_engine_is_rejected():
    with pytest.raises(ValueError, match="no cloning engine"):
        select.plan(_s(cloning_model="kokoro-v1.0"), "mlx")


def test_cloning_loads_the_model_and_its_companions(patched, tmp_path):
    e = select.build_engines(
        _s(cloning_model="moss-tts-nano-onnx", stt_engine="off", tts_zh_model="off"), "cpu"
    )
    assert patched["ensure"] == [
        "kokoro-v1.0",
        "moss-audio-tokenizer-nano-onnx",
        "moss-tts-nano-onnx",
    ]
    name, args, _ = e.cloning
    assert name == "cloning" and args[:2] == ("moss-onnx", "moss-tts-nano-onnx")
    assert args[2] == {
        "moss-audio-tokenizer-nano-onnx": tmp_path / "moss-audio-tokenizer-nano-onnx",
        "moss-tts-nano-onnx": tmp_path / "moss-tts-nano-onnx",
    }
    assert e.cloning in e.loaded()


def test_a_companion_is_not_a_cloning_model(patched):
    with pytest.raises(ValueError, match="no cloning engine"):
        select.build_engines(_s(cloning_model="moss-audio-tokenizer-nano-onnx"), "cpu")
    assert patched["ensure"] == []


def test_licensed_refuses_a_cloning_role_whose_model_cannot_clone():
    role = select.RolePlan("cloning", "moss-onnx", "moss-audio-tokenizer-nano-onnx")
    with pytest.raises(LicenseError, match="cannot clone voices.*qwen3-tts-0.6b-mlx"):
        select.licensed(role)


@pytest.mark.parametrize("model", ["not-registered", "faster-whisper-small"])
def test_bad_cloning_model_is_refused_before_any_download(patched, model):
    with pytest.raises((LicenseError, ValueError)):
        select.build_engines(_s(cloning_model=model), "mlx")
    assert patched["ensure"] == []


def test_settings_read_the_cloning_model(clean_env):
    clean_env.setenv("SPEECH_CLONING_MODEL", "off")
    assert Settings.from_env().cloning_model == "off"


# ---- voice design ----------------------------------------------------------------------------------------------
DESIGN = "qwen3-tts-1.7b-voicedesign-mlx"


def test_design_defaults_to_the_mlx_model_only():
    p = select.plan(_s(cloning_model=None, design_model=None), "mlx")
    assert (p.design.role, p.design.engine, p.design.model_id, p.design.kind) == (
        "design",
        "qwen3-design-mlx",
        DESIGN,
        "tts",
    )
    assert [r.role for r in p.roles()].index("design") == [r.role for r in p.roles()].index("cloning") + 1
    assert select.plan(_s(cloning_model="moss-tts-nano-onnx", design_model=None), "cpu").design is None
    assert select.plan(_s(cloning_model="moss-tts-nano-onnx", design_model=None), "cuda").design is None


def test_design_can_be_turned_off_or_overridden():
    assert select.plan(_s(cloning_model=None, design_model="off"), "mlx").design is None
    assert select.plan(_s(cloning_model=None, design_model=DESIGN), "mlx").design.model_id == DESIGN


def test_design_needs_cloning_and_says_so(caplog):
    with caplog.at_level("INFO"):
        p = select.plan(_s(cloning_model="off", design_model=None), "mlx")
    assert p.design is None and "voice design is off" in caplog.text


def test_design_engine_must_exist_and_suit_the_profile():
    with pytest.raises(ValueError, match="no design engine"):
        select.plan(_s(cloning_model=None, design_model="kokoro-v1.0"), "mlx")
    with pytest.raises(ValueError, match="mlx profile only"):
        select.plan(_s(cloning_model="moss-tts-nano-onnx", design_model=DESIGN), "cpu")


def test_licensed_refuses_a_design_role_whose_model_cannot_design():
    role = select.RolePlan("design", "qwen3-design-mlx", "qwen3-tts-0.6b-mlx")
    with pytest.raises(LicenseError, match="cannot design voices"):
        select.licensed(role)
    assert select.licensed(select.RolePlan("design", "qwen3-design-mlx", DESIGN)).design


def test_design_is_downloaded_but_not_loaded(patched, monkeypatch):
    built = []
    monkeypatch.setattr(
        select, "_build_design", lambda role, entry, path: built.append((entry.id, path)) or "engine"
    )
    e = select.build_engines(_s(cloning_model=None, stt_engine="off", tts_zh_model="off"), "mlx")
    assert DESIGN in patched["ensure"] and e.design == "engine" and built[0][0] == DESIGN
    assert e.design not in e.loaded()  # never warmed up: the engine loads its weights on first use


def test_design_is_skipped_when_cloning_failed(patched, monkeypatch, caplog):
    def boom(*a):
        raise RuntimeError("no memory")

    monkeypatch.setattr(select, "_build_cloning", boom)
    with caplog.at_level("INFO"):
        e = select.build_engines(_s(cloning_model=None, stt_engine="off", tts_zh_model="off"), "mlx")
    assert e.cloning is None and e.design is None and DESIGN not in patched["ensure"]


def test_a_failing_default_design_degrades_and_an_explicit_one_fails(patched, monkeypatch, caplog):
    def boom(*a):
        raise RuntimeError("download stalled")

    monkeypatch.setattr(select, "_build_design", boom)
    with caplog.at_level("WARNING"):
        e = select.build_engines(_s(cloning_model=None, stt_engine="off", tts_zh_model="off"), "mlx")
    assert e.design is None and e.cloning is not None and "download stalled" in caplog.text
    with pytest.raises(RuntimeError, match="download stalled"):
        select.build_engines(
            _s(cloning_model=None, design_model=DESIGN, stt_engine="off", tts_zh_model="off"), "mlx"
        )


def test_settings_read_the_design_model(clean_env):
    clean_env.setenv("SPEECH_DESIGN_MODEL", "off")
    assert Settings.from_env().design_model == "off"


@pytest.mark.parametrize(
    ("ram", "on"), [(16 * GB, False), (24 * GB - 1, False), (24 * GB, True), (64 * GB, True), (None, False)]
)
def test_design_is_on_by_default_only_with_24_gb_of_ram(ram, on, caplog):
    with caplog.at_level("INFO"):
        p = select.plan(_s(cloning_model=None, design_model=None), "mlx", total_ram=lambda: ram)
    assert (p.design is not None) is on
    if not on:
        assert "SPEECH_DESIGN_MODEL" in caplog.text and "24 GB" in caplog.text


def test_a_small_machine_can_force_design_on_and_off_means_off():
    small = lambda: 8 * GB
    forced = select.plan(_s(cloning_model=None, design_model=DESIGN), "mlx", total_ram=small)
    assert forced.design.model_id == DESIGN
    assert (
        select.plan(_s(cloning_model=None, design_model="off"), "mlx", total_ram=lambda: 64 * GB).design
        is None
    )


def test_ram_is_read_from_the_machine():
    ram = REAL_RAM()
    assert ram is None or ram > 0
