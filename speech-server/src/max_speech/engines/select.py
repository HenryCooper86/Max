"""Pick engines and models per hardware profile. Nothing heavy is imported here; the engine modules defer it."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from max_speech.engines.base import (
    CloningTtsEngine,
    StreamingSttEngine,
    SttEngine,
    TtsEngine,
    TurnDetector,
    VadEngine,
)
from max_speech.engines.kokoro import KokoroTts
from max_speech.engines.streaming_sherpa import SherpaStreamingStt
from max_speech.engines.whisper_ct2 import WhisperCt2Stt
from max_speech.engines.whisper_mlx import WhisperMlxStt
from max_speech.licenses import LicenseError, ModelEntry, companions, load_registry, require
from max_speech.models import Progress, ensure_model
from max_speech.settings import PROFILES, Settings

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
# Live conversation models: one default for every profile (they are small and run on the CPU).
_DEFAULT_VAD = ("silero", "silero-vad-v6.2")
_DEFAULT_TURN = ("smart-turn", "smart-turn-v3.2")
_DEFAULT_STREAM_STT = "x-asr-zh-en-480ms"
# Streaming recognizers are transducers unless listed here.
_STREAM_STT_KIND = {"paraformer-zh-en-streaming": "paraformer"}
# Voice cloning, one engine per registry model. `None` means off by default for that profile.
# cpu: MOSS-TTS-Nano costs about 2 GB of RAM and a 730 MB download, too much to switch on silently on a small
# server, so it is opt-in (SPEECH_CLONING_MODEL=moss-tts-nano-onnx).
# cuda: no cloning engine has been tested on CUDA yet, so it stays off until one is.
_DEFAULT_CLONING = {"mlx": "qwen3-tts-0.6b-mlx", "cpu": None, "cuda": None}
_CLONING_ENGINE = {
    "qwen3-tts-0.6b-mlx": "qwen3-mlx",
    "qwen3-tts-1.7b-mlx": "qwen3-mlx",
    "moss-tts-nano-onnx": "moss-onnx",
}
_CLONING_PROFILES = {"qwen3-mlx": ("mlx",)}  # engines that only run on some profiles
_SECOND_PASS_PROFILES = ("mlx", "cuda")
# Model to use when only the engine is overridden.
_STT_MODEL_FOR_ENGINE = {
    "whisper-mlx": "mlx-whisper-large-v3-turbo",
}


@dataclass(frozen=True)
class RolePlan:
    role: str  # "stt", "tts", "cloning", "vad", "turn" or "stt_stream"
    engine: str
    model_id: str

    @property
    def kind(self) -> str:
        """The registry kind the model must have; the streaming recognizer is an stt model, cloning a tts one."""
        return {"stt_stream": "stt", "cloning": "tts"}.get(self.role, self.role)


@dataclass(frozen=True)
class Plan:
    stt: RolePlan | None  # batch transcription: /v1/audio/transcriptions and the optional second pass
    tts: RolePlan | None
    vad: RolePlan | None
    turn: RolePlan | None
    stt_stream: RolePlan | None
    second_pass: bool  # whether the session should run the batch model over each finished utterance
    cloning: RolePlan | None = None  # voice cloning; needs `tts` (custom voices sit beside its preset ones)

    def roles(self) -> Iterator[RolePlan]:
        """The roles that are on, in load order."""
        yield from filter(None, (self.stt, self.tts, self.cloning, self.vad, self.turn, self.stt_stream))


@dataclass
class Engines:
    stt: SttEngine | None = None
    tts: TtsEngine | None = None
    vad: VadEngine | None = None
    turn: TurnDetector | None = None
    stt_stream: StreamingSttEngine | None = None
    second_pass: bool = False
    cloning: CloningTtsEngine | None = None

    def loaded(self) -> list:
        return [
            e
            for e in (self.stt, self.tts, self.cloning, self.vad, self.turn, self.stt_stream)
            if e is not None
        ]


def _check_engine(role: str, engine: str, known: tuple[str, ...]) -> None:
    if engine not in known:
        raise ValueError(f"unknown {role} engine {engine!r}; choose one of {', '.join(known)} or {OFF}")


def _live_role(role: str, default: tuple[str, str], override: str | None) -> RolePlan | None:
    if override == OFF:
        return None
    return RolePlan(role, default[0], override or default[1])


def plan(settings: Settings, profile: str) -> Plan:
    """Resolve every role's engine and model id from defaults and SPEECH_* overrides; None means off."""
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
    cloning = None
    if tts is not None and settings.cloning_model != OFF:
        model_id = settings.cloning_model or _DEFAULT_CLONING[profile]
        if model_id is not None:
            engine = _CLONING_ENGINE.get(model_id)
            if engine is None:
                known = ", ".join(sorted(_CLONING_ENGINE))
                raise ValueError(f"no cloning engine for {model_id!r}; choose one of {known} or {OFF}")
            if profile not in _CLONING_PROFILES.get(engine, PROFILES):
                raise ValueError(
                    f"cloning model {model_id} runs on the {'/'.join(_CLONING_PROFILES[engine])} profile only, "
                    f"not {profile}"
                )
            cloning = RolePlan("cloning", engine, model_id)
    vad = _live_role("vad", _DEFAULT_VAD, settings.vad_model)
    turn = _live_role("turn", _DEFAULT_TURN, settings.turn_model)
    stt_stream = None
    if settings.stream_stt_model != OFF:
        model_id = settings.stream_stt_model or _DEFAULT_STREAM_STT
        stt_stream = RolePlan(
            "stt_stream", f"sherpa-{_STREAM_STT_KIND.get(model_id, 'transducer')}", model_id
        )
    if settings.second_pass == "auto":
        second_pass = profile in _SECOND_PASS_PROFILES
    else:
        second_pass = settings.second_pass == "on"
    return Plan(stt, tts, vad, turn, stt_stream, second_pass and stt is not None, cloning)


def zh_model_id(settings: Settings, tts: RolePlan | None) -> str | None:
    """The registry id of the Chinese TTS model to load alongside Kokoro, or None."""
    if tts is None or tts.engine != "kokoro" or settings.tts_zh_model == OFF:
        return None
    return settings.tts_zh_model or _DEFAULT_TTS_ZH


def licensed(role_plan: RolePlan, registry: dict[str, ModelEntry] | None = None) -> ModelEntry:
    registry = load_registry() if registry is None else registry
    entry = require(role_plan.model_id, role_plan.kind, registry=registry)
    if role_plan.role == "stt_stream" and not entry.streaming:
        streaming = sorted(e.id for e in registry.values() if e.kind == "stt" and e.streaming)
        raise LicenseError(
            f"{entry.id} is not a streaming model, so it cannot be the session's STT "
            f"(SPEECH_STREAM_STT_MODEL); choose one of: {', '.join(streaming)}"
        )
    if role_plan.role == "cloning" and not entry.cloning:
        cloning = sorted(e.id for e in registry.values() if e.cloning)
        raise LicenseError(
            f"{entry.id} cannot clone voices, so it cannot be the cloning model "
            f"(SPEECH_CLONING_MODEL); choose one of: {', '.join(cloning)}"
        )
    return entry


def cloning_companions(
    role_plan: RolePlan, registry: dict[str, ModelEntry] | None = None
) -> list[ModelEntry]:
    """The license-checked models the cloning model needs beside itself (e.g. an audio codec)."""
    registry = load_registry() if registry is None else registry
    return companions(licensed(role_plan, registry), registry)


def _build_cloning(role_plan: RolePlan, entry: ModelEntry, paths: dict[str, Path]) -> CloningTtsEngine:
    """Imports the engine module late: it may need mlx or onnxruntime. `paths` maps model ids to directories."""
    if role_plan.engine == "qwen3-mlx":
        from max_speech.engines.qwen3_mlx import Qwen3MlxCloning

        return Qwen3MlxCloning(paths[entry.id], entry.id)
    if role_plan.engine == "moss-onnx":
        from max_speech.engines.moss_onnx import MossNanoCloning

        (codec,) = entry.requires
        return MossNanoCloning(paths[entry.id], paths[codec], entry.id)
    raise ValueError(f"unknown cloning engine {role_plan.engine!r}")


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


def _build_vad(path: Path, model_id: str) -> VadEngine:
    from max_speech.engines.silero_vad import SileroVad  # imported late: the module may pull in onnxruntime

    return SileroVad(path, model_id=model_id)


def _build_turn(path: Path, model_id: str) -> TurnDetector:
    from max_speech.engines.smart_turn import SmartTurn

    return SmartTurn(path, model_id=model_id)


def build_engines(settings: Settings, profile: str, *, progress: Progress | None = None) -> Engines:
    the_plan = plan(settings, profile)
    registry = load_registry()
    # Check every license before the first download so a bad override fails fast.
    entries = {p.role: licensed(p, registry) for p in the_plan.roles()}
    zh_id = zh_model_id(settings, the_plan.tts)
    zh_entry = require(zh_id, "tts", registry=registry) if zh_id else None

    clone_companions = cloning_companions(the_plan.cloning, registry) if the_plan.cloning else []

    out = Engines(second_pass=the_plan.second_pass)
    if the_plan.stt:
        stt_plan = the_plan.stt
        log.info("loading stt %s (%s)", stt_plan.engine, stt_plan.model_id)
        path = ensure_model(entries["stt"], settings.models_dir, progress=progress)
        if stt_plan.engine == "whisper-mlx":
            out.stt = WhisperMlxStt(path, stt_plan.model_id)
        elif profile == "cuda":
            out.stt = _cuda_stt_or_cpu(path, stt_plan.model_id)
        else:
            out.stt = WhisperCt2Stt(path, stt_plan.model_id, device="cpu", compute_type="int8")
    if the_plan.tts:
        tts_plan = the_plan.tts
        log.info("loading tts %s (%s)", tts_plan.engine, tts_plan.model_id)
        path = ensure_model(entries["tts"], settings.models_dir, progress=progress)
        zh_path = None
        if zh_entry:
            log.info("loading tts zh model %s", zh_entry.id)
            zh_path = ensure_model(zh_entry, settings.models_dir, progress=progress)
        out.tts = KokoroTts(
            path,
            tts_plan.model_id,
            use_cuda=profile == "cuda",
            zh_model_dir=zh_path,
            zh_model_id=zh_entry.id if zh_entry else _DEFAULT_TTS_ZH,
        )
    if the_plan.cloning:
        clone = the_plan.cloning
        log.info("loading cloning %s (%s)", clone.engine, clone.model_id)
        try:
            paths = {
                e.id: ensure_model(e, settings.models_dir, progress=progress)
                for e in (*clone_companions, entries["cloning"])
            }
            out.cloning = _build_cloning(clone, entries["cloning"], paths)
        except Exception as exc:
            if settings.cloning_model is not None:
                raise  # explicitly configured: fail loudly
            log.warning(
                "voice cloning is unavailable, continuing without it (%s: %s)", type(exc).__name__, exc
            )
    if the_plan.vad:
        log.info("loading vad %s", the_plan.vad.model_id)
        out.vad = _build_vad(
            ensure_model(entries["vad"], settings.models_dir, progress=progress), the_plan.vad.model_id
        )
    if the_plan.turn:
        log.info("loading turn detector %s", the_plan.turn.model_id)
        out.turn = _build_turn(
            ensure_model(entries["turn"], settings.models_dir, progress=progress), the_plan.turn.model_id
        )
    if the_plan.stt_stream:
        ss = the_plan.stt_stream
        log.info("loading streaming stt %s", ss.model_id)
        path = ensure_model(entries["stt_stream"], settings.models_dir, progress=progress)
        out.stt_stream = SherpaStreamingStt(path, ss.engine.removeprefix("sherpa-"), model_id=ss.model_id)
    return out
