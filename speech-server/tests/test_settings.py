from pathlib import Path

import pytest

from max_speech.settings import Settings


def test_defaults(clean_env, tmp_path):
    clean_env.setenv("HOME", str(tmp_path))
    settings = Settings.from_env({})
    assert settings.host == "127.0.0.1"
    assert settings.port == 8790
    assert settings.api_key is None
    assert settings.data_dir == Path("~/.max-speech").expanduser()
    assert settings.profile is None
    assert settings.stt_engine is None
    assert settings.tts_engine is None
    assert settings.stt_model is None
    assert settings.tts_model is None
    assert settings.tts_zh_model is None
    assert settings.vad_model is None
    assert settings.turn_model is None
    assert settings.stream_stt_model is None
    assert settings.second_pass == "auto"


def test_models_dir_is_under_data_dir(tmp_path):
    settings = Settings.from_env({"SPEECH_DATA_DIR": str(tmp_path)})
    assert settings.data_dir == tmp_path
    assert settings.models_dir == tmp_path / "models"


def test_each_env_var_is_parsed(tmp_path):
    env = {
        "SPEECH_API_KEY": "secret",
        "SPEECH_DATA_DIR": str(tmp_path),
        "SPEECH_PROFILE": "cuda",
        "SPEECH_STT_ENGINE": "whisper-cuda",
        "SPEECH_TTS_ENGINE": "kokoro",
        "SPEECH_STT_MODEL": "faster-whisper-small",
        "SPEECH_TTS_MODEL": "kokoro-v1.0",
        "SPEECH_TTS_ZH_MODEL": "off",
        "SPEECH_VAD_MODEL": "silero-vad-v6.2",
        "SPEECH_TURN_MODEL": "off",
        "SPEECH_STREAM_STT_MODEL": "paraformer-zh-en-streaming",
        "SPEECH_SECOND_PASS": "ON",
    }
    settings = Settings.from_env(env)
    assert settings.api_key == "secret"
    assert settings.data_dir == tmp_path
    assert settings.profile == "cuda"
    assert settings.stt_engine == "whisper-cuda"
    assert settings.tts_engine == "kokoro"
    assert settings.stt_model == "faster-whisper-small"
    assert settings.tts_model == "kokoro-v1.0"
    assert settings.tts_zh_model == "off"
    assert settings.vad_model == "silero-vad-v6.2"
    assert settings.turn_model == "off"
    assert settings.stream_stt_model == "paraformer-zh-en-streaming"
    assert settings.second_pass == "on"


@pytest.mark.parametrize("value", ["on", "off", "auto"])
def test_second_pass_modes(value):
    assert Settings.from_env({"SPEECH_SECOND_PASS": value}).second_pass == value


def test_bad_second_pass_raises():
    with pytest.raises(ValueError, match="SPEECH_SECOND_PASS"):
        Settings.from_env({"SPEECH_SECOND_PASS": "maybe"})


@pytest.mark.parametrize("profile", ["cuda", "mlx", "cpu"])
def test_allowed_profiles(profile):
    assert Settings.from_env({"SPEECH_PROFILE": profile}).profile == profile


def test_bad_profile_raises_naming_allowed_values():
    with pytest.raises(ValueError) as info:
        Settings.from_env({"SPEECH_PROFILE": "gpu"})
    message = str(info.value)
    assert "SPEECH_PROFILE" in message
    for allowed in ("cuda", "mlx", "cpu"):
        assert allowed in message


def test_empty_api_key_is_none():
    assert Settings.from_env({"SPEECH_API_KEY": ""}).api_key is None


def test_settings_is_frozen():
    settings = Settings.from_env({})
    with pytest.raises(AttributeError):
        settings.port = 9999  # type: ignore[misc]
