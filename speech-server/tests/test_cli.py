import threading

import pytest

from max_speech import cli
from max_speech.api.slots import EngineSlots
from max_speech.app import create_app
from max_speech.engines.fake import FakeStt, FakeTts
from max_speech.settings import Settings


def test_engines_command_prints_resolved(capsys, clean_env):
    assert cli.main(["engines", "--profile", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "profile: cpu" in out
    assert "stt: whisper-ct2 / faster-whisper-small" in out
    assert "tts: kokoro / kokoro-v1.0" in out
    assert "weights Apache-2.0" in out


def test_engines_command_reports_off(capsys, clean_env):
    clean_env.setenv("SPEECH_STT_ENGINE", "off")
    assert cli.main(["engines", "--profile", "mlx"]) == 0
    out = capsys.readouterr().out
    assert "stt: off" in out


def test_engines_command_uses_detection(capsys, clean_env, monkeypatch):
    monkeypatch.setattr("max_speech.profile.detect_profile", lambda: "mlx")
    assert cli.main(["engines"]) == 0
    assert "stt: whisper-mlx / mlx-whisper-large-v3-turbo" in capsys.readouterr().out


def test_load_engines_success(monkeypatch):
    warmed = []

    class Warm(FakeTts):
        def warm_up(self):
            warmed.append("tts")

    monkeypatch.setattr(cli, "build_engines", lambda s, p, progress=None: (FakeStt(), Warm()))
    slots = EngineSlots(ready_event=threading.Event())
    cli._load_engines(slots, Settings(), "cpu")
    assert slots.ready and slots.load_error is None
    assert isinstance(slots.stt, FakeStt) and warmed == ["tts"]


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
