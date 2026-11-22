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
    cloning_model: str | None = (
        None  # voice cloning model id (a registry entry with cloning = true), "off", or default
    )
    # Voice design (a registry entry with design = true), "off", or the default. Needs cloning to be on.
    design_model: str | None = None
    # Live conversation (/v1/speech/session). Each is a registry id, "off" to disable, None for the default.
    vad_model: str | None = None
    turn_model: str | None = None
    stream_stt_model: str | None = None
    # Browser origins allowed to open the session WebSocket besides localhost (SPEECH_ALLOWED_ORIGINS, comma list).
    allowed_origins: tuple[str, ...] = ()
    second_pass: str = "auto"  # "on", "off", or "auto" (on for the mlx and cuda profiles)
    # Model loading: a transient failure (network, download) is retried with doubling backoff; when the attempts
    # run out the process exits non-zero so a supervisor (Docker, launchd, systemd) restarts it.
    load_attempts: int = 4
    load_backoff_s: float = 5.0
    # Live sessions. None means the profile's default (see `session_limit`); 0 disables a timeout.
    max_sessions: int | None = None
    session_handshake_timeout_s: float = 15.0  # from connect to the first `session.update`
    # With nothing received from the client (audio or JSON). Off by default: the relay sends no audio while the rider
    # is muted, so a timeout would drop muted riders; a dead peer is caught by the WebSocket ping instead (cli.py).
    session_idle_timeout_s: float = 0.0
    # Transcription requests in flight at once (upload, decode and queue for the engine); more get a 429.
    max_transcriptions: int = 4
    # Seconds a transcription request may take to send its body (it holds one of `max_transcriptions` meanwhile); 0 is
    # off. 300 s carries the largest upload (25 MB) at about 0.7 Mbit/s, slower than any LAN or phone link Max uses.
    upload_timeout_s: float = 300.0

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    def session_limit(self, profile: str) -> int:
        """Concurrent live sessions: each parks VAD and STT state, and every turn shares one TTS and STT engine."""
        if self.max_sessions is not None:
            return self.max_sessions
        return {"cuda": 8, "mlx": 4}.get(profile, 2)

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

        def number(name: str, default, kind, *, minimum):
            raw = env.get(name)
            if raw is None or not raw.strip():
                return default
            try:
                value = kind(raw)
            except ValueError:
                raise ValueError(f"{name} must be a number; got {raw!r}") from None
            if value < minimum:
                raise ValueError(f"{name} must be at least {minimum}; got {raw!r}")
            return value

        max_sessions = number("SPEECH_MAX_SESSIONS", None, int, minimum=1)
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
            cloning_model=env.get("SPEECH_CLONING_MODEL") or None,
            design_model=env.get("SPEECH_DESIGN_MODEL") or None,
            vad_model=env.get("SPEECH_VAD_MODEL") or None,
            turn_model=env.get("SPEECH_TURN_MODEL") or None,
            stream_stt_model=env.get("SPEECH_STREAM_STT_MODEL") or None,
            allowed_origins=tuple(
                o.strip().rstrip("/").lower()
                for o in (env.get("SPEECH_ALLOWED_ORIGINS") or "").split(",")
                if o.strip()
            ),
            second_pass=second_pass,
            load_attempts=number("SPEECH_LOAD_ATTEMPTS", cls.load_attempts, int, minimum=1),
            load_backoff_s=number("SPEECH_LOAD_BACKOFF_S", cls.load_backoff_s, float, minimum=0),
            max_sessions=max_sessions,
            session_handshake_timeout_s=number(
                "SPEECH_SESSION_HANDSHAKE_TIMEOUT_S", cls.session_handshake_timeout_s, float, minimum=0
            ),
            session_idle_timeout_s=number(
                "SPEECH_SESSION_IDLE_TIMEOUT_S", cls.session_idle_timeout_s, float, minimum=0
            ),
            max_transcriptions=number("SPEECH_MAX_TRANSCRIPTIONS", cls.max_transcriptions, int, minimum=1),
            upload_timeout_s=number("SPEECH_UPLOAD_TIMEOUT_S", cls.upload_timeout_s, float, minimum=0),
        )
