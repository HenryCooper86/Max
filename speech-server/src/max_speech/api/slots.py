"""Engines the app serves, mutable so models can finish loading after the server is already listening."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field

from max_speech.engines.base import StreamingSttEngine, SttEngine, TtsEngine, TurnDetector, VadEngine


@dataclass
class EngineSlots:
    stt: SttEngine | None = None
    tts: TtsEngine | None = None
    # Realtime listening, used by the session WebSocket only.
    vad: VadEngine | None = None
    turn: TurnDetector | None = None
    stt_stream: StreamingSttEngine | None = None
    second_pass: bool = False  # re-transcribe each finished turn with `stt` when it answers in time
    ready_event: threading.Event = field(default_factory=threading.Event)
    load_error: str | None = None
    # One lock per engine: the models are not re-entrant. asyncio locks, so a queued request parks a
    # coroutine rather than a threadpool thread, and a request that goes away while queued can be dropped.
    stt_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tts_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    vad_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stt_stream_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def ready(self) -> bool:
        return self.ready_event.is_set()

    def mark_ready(self) -> None:
        self.ready_event.set()

    def fail(self, message: str) -> None:
        self.load_error = message
