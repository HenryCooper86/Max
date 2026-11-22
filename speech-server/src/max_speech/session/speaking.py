"""Speaking: reply text in, 24 kHz PCM16 out, one reply at a time in the order the replies first appear."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from max_speech.api.openai_routes import SynthJob
from max_speech.audio import OUTPUT_RATE, float_to_pcm16, resample
from max_speech.chunker import SentenceChunker
from max_speech.engines.base import UnknownVoiceError

log = logging.getLogger(__name__)

Emit = Callable[[dict | bytes], None]  # must not block: the session puts it on its outbox

MAX_SPEAK_BYTES = 8 * 1024  # one `speak` message's text
MAX_REPLY_BYTES = 64 * 1024  # all the text of one reply
MAX_IN_FLIGHT = 2  # SynthJobs of one reply that are queued or running at once


def _pcm_chunks(tts, text: str, voice: str, language: str | None) -> Iterator[bytes]:
    for chunk in tts.synthesize(text, voice, language=language):
        yield float_to_pcm16(resample(chunk, tts.sample_rate, OUTPUT_RATE))


@dataclass
class _Reply:
    id: str
    voice: str
    chunker: SentenceChunker = field(default_factory=lambda: SentenceChunker(early_first_chunk=True))
    pending: list[str] = field(default_factory=list)  # chunks that arrived before the reply's turn
    todo: deque[str] = field(default_factory=deque)  # chunks of the active reply with no job yet
    jobs: deque[SynthJob] = field(default_factory=deque)  # created, not yet played, in order
    wake: asyncio.Event = field(default_factory=asyncio.Event)  # new text, final or cancel
    size: int = 0  # bytes of text received
    active: bool = False
    final: bool = False
    cancelled: bool = False
    started: bool = False  # audio.start sent
    done: bool = False  # audio.done sent


class ReplySpeaker:
    """Synthesizes replies through the shared TTS engine and hands audio to `emit`.

    A chunk is synthesized by a `SynthJob` (the same producer-queue the HTTP endpoint uses): it takes the engine's
    lock for one sentence, on that lock's own thread, and never blocks on whoever consumes the audio. A reply keeps at most
    `MAX_IN_FLIGHT` jobs queued or running and creates the next one when one finishes producing, so the next
    sentence is synthesized while the previous plays and other sessions (and HTTP requests) take their turn on the
    FIFO engine lock between them. Only the active reply has jobs; replies behind it keep their text until their
    turn. Text is capped per message and per reply.
    """

    def __init__(
        self,
        tts,
        lock: asyncio.Lock | Callable[[str], asyncio.Lock],
        emit: Emit,
        *,
        voice: str,
        language: str | None = None,
    ) -> None:
        """`lock` is the engine lock, or a function from a voice to the lock of the engine that speaks it (preset and
        custom voices are different engines with different locks)."""
        self.tts = tts
        self.lock_for = lock if callable(lock) else (lambda _voice: lock)
        self.emit = emit
        self.voice = voice
        self.language = language
        self._replies: dict[str, _Reply] = {}
        self._finished: dict[str, bool] = {}  # id -> cancelled, so late `speak`s for it are recognised
        self._order: asyncio.Queue[_Reply] = asyncio.Queue()
        self._runner: asyncio.Task | None = None

    # ---- input (synchronous, never blocks) --------------------------------------------------------------------
    def speak(self, reply_id: str, text: str, final: bool) -> None:
        size = len(text.encode())
        if size > MAX_SPEAK_BYTES:
            self._error(
                "speak_too_long",
                f"speak text is over {MAX_SPEAK_BYTES // 1024} KB; send smaller deltas",
                reply_id,
            )
            return
        if reply_id in self._finished:
            if not self._finished[reply_id]:
                self._error("bad_speak", f"reply '{reply_id}' has already ended", reply_id)
            return  # text trailing a cancelled reply is dropped
        reply = self._replies.get(reply_id)
        if reply is None:
            reply = self._replies[reply_id] = _Reply(reply_id, self.voice)
            self._order.put_nowait(reply)
            if self._runner is None:
                self._runner = asyncio.create_task(self._run())
        if reply.cancelled:
            return
        if reply.final:
            self._error("bad_speak", f"reply '{reply_id}' is already final", reply_id)
            return
        reply.size += size
        if reply.size > MAX_REPLY_BYTES:
            self._error(
                "reply_too_long",
                f"reply '{reply_id}' is over {MAX_REPLY_BYTES // 1024} KB; it was cancelled",
                reply_id,
            )
            self.cancel(reply_id)
            return
        chunks = reply.chunker.push(text) if text else []
        if final:
            chunks += reply.chunker.flush()
            reply.final = True
        for chunk in chunks:
            self._add(reply, chunk)
        reply.wake.set()

    def cancel(self, reply_id: str) -> None:
        reply = self._replies.get(reply_id)
        if reply is None or reply.done or reply.cancelled:
            return
        self._abandon(reply)
        if reply.active:
            reply.wake.set()  # the runner finishes it (and sends audio.done) once the job stops
        else:
            self._finish(reply, cancelled=True)  # still queued behind another reply: nothing to stop

    async def close(self) -> None:
        """Session over: stop everything, send nothing, and return once the engine lock is free again."""
        if self._runner is not None:
            self._runner.cancel()
        jobs = []
        for reply in self._replies.values():
            self._abandon(reply)
            jobs.extend(reply.jobs)
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*(job.wait() for job in jobs))
        if self._runner is not None:
            await asyncio.gather(self._runner, return_exceptions=True)

    # ---- internals ---------------------------------------------------------------------------------------------
    def _add(self, reply: _Reply, chunk: str) -> None:
        if not reply.active:
            reply.pending.append(chunk)
            return
        reply.todo.append(chunk)
        self._pump(reply)

    def _pump(self, reply: _Reply) -> None:
        """Start jobs for waiting chunks while fewer than MAX_IN_FLIGHT of the reply's jobs are still producing."""
        while reply.todo and not reply.cancelled and sum(not j.finished for j in reply.jobs) < MAX_IN_FLIGHT:
            chunk = reply.todo.popleft()
            job = SynthJob(
                self.lock_for(reply.voice), _pcm_chunks(self.tts, chunk, reply.voice, self.language)
            )
            job.on_finished(lambda r=reply: self._pump(r))
            reply.jobs.append(job)

    def _error(self, code: str, message: str, reply_id: str) -> None:
        # The id lets a client report one failing reply once instead of once per message it sent.
        self.emit({"type": "error", "code": code, "message": message, "id": reply_id})

    def _finish(self, reply: _Reply, *, cancelled: bool) -> None:
        if reply.done:
            return
        reply.done = True
        self._finished[reply.id] = cancelled
        self._replies.pop(reply.id, None)
        self.emit({"type": "audio.done", "id": reply.id, "cancelled": cancelled})

    async def _run(self) -> None:
        while True:
            reply = await self._order.get()
            if reply.done:
                continue  # cancelled while it waited its turn
            try:
                await self._play(reply)
            except asyncio.CancelledError:
                raise
            except Exception:  # one bad reply must not stop the ones behind it
                log.exception("speaking reply %s failed", reply.id)
                self._error("speak_failed", f"could not speak reply '{reply.id}'", reply.id)
                self._abandon(reply)
                self._finish(reply, cancelled=False)

    def _abandon(self, reply: _Reply) -> None:
        reply.cancelled = True
        reply.pending.clear()
        reply.todo.clear()
        for job in reply.jobs:
            job.cancel()

    async def _play(self, reply: _Reply) -> None:
        reply.active = True
        pending, reply.pending = reply.pending, []
        for chunk in pending:
            self._add(reply, chunk)
        while not reply.cancelled:
            self._pump(reply)
            if not reply.jobs:
                if reply.final and not reply.todo:
                    break
                reply.wake.clear()
                await reply.wake.wait()
                continue
            job = reply.jobs[0]
            try:
                async for pcm in job.chunks():
                    if reply.cancelled:
                        break
                    if not reply.started:
                        reply.started = True
                        self.emit({"type": "audio.start", "id": reply.id, "sampleRate": OUTPUT_RATE})
                    self.emit(pcm)
            except UnknownVoiceError:
                self._error("unknown_voice", f"voice '{reply.voice}' not found", reply.id)
                self._abandon(reply)
                self._finish(reply, cancelled=False)
                return
            except Exception:  # the engine failed on this sentence
                log.warning("synthesis for reply %s failed", reply.id, exc_info=True)
                self._error("tts_failed", "speech synthesis failed", reply.id)
                self._abandon(reply)
                self._finish(reply, cancelled=False)
                return
            finally:
                if reply.jobs and reply.jobs[0] is job:
                    reply.jobs.popleft()
        self._finish(reply, cancelled=reply.cancelled)
