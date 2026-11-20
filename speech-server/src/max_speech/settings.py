from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

PROFILES = ("cuda", "mlx", "cpu")
SECOND_PASS_MODES = ("on", "off", "auto")


def _default_data_dir() -> Path:
    return Path("~/.max-speech").expanduser()


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8790
    api_key: str | None = None
    data_dir: Path = field(default_factory=_default_data_dir)
    profile: str | None = None
    stt_engine: str | None = None
    tts_engine: str | None = None
    stt_model: str | None = None
    tts_model: str | None = None
    tts_zh_model: str | None = None  # model id, "off" to disable, None for the default
    # Live conversation (/v1/speech/session). Each is a registry id, "off" to disable, None for the default.
    vad_model: str | None = None
    turn_model: str | None = None
    stream_stt_model: str | None = None
    # Browser origins allowed to open the session WebSocket besides localhost (SPEECH_ALLOWED_ORIGINS, comma list).
    allowed_origins: tuple[str, ...] = ()
    second_pass: str = "auto"  # "on", "off", or "auto" (on for the mlx and cuda profiles)

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Settings:
        profile = env.get("SPEECH_PROFILE") or None
        if profile is not None and profile not in PROFILES:
            raise ValueError(f"SPEECH_PROFILE must be one of {', '.join(PROFILES)}; got {profile!r}")

        second_pass = (env.get("SPEECH_SECOND_PASS") or "auto").lower()
        if second_pass not in SECOND_PASS_MODES:
            raise ValueError(
                f"SPEECH_SECOND_PASS must be one of {', '.join(SECOND_PASS_MODES)}; got {second_pass!r}"
            )

        data_dir_env = env.get("SPEECH_DATA_DIR")
        return cls(
            api_key=env.get("SPEECH_API_KEY") or None,
            data_dir=Path(data_dir_env).expanduser() if data_dir_env else _default_data_dir(),
            profile=profile,
            stt_engine=env.get("SPEECH_STT_ENGINE") or None,
            tts_engine=env.get("SPEECH_TTS_ENGINE") or None,
            stt_model=env.get("SPEECH_STT_MODEL") or None,
            tts_model=env.get("SPEECH_TTS_MODEL") or None,
            tts_zh_model=env.get("SPEECH_TTS_ZH_MODEL") or None,
            vad_model=env.get("SPEECH_VAD_MODEL") or None,
            turn_model=env.get("SPEECH_TURN_MODEL") or None,
            stream_stt_model=env.get("SPEECH_STREAM_STT_MODEL") or None,
            allowed_origins=tuple(
                o.strip().rstrip("/").lower()
                for o in (env.get("SPEECH_ALLOWED_ORIGINS") or "").split(",")
                if o.strip()
            ),
            second_pass=second_pass,
        )
