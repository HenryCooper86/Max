"""Pick engines and models per hardware profile. Nothing heavy is imported here; the engine modules defer it."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from max_speech.engines.base import SttEngine, TtsEngine
from max_speech.engines.kokoro import KokoroTts
from max_speech.engines.whisper_ct2 import WhisperCt2Stt
from max_speech.engines.whisper_mlx import WhisperMlxStt
from max_speech.licenses import ModelEntry, load_registry, require
from max_speech.models import Progress, ensure_model
from max_speech.settings import Settings

log = logging.getLogger(__name__)

STT_ENGINES = ("whisper-ct2", "whisper-mlx")
TTS_ENGINES = ("kokoro",)
OFF = "off"

_DEFAULT_STT = {
    "cuda": ("whisper-ct2", "faster-whisper-large-v3-turbo"),
    "mlx": ("whisper-mlx", "mlx-whisper-large-v3-turbo"),
    "cpu": ("whisper-ct2", "faster-whisper-small"),
}
_DEFAULT_TTS = ("kokoro", "kokoro-v1.0")
# Chinese is spoken by a dedicated Kokoro model; SPEECH_TTS_ZH_MODEL overrides the id or turns it off.
_DEFAULT_TTS_ZH = "kokoro-v1.1-zh"
# Model to use when only the engine is overridden.
_STT_MODEL_FOR_ENGINE = {
    "whisper-mlx": "mlx-whisper-large-v3-turbo",
}


@dataclass(frozen=True)
class RolePlan:
    role: str  # "stt" or "tts"
    engine: str
    model_id: str


def _check_engine(role: str, engine: str, known: tuple[str, ...]) -> None:
    if engine not in known:
        raise ValueError(f"unknown {role} engine {engine!r}; choose one of {', '.join(known)} or {OFF}")


def plan(settings: Settings, profile: str) -> tuple[RolePlan | None, RolePlan | None]:
    """Resolve (stt, tts) engine and model ids from defaults and SPEECH_* overrides; None means off."""
    stt = tts = None
    if settings.stt_engine != OFF:
        default_engine, default_model = _DEFAULT_STT[profile]
        engine = settings.stt_engine or default_engine
        _check_engine("stt", engine, STT_ENGINES)
        if engine != default_engine:
            default_model = _STT_MODEL_FOR_ENGINE.get(
                engine, "faster-whisper-large-v3-turbo" if profile == "cuda" else "faster-whisper-small"
            )
        stt = RolePlan("stt", engine, settings.stt_model or default_model)
    if settings.tts_engine != OFF:
        engine = settings.tts_engine or _DEFAULT_TTS[0]
        _check_engine("tts", engine, TTS_ENGINES)
        tts = RolePlan("tts", engine, settings.tts_model or _DEFAULT_TTS[1])
    return stt, tts


def zh_model_id(settings: Settings, tts: RolePlan | None) -> str | None:
    """The registry id of the Chinese TTS model to load alongside Kokoro, or None."""
    if tts is None or tts.engine != "kokoro" or settings.tts_zh_model == OFF:
        return None
    return settings.tts_zh_model or _DEFAULT_TTS_ZH


def licensed(role_plan: RolePlan, registry: dict[str, ModelEntry] | None = None) -> ModelEntry:
    return require(role_plan.model_id, role_plan.role, registry=registry)


def _cuda_stt_or_cpu(path, model_id: str) -> SttEngine:
    """faster-whisper needs the CUDA 12 and cuDNN 9 libraries; without them, run the same model on the CPU."""
    try:
        stt = WhisperCt2Stt(path, model_id, device="cuda", compute_type="float16")
        stt.warm_up()  # missing libraries often only show up on the first inference
        return stt
    except Exception as exc:  # noqa: BLE001 - any CUDA failure should degrade, not kill the server
        log.warning(
            "faster-whisper on CUDA failed (%s: %s); falling back to CPU int8", type(exc).__name__, exc
        )
        return WhisperCt2Stt(path, model_id, device="cpu", compute_type="int8")


def build_engines(
    settings: Settings, profile: str, *, progress: Progress | None = None
) -> tuple[SttEngine | None, TtsEngine | None]:
    stt_plan, tts_plan = plan(settings, profile)
    registry = load_registry()
    # Check every license before the first download so a bad override fails fast.
    stt_entry = licensed(stt_plan, registry) if stt_plan else None
    tts_entry = licensed(tts_plan, registry) if tts_plan else None
    zh_id = zh_model_id(settings, tts_plan)
    zh_entry = require(zh_id, "tts", registry=registry) if zh_id else None

    stt: SttEngine | None = None
    tts: TtsEngine | None = None
    if stt_plan and stt_entry:
        log.info("loading stt %s (%s)", stt_plan.engine, stt_plan.model_id)
        path = ensure_model(stt_entry, settings.models_dir, progress=progress)
        if stt_plan.engine == "whisper-mlx":
            stt = WhisperMlxStt(path, stt_plan.model_id)
        elif profile == "cuda":
            stt = _cuda_stt_or_cpu(path, stt_plan.model_id)
        else:
            stt = WhisperCt2Stt(path, stt_plan.model_id, device="cpu", compute_type="int8")
    if tts_plan and tts_entry:
        log.info("loading tts %s (%s)", tts_plan.engine, tts_plan.model_id)
        path = ensure_model(tts_entry, settings.models_dir, progress=progress)
        zh_path = None
        if zh_entry:
            log.info("loading tts zh model %s", zh_entry.id)
            zh_path = ensure_model(zh_entry, settings.models_dir, progress=progress)
        tts = KokoroTts(
            path,
            tts_plan.model_id,
            use_cuda=profile == "cuda",
            zh_model_dir=zh_path,
            zh_model_id=zh_entry.id if zh_entry else _DEFAULT_TTS_ZH,
        )
    return stt, tts
