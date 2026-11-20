import threading

import pytest

from max_speech import cli
from max_speech.api.slots import EngineSlots
from max_speech.app import create_app
from max_speech.engines.fake import FakeStt, FakeTts
from max_speech.engines.fake_cloning import FakeCloningTts
from max_speech.engines.router import VoiceRouter
from max_speech.engines.select import Engines
from max_speech.settings import Settings
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore


def test_engines_command_prints_resolved(capsys, clean_env):
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "profile: cpu" in out
    assert "stt: whisper-ct2 / faster-whisper-small" in out
    assert "tts: kokoro / kokoro-v1.0" in out
    assert "weights Apache-2.0" in out
    assert "tts-zh: kokoro / kokoro-v1.1-zh" in out


def test_engines_command_prints_the_live_roles(capsys, clean_env):
    assert cli.main(["engines", "--profile", "mlx"]) == 0
    out = capsys.readouterr().out
    assert "vad: silero / silero-vad-v6.2" in out
    assert "turn: smart-turn / smart-turn-v3.2" in out
    assert "stt_stream: sherpa-transducer / x-asr-zh-en-480ms" in out
    assert "second_pass: on" in out


def test_engines_command_live_roles_off_and_second_pass_off(capsys, clean_env):
    clean_env.setenv("SPEECH_VAD_MODEL", "off")
    clean_env.setenv("SPEECH_STREAM_STT_MODEL", "off")
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "vad: off" in out and "stream_stt: off" not in out and "stt_stream: off" in out
    assert "turn: smart-turn" in out and "second_pass: off" in out


def test_engines_command_hides_the_zh_model_when_off(capsys, clean_env):
    clean_env.setenv("SPEECH_TTS_ZH_MODEL", "off")
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    assert "tts-zh" not in capsys.readouterr().out


def test_engines_command_reports_off(capsys, clean_env):
    clean_env.setenv("SPEECH_STT_ENGINE", "off")
    assert cli.main(["engines", "--profile", "mlx"]) == 0
    out = capsys.readouterr().out
    assert "stt: off" in out


def test_engines_command_uses_detection(capsys, clean_env, monkeypatch):
    monkeypatch.setattr("max_speech.profile.detect_profile", lambda: "mlx")
    assert cli.main(["engines"]) == 0
    assert "stt: whisper-mlx / mlx-whisper-large-v3-turbo" in capsys.readouterr().out


def test_load_engines_success(monkeypatch, tmp_path):
    warmed = []

    class Warm(FakeTts):
        def warm_up(self):
            warmed.append("tts")

    class NoWarmUp:  # the VAD engine has no warm_up
        id, model_id = "vad", "v"

    class Turn:
        id, model_id = "turn", "t"

        def warm_up(self):
            warmed.append("turn")

    stream = object()
    cloning = FakeCloningTts()
    engines = Engines(
        stt=FakeStt(),
        tts=Warm(),
        vad=NoWarmUp(),
        turn=Turn(),
        stt_stream=stream,
        second_pass=True,
        cloning=cloning,
    )
    monkeypatch.setattr(cli, "build_engines", lambda s, p, progress=None: engines)
    slots = EngineSlots(ready_event=threading.Event(), voices=VoiceStore(tmp_path), lexicon=Lexicon(tmp_path))
    cli._load_engines(slots, Settings(), "cpu")
    assert slots.ready and slots.load_error is None
    assert isinstance(slots.stt, FakeStt) and warmed == ["tts", "turn"]
    # the TTS slot is the router around the preset and the cloning engine, not the bare preset
    assert isinstance(slots.tts, VoiceRouter) and slots.cloning is cloning
    assert slots.tts.cloning is cloning and slots.tts.preset is engines.tts
    assert slots.vad is engines.vad and slots.turn is engines.turn
    assert slots.stt_stream is stream and slots.second_pass is True


class _BadWarmCloning(FakeCloningTts):
    def warm_up(self):
        raise RuntimeError("warm-up blew up")


def _load_with_bad_cloning(monkeypatch, tmp_path, settings):
    engines = Engines(tts=FakeTts(), cloning=_BadWarmCloning())
    monkeypatch.setattr(cli, "build_engines", lambda s, p, progress=None: engines)
    slots = EngineSlots(ready_event=threading.Event(), voices=VoiceStore(tmp_path), lexicon=Lexicon(tmp_path))
    cli._load_engines(slots, settings, "mlx")
    return slots


def test_default_cloning_warm_up_failure_keeps_the_server_up(monkeypatch, tmp_path, caplog):
    with caplog.at_level("WARNING"):
        slots = _load_with_bad_cloning(monkeypatch, tmp_path, Settings())
    assert slots.ready and slots.cloning is None and slots.tts is not None
    assert "warm-up blew up" in caplog.text


def test_explicit_cloning_warm_up_failure_fails_loudly(monkeypatch, tmp_path):
    slots = _load_with_bad_cloning(monkeypatch, tmp_path, Settings(cloning_model="qwen3-tts-0.6b-mlx"))
    assert not slots.ready and "warm-up blew up" in slots.load_error


def test_load_engines_failure_keeps_not_ready(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("download failed")

    monkeypatch.setattr(cli, "build_engines", boom)
    slots = EngineSlots(ready_event=threading.Event())
    cli._load_engines(slots, Settings(), "cpu")
    assert not slots.ready
    assert "download failed" in slots.load_error


def test_uvicorn_config_ignores_proxy_headers():
    app = create_app(Settings(), stt=None, tts=None, profile="cpu")
    config = cli._uvicorn_config(app, Settings(host="127.0.0.1", port=8790))
    assert config.proxy_headers is False
    assert config.port == 8790
    assert config.ws_max_size == 1 << 20


def _serve_must_not_start(monkeypatch):
    started = []
    monkeypatch.setattr("uvicorn.Server", lambda config: started.append(config) or None)
    return started


@pytest.mark.parametrize(
    "env",
    [
        {"SPEECH_STT_ENGINE": "nope"},
        {"SPEECH_STT_MODEL": "not-registered"},
        {"SPEECH_TTS_MODEL": "faster-whisper-small"},
        {"SPEECH_TTS_ZH_MODEL": "not-registered"},
        {"SPEECH_VAD_MODEL": "not-registered"},
        {"SPEECH_TURN_MODEL": "faster-whisper-small"},
        {"SPEECH_STREAM_STT_MODEL": "kokoro-v1.0"},
        {"SPEECH_STREAM_STT_MODEL": "faster-whisper-small"},  # not a streaming model
        {"SPEECH_CLONING_MODEL": "not-registered"},
        {"SPEECH_CLONING_MODEL": "kokoro-v1.0"},
        {"SPEECH_CLONING_MODEL": "moss-audio-tokenizer-nano-onnx"},  # a companion, not a cloning model
        {"SPEECH_CLONING_MODEL": "qwen3-tts-0.6b-mlx"},  # mlx only, and this is the cpu profile
    ],
)
def test_serve_refuses_a_bad_plan_before_starting(env, clean_env, monkeypatch, capsys):
    for k, v in env.items():
        clean_env.setenv(k, v)
    started = _serve_must_not_start(monkeypatch)
    loaded = []
    monkeypatch.setattr(cli, "_load_engines", lambda *a: loaded.append(a))
    assert cli.main(["serve", "--profile", "cpu"]) != 0
    err = capsys.readouterr().err
    assert err.startswith("error:") and len(err.strip().splitlines()) == 1
    assert not started and not loaded


def test_download_fetches_every_role(clean_env, monkeypatch, capsys, tmp_path):
    clean_env.setenv("SPEECH_DATA_DIR", str(tmp_path))
    clean_env.setenv("SPEECH_TTS_ZH_MODEL", "off")
    clean_env.setenv("SPEECH_CLONING_MODEL", "moss-tts-nano-onnx")
    fetched = []
    monkeypatch.setattr(
        cli, "ensure_model", lambda entry, d, progress=None: fetched.append(entry.id) or tmp_path
    )
    assert cli.main(["download", "--profile", "cpu"]) == 0
    assert fetched == [
        "faster-whisper-small",
        "kokoro-v1.0",
        "moss-tts-nano-onnx",
        "silero-vad-v6.2",
        "smart-turn-v3.2",
        "x-asr-zh-en-480ms",
        "moss-audio-tokenizer-nano-onnx",
    ]
    out = capsys.readouterr().out
    assert "stt_stream: x-asr-zh-en-480ms ->" in out


def test_download_respects_off(clean_env, monkeypatch, tmp_path):
    clean_env.setenv("SPEECH_DATA_DIR", str(tmp_path))
    for var in (
        "SPEECH_VAD_MODEL",
        "SPEECH_TURN_MODEL",
        "SPEECH_STREAM_STT_MODEL",
        "SPEECH_TTS_ZH_MODEL",
        "SPEECH_CLONING_MODEL",
    ):
        clean_env.setenv(var, "off")
    fetched = []
    monkeypatch.setattr(
        cli, "ensure_model", lambda entry, d, progress=None: fetched.append(entry.id) or tmp_path
    )
    assert cli.main(["download", "--profile", "cpu"]) == 0
    assert fetched == ["faster-whisper-small", "kokoro-v1.0"]


def test_engines_command_prints_the_cloning_role(capsys, clean_env):
    assert cli.main(["engines", "--profile", "mlx"]) == 0
    assert "cloning: qwen3-mlx / qwen3-tts-0.6b-mlx [weights Apache-2.0" in capsys.readouterr().out
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    assert "cloning: off" in capsys.readouterr().out  # opt-in on the CPU
    clean_env.setenv("SPEECH_CLONING_MODEL", "moss-tts-nano-onnx")
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "cloning: moss-onnx / moss-tts-nano-onnx" in out
    assert "cloning-companion: moss-audio-tokenizer-nano-onnx" in out
    clean_env.delenv("SPEECH_CLONING_MODEL")
    assert cli.main(["engines", "--profile", "cuda"]) == 0
    assert "cloning: off" in capsys.readouterr().out
