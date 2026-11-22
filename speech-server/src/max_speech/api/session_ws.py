"""`/v1/speech/session`: listen with VAD + streaming STT + smart-turn, and speak replies, over one WebSocket.

Concurrency, in one place:

- The route handler is the only reader. A single writer task owns every send: everything else puts messages on
  `outbox`, so JSON and audio frames never interleave.
- One worker task owns all the listening state (VAD stream, STT stream, `TurnTaker`). The receive loop only puts
  microphone bytes and ordered control markers on `inbox`.
- Every engine call runs in the threadpool through `run_serialized`, under that engine's asyncio lock, and the lock
  is kept until the thread has actually returned even if the session is cancelled meanwhile.
- Queues are bounded: at most `MAX_INBOX_BYTES` of microphone audio waits for the worker (overflow drops it and
  resets the turn: error `overrun`), and a client that lets more than `MAX_OUTBOX_BYTES` of audio pile up, or
  cannot take one message in `SEND_TIMEOUT_S`, is closed with 1008 `slow_reader`. Engine work is cut into pieces of
  at most `PIECE_S` of audio per lock hold, so one session cannot keep an engine from the others for long.
- Speaking is a separate `ReplySpeaker` (its own task, its own SynthJobs); it shares only the speech locks (one for
  preset voices, one for custom voices). Engine work is realtime for the MLX gate (engines/mlx_gate.py), and a
  closing session abandons whatever still waits for the gate, so it frees its slot without waiting for batch work.
- On disconnect the worker, the background second passes, the speaker and the writer are all cancelled and awaited.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass

import numpy as np
from fastapi import APIRouter, WebSocket

from max_speech.audio import INPUT_RATE, OUTPUT_RATE, pcm16_to_float
from max_speech.languages import WHISPER_LANGUAGES, primary_language
from max_speech.session.serial import run_serialized
from max_speech.session.speaking import ReplySpeaker
from max_speech.session.turns import (
    EAGERNESS,
    FeedStt,
    FinishTurn,
    RunTurnCheck,
    SpeechStarted,
    TurnEnded,
    TurnTaker,
    finalize_turn,
)
from max_speech.settings import Settings

log = logging.getLogger(__name__)

router = APIRouter()

PROTOCOL = "max-speech.session.v1"
MAX_ID_CHARS = 128
GENDERS = ("female", "male", "neutral")
BYTES_PER_SECOND_IN = INPUT_RATE * 2
MAX_INBOX_BYTES = 10 * BYTES_PER_SECOND_IN  # ~10 s of PCM16 waiting for the worker
MAX_EARLY_AUDIO_BYTES = MAX_INBOX_BYTES  # audio sent between connecting and `ready`
MAX_OUTBOX_BYTES = 5 * OUTPUT_RATE * 2  # ~5 s of PCM16 queued behind the message being sent
SEND_TIMEOUT_S = 5.0  # one send that takes longer: the client is not reading
PIECE_S = 1.0  # audio per engine lock hold


class _TurnEnd:
    """`turn.end`, queued among the audio so it applies after the audio that preceded it."""


class _Overrun:
    """The inbox overflowed and its audio was dropped: the worker restarts the turn."""


@dataclass(frozen=True)
class _Reconfigure:
    language: str | None
    keyterms: tuple[str, ...]


def _error(code: str, message: str, reply_id: str | None = None) -> dict:
    return {"type": "error", "code": code, "message": message, **({"id": reply_id} if reply_id else {})}


def _warning(code: str, message: str, **extra) -> dict:
    """A non-fatal notice: the session carries on, but not quite as asked."""
    return {"type": "warning", "code": code, "message": message, **extra}


def session_cap(settings: Settings, profile: str) -> int:
    return settings.session_limit(profile)


class _SessionTimeout(Exception):
    """The client was too slow or too quiet: tell it why, then close."""

    def __init__(self, code: str, message: str, close_code: int) -> None:
        super().__init__(message)
        self.code, self.message, self.close_code = code, message, close_code


class _Session:
    def __init__(
        self, ws: WebSocket, slots, clock=lambda: time.monotonic() * 1000, settings: Settings | None = None
    ) -> None:
        self.ws = ws
        self.slots = slots
        self.clock = clock
        self.settings = settings or Settings()
        self.farewell: tuple[dict, int] | None = (
            None  # sent just before closing, after the writer has stopped
        )
        self._warned: set[tuple] = set()
        self.outbox: asyncio.Queue[dict | bytes] = asyncio.Queue()
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.dead = False  # the writer failed: the peer is gone
        self.inbox_bytes = 0  # microphone audio queued in `inbox`
        self.outbox_bytes = 0  # audio queued in `outbox`
        self._closing: asyncio.Task | None = None
        self.background: set[asyncio.Task] = set()
        self.languages: tuple[str, ...] = ()
        self.keyterms: tuple[str, ...] = ()
        self.voice: str | None = None  # explicit, wins over gender
        self.gender = "female"
        self.eagerness = "normal"
        self.taker: TurnTaker | None = None
        self.speaker: ReplySpeaker | None = None
        self._vad_stream = None
        self._stt_stream = None
        self._samples = np.zeros(0, dtype=np.float32)
        self._odd = b""
        self._pending_stt: list[np.ndarray] = []

    # ---- output ------------------------------------------------------------------------------------------------
    def emit(self, item: dict | bytes) -> None:
        if self.dead:
            return
        if isinstance(item, bytes):
            # The backlog the writer has not started on. A reply's chunk is a whole sentence (many seconds of
            # audio), so judge the queue as it was before this chunk, not with the chunk in it.
            if self.outbox_bytes > MAX_OUTBOX_BYTES:
                self._closing = self._closing or asyncio.ensure_future(self._drop_slow_reader())
                return
            self.outbox_bytes += len(item)
        self.outbox.put_nowait(item)

    async def _drop_slow_reader(self) -> None:
        self.dead = True
        while not self.outbox.empty():
            self.outbox.get_nowait()
        log.warning("closing a session whose client is not reading")
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.ws.close(code=1008, reason="slow_reader"), 2)

    async def _write(self) -> None:
        while True:
            item = await self.outbox.get()
            if isinstance(item, bytes):
                self.outbox_bytes -= len(item)  # in flight now, no longer backlog
            try:
                if isinstance(item, bytes):
                    await asyncio.wait_for(self.ws.send_bytes(item), SEND_TIMEOUT_S)
                else:
                    await asyncio.wait_for(
                        self.ws.send_text(json.dumps(item, ensure_ascii=False)), SEND_TIMEOUT_S
                    )
            except TimeoutError:
                self._closing = self._closing or asyncio.ensure_future(self._drop_slow_reader())
                return
            except Exception:  # noqa: BLE001 - the peer went away (or the socket closed under us)
                self.dead = True
                return

    # ---- configuration -------------------------------------------------------------------------------------------
    @property
    def language(self) -> str | None:
        return self.languages[0] if len(self.languages) == 1 else None

    def warn_unsupported(self) -> None:
        """Say once per distinct request what the live (streaming) STT cannot do with it.

        A language the streaming model does not transcribe is still fine when the second pass re-transcribes every
        finished turn with Whisper; only the live partials are then unreliable, so it is not worth a warning."""
        stt = self.slots.stt_stream
        supported = getattr(stt, "languages", None)
        covered = bool(self.slots.second_pass and self.slots.stt is not None)
        if supported is not None and not covered:
            bad = tuple(lang for lang in self.languages if lang not in supported)
            if bad and ("language", bad) not in self._warned:
                self._warned.add(("language", bad))
                self.emit(
                    _warning(
                        "language_unsupported",
                        f"the live speech recognizer ({stt.model_id}) transcribes only "
                        f"{', '.join(supported)}; {', '.join(bad)} will not be recognised",
                        languages=list(bad),
                        supported=list(supported),
                    )
                )
        if self.keyterms and getattr(stt, "keyterms", True) is False and "keyterms" not in self._warned:
            self._warned.add("keyterms")
            self.emit(
                _warning(
                    "keyterms_unsupported",
                    f"the live speech recognizer ({stt.model_id}) does not support keyterms; they are ignored",
                )
            )

    def _effective_voice(self) -> str:
        tts = self.slots.tts
        return self.voice or tts.default_voice(self.gender, self.language)

    def apply_update(self, msg: dict) -> bool:
        """Apply a `session.update`; returns True when the STT stream needs recreating."""
        before = (self.languages, self.keyterms)
        langs = msg.get("languages")
        if langs is not None:
            if isinstance(langs, list) and all(isinstance(x, str) and x.strip() for x in langs):
                known = tuple(
                    dict.fromkeys(c for x in langs if (c := primary_language(x)) in WHISPER_LANGUAGES)
                )
                unknown = [x.strip() for x in langs if primary_language(x) not in WHISPER_LANGUAGES]
                if unknown:  # dropped: an engine given a code it does not know can only fail
                    self.emit(
                        _warning(
                            "language_unknown",
                            f"unrecognised language code(s) {', '.join(unknown)} ignored; use ISO 639-1 codes such as 'en' or 'zh'",
                            languages=unknown,
                        )
                    )
                self.languages = known
            else:
                self.emit(_error("bad_message", "languages must be a list of language codes"))
        terms = msg.get("keyterms")
        if terms is not None:
            if isinstance(terms, list) and all(isinstance(x, str) for x in terms):
                self.keyterms = tuple(x.strip() for x in terms if x.strip())
            else:
                self.emit(_error("bad_message", "keyterms must be a list of strings"))
        gender = msg.get("gender")
        if gender is not None:
            if gender in GENDERS:
                self.gender = gender
            else:
                self.emit(_error("bad_message", f"gender must be one of {', '.join(GENDERS)}"))
        voice = msg.get("voice")
        if voice is not None:
            if isinstance(voice, str) and voice in {v.id for v in self.slots.tts.voices()}:
                self.voice = voice
            else:
                self.emit(_error("unknown_voice", f"voice '{voice}' not found"))
        turn = msg.get("turn")
        if turn is not None:
            eagerness = turn.get("eagerness") if isinstance(turn, dict) else None
            if eagerness is None:
                pass
            elif eagerness in EAGERNESS:
                self.eagerness = eagerness
                if self.taker is not None:
                    self.taker.set_eagerness(eagerness)
            else:
                self.emit(_error("bad_message", f"turn.eagerness must be one of {', '.join(EAGERNESS)}"))
        if self.speaker is not None:
            self.speaker.voice = self._effective_voice()
            self.speaker.language = self.language
        return (self.languages, self.keyterms) != before

    # ---- lifecycle -----------------------------------------------------------------------------------------------
    async def serve(self) -> None:
        slots = self.slots
        writer = asyncio.create_task(self._write())
        worker: asyncio.Task | None = None
        try:
            early = await self._handshake_with_timeout()
            if early is None:
                return
            vad, stt = slots.vad, slots.stt_stream
            self._vad_stream = await run_serialized(slots.vad_lock, vad.new_stream)
            self._stt_stream = await run_serialized(
                slots.stt_stream_lock, lambda: stt.new_stream(language=self.language, keyterms=self.keyterms)
            )
            self.taker = TurnTaker(
                self.eagerness, frame_samples=self._vad_stream.frame_samples, rate=INPUT_RATE
            )
            self.speaker = ReplySpeaker(
                slots.tts, slots.speech_lock, self.emit, voice=self._effective_voice(), language=self.language
            )
            for chunk in early:
                self.inbox_bytes += len(chunk)
                self.inbox.put_nowait(chunk)
            worker = asyncio.create_task(self._work())
            ready = {
                "type": "ready",
                "protocol": PROTOCOL,
                "engines": {
                    "vad": vad.model_id,
                    "turn": slots.turn.model_id,
                    "stt": stt.model_id,
                    "tts": slots.tts.model_id,
                },
                # Whether a client that sends nothing is closed (null: never; dead peers are caught by ping).
                "idle_timeout_s": self.settings.session_idle_timeout_s or None,
            }
            # What the live recognizer can do, so a client need not ask for what it cannot get.
            if (languages := getattr(stt, "languages", None)) is not None:
                ready["languages"] = list(languages)
            if (keyterms := getattr(stt, "keyterms", None)) is not None:
                ready["keyterms"] = bool(keyterms)
            self.emit(ready)
            self.warn_unsupported()
            await self._receive_loop()
        except _SessionTimeout as timeout:
            log.info("closing a session: %s", timeout.code)
            self.farewell = (_error(timeout.code, timeout.message), timeout.close_code)
        finally:
            # Even when this handler is itself being cancelled, cleanup runs to the end: the engine locks must
            # not be released while a thread is still inside an engine.
            cleanup = asyncio.ensure_future(self._shutdown(worker, writer))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await asyncio.wait({cleanup})
                raise

    async def _shutdown(self, worker: asyncio.Task | None, writer: asyncio.Task) -> None:
        tasks: list[asyncio.Task] = [t for t in (worker, *self.background) if t is not None]
        for task in tasks:
            task.cancel()
        # Each cancelled task waits out any thread still inside an engine before it lets go of that engine's lock.
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.speaker is not None:
            await self.speaker.close()
        writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)
        if self._closing is not None:
            await asyncio.gather(self._closing, return_exceptions=True)
        if self.dead is False:
            if self.farewell is not None:
                message, code = self.farewell
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.ws.send_text(json.dumps(message)), 2)
                    await self.ws.close(code=code, reason=message["code"])
            with contextlib.suppress(Exception):
                await self.ws.close()  # a no-op when the client already left

    async def _recv(self):
        """The next client message: bytes, a parsed object, or None when the socket closed."""
        message = await self.ws.receive()
        if message["type"] == "websocket.disconnect":
            return None
        if message.get("bytes") is not None:
            return message["bytes"]
        try:
            msg = json.loads(message.get("text") or "")
        except ValueError:
            self.emit(_error("bad_message", "messages must be JSON objects or binary audio"))
            return {}
        if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
            self.emit(_error("bad_message", "a message must be a JSON object with a string 'type'"))
            return {}
        return msg

    async def _handshake_with_timeout(self) -> list[bytes] | None:
        limit = self.settings.session_handshake_timeout_s
        try:
            return await asyncio.wait_for(self._handshake(), limit or None)
        except TimeoutError:
            raise _SessionTimeout(
                "handshake_timeout",
                f"no session.update within {limit:g} s; send it right after connecting",
                1008,
            ) from None

    async def _handshake(self) -> list[bytes] | None:
        """Wait for the first `session.update`; audio that arrives first is kept for after `ready`."""
        early: list[bytes] = []
        size = 0
        while True:
            msg = await self._recv()
            if msg is None:
                return None
            if isinstance(msg, bytes):
                if size + len(msg) <= MAX_EARLY_AUDIO_BYTES:
                    early.append(msg)
                    size += len(msg)
                continue
            if not msg:
                continue  # already reported
            if msg["type"] == "session.update":
                self.apply_update(msg)
                return early
            self.emit(_error("no_session", "send session.update first"))

    async def _receive_loop(self) -> None:
        idle = self.settings.session_idle_timeout_s
        while not self.dead:
            try:
                msg = await asyncio.wait_for(self._recv(), idle or None)
            except TimeoutError:
                raise _SessionTimeout(
                    "idle_timeout", f"nothing received for {idle:g} s; the session was closed", 1000
                ) from None
            if msg is None:
                return
            if isinstance(msg, bytes):
                self._enqueue_audio(msg)
            elif msg:
                self._dispatch(msg)

    def _enqueue_audio(self, data: bytes) -> None:
        if self.inbox_bytes + len(data) <= MAX_INBOX_BYTES:
            self.inbox_bytes += len(data)
            self.inbox.put_nowait(data)
            return
        # The worker cannot keep up: drop the queued audio (control markers stay, in order) and restart the turn.
        kept = []
        while not self.inbox.empty():
            item = self.inbox.get_nowait()
            if not isinstance(item, bytes):
                kept.append(item)
        for item in kept:
            self.inbox.put_nowait(item)
        self.inbox.put_nowait(_Overrun())
        self.inbox_bytes = 0
        self.emit(
            _error("overrun", "audio arrived faster than it could be processed; the current turn was dropped")
        )

    def _dispatch(self, msg: dict) -> None:
        kind = msg["type"]
        if kind == "session.update":
            if self.apply_update(msg):
                self.inbox.put_nowait(_Reconfigure(self.language, self.keyterms))
            self.warn_unsupported()
        elif kind == "speak":
            rid, text, final = msg.get("id"), msg.get("text", ""), msg.get("final", False)
            if not isinstance(rid, str) or not rid or len(rid) > MAX_ID_CHARS:
                self.emit(_error("bad_message", "speak needs a non-empty string id"))
            elif not isinstance(text, str) or not isinstance(final, bool):
                self.emit(_error("bad_message", "speak needs string text and boolean final", rid))
            else:
                self.speaker.speak(rid, text, final)
        elif kind == "cancel":
            rid = msg.get("id")
            if isinstance(rid, str) and rid:
                self.speaker.cancel(rid)
            else:
                self.emit(_error("bad_message", "cancel needs a string id"))
        elif kind == "turn.end":
            self.inbox.put_nowait(_TurnEnd())
        else:
            self.emit(_error("unknown_type", f"unknown message type '{kind}'"))

    # ---- listening -----------------------------------------------------------------------------------------------
    async def _work(self) -> None:
        while True:
            item = await self.inbox.get()
            try:
                if isinstance(item, bytes):
                    self.inbox_bytes -= len(item)
                    await self._audio(item)
                elif isinstance(item, _TurnEnd):
                    await self._handle(self.taker.force_end(self.clock()))
                    await self._flush_stt()
                elif isinstance(item, _Reconfigure):
                    await self._reconfigure(item)
                elif isinstance(item, _Overrun):
                    await self._overrun()
            except asyncio.CancelledError:
                raise
            except Exception:  # an engine failed: tell the client, start the turn over, carry on
                log.exception("session worker failed")
                self.emit(_error("engine_error", "listening failed; the current turn was dropped"))
                await self._recover()

    def _drop_turn(self) -> None:
        """Forget the turn in progress; a client that saw `speech.started` still gets its `transcript.final`."""
        if self.taker.active:
            self.emit(
                {"type": "transcript.final", "text": "", "ms": {"turn": 0, "stt": 0}, "reason": "dropped"}
            )
        self._pending_stt.clear()
        self.taker.reset()

    async def _recover(self) -> None:
        self._drop_turn()
        with contextlib.suppress(Exception):
            await run_serialized(self.slots.stt_stream_lock, self._stt_stream.reset)

    async def _overrun(self) -> None:
        self._samples = np.zeros(0, dtype=np.float32)
        self._odd = b""
        self._drop_turn()
        await run_serialized(self.slots.vad_lock, self._vad_stream.reset)
        await run_serialized(self.slots.stt_stream_lock, self._stt_stream.reset)

    async def _reconfigure(self, item: _Reconfigure) -> None:
        stt = self.slots.stt_stream
        self._drop_turn()
        self._stt_stream = await run_serialized(
            self.slots.stt_stream_lock,
            lambda: stt.new_stream(language=item.language, keyterms=item.keyterms),
        )

    def _probabilities(self, frames: list[np.ndarray]) -> list[float]:
        return [self._vad_stream.probability(f) for f in frames]

    async def _audio(self, data: bytes) -> None:
        data = self._odd + data
        usable = len(data) // 2 * 2
        self._odd = data[usable:]
        if usable == 0:
            return
        samples = pcm16_to_float(data[:usable])
        self._samples = np.concatenate([self._samples, samples]) if len(self._samples) else samples
        size = self._vad_stream.frame_samples
        count = len(self._samples) // size
        if count == 0:
            return
        frames = [self._samples[i * size : (i + 1) * size] for i in range(count)]
        self._samples = self._samples[count * size :].copy()
        per_piece = max(1, int(PIECE_S * INPUT_RATE) // size)
        for start in range(0, count, per_piece):
            piece = frames[start : start + per_piece]
            probs = await run_serialized(self.slots.vad_lock, self._probabilities, piece)
            for p, frame in zip(probs, piece, strict=True):
                await self._handle(self.taker.push(p, frame, self.clock()))
            await self._flush_stt()

    async def _flush_stt(self) -> None:
        if not self._pending_stt:
            return
        audio = np.concatenate(self._pending_stt)
        self._pending_stt.clear()
        step = int(PIECE_S * INPUT_RATE)
        for start in range(0, len(audio), step):
            text = await run_serialized(
                self.slots.stt_stream_lock, self._stt_stream.accept, audio[start : start + step]
            )
            for event in self.taker.partial(text):
                self.emit({"type": "transcript.partial", "text": event.text})

    async def _handle(self, cmds) -> None:
        for cmd in cmds:
            if isinstance(cmd, SpeechStarted):
                self.emit({"type": "speech.started"})
            elif isinstance(cmd, FeedStt):
                self._pending_stt.append(cmd.audio)
            elif isinstance(cmd, RunTurnCheck):
                await self._flush_stt()
                p = await run_serialized(self.slots.turn_lock, self.slots.turn.turn_complete, cmd.audio)
                log.debug("turn check %d: p=%.2f", cmd.n, p)
                await self._handle(self.taker.turn_checked(p, self.clock()))
            elif isinstance(cmd, FinishTurn):
                await self._flush_stt()
                await self._finish_turn(cmd)

    async def _second_pass(self, audio: np.ndarray) -> str:
        slots, language = self.slots, self.language
        result = await run_serialized(
            slots.stt_lock, lambda: slots.stt.transcribe(audio, INPUT_RATE, language=language)
        )
        return result.text

    async def _finish_turn(self, cmd: FinishTurn) -> None:
        slots, stream = self.slots, self._stt_stream

        async def finish() -> str:
            return await run_serialized(slots.stt_stream_lock, stream.finish)

        # A busy batch engine cannot answer inside the deadline, so do not queue behind it.
        use_second = slots.second_pass and slots.stt is not None and not slots.stt_lock.locked()
        try:
            ended = await finalize_turn(
                cmd,
                finish=finish,
                second_pass=self._second_pass if use_second else None,
                clock=self.clock,
                background=self.background,
            )
        except Exception:  # the client must still get the turn's final transcript
            log.exception("finishing the turn failed")
            self.emit(_error("engine_error", "transcription failed for this turn"))
            ended = TurnEnded("", {"turn": cmd.turn_ms, "stt": 0})
        # Why the turn ended: a client that only wants the turns can tell a blip from speech nobody made out.
        self.emit({"type": "transcript.final", "text": ended.text, "ms": ended.ms, "reason": cmd.reason})
        await run_serialized(slots.stt_stream_lock, stream.reset)


@router.websocket("/v1/speech/session")
async def session(ws: WebSocket) -> None:
    slots = ws.app.state.slots
    await ws.accept()
    problem: tuple[dict, int] | None = None
    if slots.load_error:
        problem = (_error("load_failed", slots.load_error), 1011)
    elif not slots.ready:
        problem = (_error("loading", "models are still loading"), 1013)
    else:
        missing = [
            name
            for name, engine in (
                ("vad", slots.vad),
                ("turn", slots.turn),
                ("stt_stream", slots.stt_stream),
                ("tts", slots.tts),
            )
            if engine is None
        ]
        if missing:
            problem = (
                _error("engine_disabled", f"the session needs {', '.join(missing)}, which is disabled"),
                1011,
            )
    if problem is not None:
        await ws.send_text(json.dumps(problem[0]))
        await ws.close(code=problem[1])
        return
    settings = ws.app.state.settings
    cap = session_cap(settings, ws.app.state.profile)
    if slots.sessions >= cap:
        await ws.send_text(
            json.dumps(_error("busy", f"this server already has {cap} live session(s); try again shortly"))
        )
        await ws.close(code=1013, reason="busy")
        return
    slots.sessions += 1
    try:
        await _Session(ws, slots, settings=settings).serve()
    finally:
        slots.sessions -= 1
