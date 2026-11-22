"""Engines the app serves, mutable so models can finish loading after the server is already listening."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field

from max_speech.engines.base import (
    CloningTtsEngine,
    DesignEngine,
    StreamingSttEngine,
    SttEngine,
    TtsEngine,
    TurnDetector,
    VadEngine,
)
from max_speech.voices.candidates import CandidateCache
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore, is_custom_id


@dataclass
class EngineSlots:
    stt: SttEngine | None = None
    tts: TtsEngine | None = None  # a VoiceRouter once the app is built: preset voices plus custom ones
    # Voice cloning (milestone 3). `cloning` is None when no cloning model is loaded.
    cloning: CloningTtsEngine | None = None
    design: DesignEngine | None = None  # voice design; only set together with `cloning`
    candidates: CandidateCache = field(default_factory=CandidateCache)  # designed samples awaiting a choice
    voices: VoiceStore | None = None
    lexicon: Lexicon | None = None
    # Realtime listening, used by the session WebSocket only.
    vad: VadEngine | None = None
    turn: TurnDetector | None = None
    stt_stream: StreamingSttEngine | None = None
    second_pass: bool = False  # re-transcribe each finished turn with `stt` when it answers in time
    ready_event: threading.Event = field(default_factory=threading.Event)
    sessions: int = 0  # live WebSocket sessions open now, for the cap
    load_error: str | None = None  # the load failed for good
    retry_error: str | None = None  # the last attempt failed and another is pending: still loading
    # One lock per engine: the models are not re-entrant. asyncio locks, so a queued request parks a
    # coroutine rather than a threadpool thread, and a request that goes away while queued can be dropped.
    # Each is taken before the engine's thread takes MLX_GATE (engines/mlx_gate.py), never after.
    stt_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock
    )  # live calls; batch ones too unless it interleaves
    stt_batch_lock: asyncio.Lock = field(default_factory=asyncio.Lock)  # see `batch_stt_lock`
    # Preset voices (Kokoro, ONNX) and custom voices (the cloning engine, MLX on a Mac) are different models, so
    # they have separate locks: a preset sentence never queues behind a cloned one that is waiting for the GPU.
    tts_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cloning_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    vad_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stt_stream_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Transcription requests holding an upload (up to 25 MB) and its decoded audio (tens of MB), counted from
    # the upload to the response; `max_transcriptions` is set from the settings by create_app.
    transcriptions: int = 0
    max_transcriptions: int = 4
    decode_gate: asyncio.Semaphore | None = None  # created on first use, inside the running loop
    # Voice design requests in progress (api/voice_routes.py caps them) and the lock the running one holds.
    designs: int = 0
    design_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def ready(self) -> bool:
        return self.ready_event.is_set()

    def speech_lock(self, voice: str) -> asyncio.Lock:
        """The lock of the engine that speaks `voice`."""
        return self.cloning_lock if is_custom_id(voice) else self.tts_lock

    def batch_stt_lock(self) -> asyncio.Lock:
        """The lock for batch transcription (uploads, voice references).

        An engine that interleaves (MLX Whisper: a batch call gives the GPU to a waiting live call between windows)
        gets a lock of its own, so a long upload never makes a session skip its second pass; any other engine is
        shared with the second pass, which then skips while a batch call runs (`stt_lock.locked()`)."""
        return self.stt_batch_lock if getattr(self.stt, "interleaves", False) else self.stt_lock

    def install_tts(self, preset: TtsEngine | None, cloning: CloningTtsEngine | None = None) -> None:
        """Fill the TTS slot after startup: wraps `preset` in the router so custom voices work."""
        from max_speech.engines.router import VoiceRouter  # local: the router module imports the voice store

        assert self.voices is not None and self.lexicon is not None
        self.cloning = cloning
        self.tts = None if preset is None else VoiceRouter(preset, cloning, self.voices, self.lexicon)

    def mark_ready(self) -> None:
        self.ready_event.set()

    def fail(self, message: str) -> None:
        self.load_error = message
