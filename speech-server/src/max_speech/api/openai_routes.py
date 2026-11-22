from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import weakref
from collections import deque
from collections.abc import AsyncIterator, Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import soundfile as sf
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from max_speech.api.errors import OpenAIError
from max_speech.audio import (
    INPUT_RATE,
    OUTPUT_RATE,
    AudioDecodeError,
    decode_audio,
    float_to_pcm16,
    resample,
    wav_bytes,
)
from max_speech.engines.base import UnknownVoiceError
from max_speech.engines.mlx_gate import Abandoned, Ticket, working_for
from max_speech.engines.router import speech_engine_id
from max_speech.languages import whisper_language

log = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_INPUT_CHARS = 4096
MAX_DURATION_S = 15 * 60
# A worst-case upload decodes to ~110 MB of float32 (15 min, 48 kHz, stereo) and keeps a core busy for seconds, so
# only this many decode at once; the rest of the requests in flight wait their turn, bounded by `max_transcriptions`.
MAX_CONCURRENT_DECODES = 2
RETRY_AFTER_S = 2

MODEL_ALIASES = ("tts-1", "tts-1-hd", "gpt-4o-mini-tts", "whisper-1", "gpt-4o-transcribe")
FEMALE_VOICES = frozenset({"alloy", "nova", "shimmer", "coral", "sage"})
MALE_VOICES = frozenset({"onyx", "echo", "ash", "ballad", "fable", "verse"})
COMPRESSED_FORMATS = frozenset({"mp3", "opus", "aac", "flac"})


async def require_ready(request: Request) -> None:
    slots = request.app.state.slots
    if slots.ready:
        return
    if slots.load_error:
        raise OpenAIError(503, slots.load_error, type="server_error", code="load_failed")
    raise OpenAIError(503, "models are still loading", type="server_error", code="loading")


router = APIRouter(prefix="/v1", dependencies=[Depends(require_ready)])


def _disabled(kind: str) -> OpenAIError:
    return OpenAIError(
        503, f"the {kind} engine is disabled on this server", type="server_error", code="engine_disabled"
    )


class SpeechRequest(BaseModel):
    # `model` is accepted but never used to pick an engine: Max sends "kokoro", others "tts-1".
    model: str | None = None
    input: str
    voice: str = "default"
    response_format: str = "wav"
    speed: float = Field(1.0, ge=0.25, le=4.0)
    stream_format: Literal["audio", "sse"] | None = None
    language: str | None = None

    @field_validator("input")
    @classmethod
    def _input(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("input must not be empty")
        if len(v) > MAX_INPUT_CHARS:
            raise ValueError(f"input must be at most {MAX_INPUT_CHARS} characters")
        return v


def resolve_voice(tts, requested: str) -> str:
    ids = [v.id for v in tts.voices()]
    if requested in ids:
        return requested
    if requested in FEMALE_VOICES:
        return tts.default_voice("female")
    if requested in MALE_VOICES:
        return tts.default_voice("male")
    if requested == "default":
        return tts.default_voice()
    raise OpenAIError(
        404,
        f"voice '{requested}' not found; available voices: {', '.join(ids[:10])}",
        param="voice",
        code="voice_not_found",
    )


def _pcm_chunks(tts, text: str, voice: str, speed: float, language: str | None) -> Iterator[bytes]:
    for chunk in tts.synthesize(text, voice, speed=speed, language=language):
        yield float_to_pcm16(resample(chunk, tts.sample_rate, OUTPUT_RATE))


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


_END = object()
# One long-lived thread per engine lock. Jobs under one lock never overlap, so one thread is all they need, and keeping
# it warm matters: a new thread costs Kokoro's phonemizer and MLX a fresh per-thread setup (about 0.6 s measured).
_THREADS: weakref.WeakKeyDictionary[asyncio.Lock, ThreadPoolExecutor] = weakref.WeakKeyDictionary()


def _thread_for(lock: asyncio.Lock) -> ThreadPoolExecutor:
    thread = _THREADS.get(lock)
    if thread is None:
        thread = _THREADS[lock] = ThreadPoolExecutor(max_workers=1, thread_name_prefix="synth")
    return thread


class SynthJob:
    """Produces audio under the engine lock, separately from whoever consumes it.

    The consumer only drains an unbounded queue, so a slow or stalled client can never hold the engine.
    Cancelling stops production between chunks (and instantly while still queued for the lock, or while its thread
    waits for the MLX gate). The work is realtime for the MLX gate unless `realtime=False`.

    The generator runs on the lock's own thread (`_thread_for`), not the shared threadpool: MLX keeps GPU streams per
    thread, and a streamed synthesis whose next chunk is computed on another thread fails ("There is no Stream(gpu, N)
    in current thread"), which happens as soon as other sessions keep the shared pool busy.
    """

    def __init__(self, lock: asyncio.Lock, gen: Iterator[bytes], *, realtime: bool = True) -> None:
        self._lock = lock
        self._gen = gen
        self._ticket = Ticket(realtime=realtime)
        self._thread = _thread_for(lock)
        self._cancelled = False
        self._running = False
        self.queue: asyncio.Queue = asyncio.Queue()
        self._task = asyncio.create_task(self._run())

    def cancel(self) -> None:
        self._cancelled = True
        self._ticket.abandon()  # a thread waiting for the MLX gate gives up now
        if not self._running:
            # Still waiting for the lock (or not started): safe to cancel, no thread is involved yet.
            self._task.cancel()

    @property
    def finished(self) -> bool:
        """Production has ended (completed, failed or cancelled)."""
        return self._task.done()

    def on_finished(self, callback: Callable[[], None]) -> None:
        self._task.add_done_callback(lambda _t: callback())

    async def wait(self) -> None:
        """Returns once production has stopped and the engine lock has been released."""
        await asyncio.wait({self._task})

    def _next(self):
        with working_for(self._ticket):
            return next(self._gen, _END)

    async def _on_thread(self, fn):
        return await asyncio.get_running_loop().run_in_executor(self._thread, fn)

    async def _run(self) -> None:
        try:
            if self._cancelled:
                return
            async with self._lock:
                if self._cancelled:
                    return
                self._running = True
                try:
                    while not self._cancelled:
                        chunk = await self._on_thread(self._next)
                        if chunk is _END:
                            break
                        self.queue.put_nowait(chunk)
                finally:
                    # The worker thread is idle here (we never cancel mid-chunk), so close is safe.
                    await self._on_thread(self._gen.close)
            self.queue.put_nowait(_END)
        except asyncio.CancelledError:
            self.queue.put_nowait(_END)
        except Exception as exc:  # noqa: BLE001 - handed to the consumer, which re-raises it
            # Once cancelled nobody wants the audio, and the failure may only be the abandoned wait for the gate.
            self.queue.put_nowait(_END if self._cancelled else exc)

    async def chunks(self) -> AsyncIterator[bytes]:
        while True:
            item = await self.queue.get()
            if item is _END:
                return
            if isinstance(item, BaseException):
                raise item
            yield item


MAX_IN_FLIGHT = 2  # sentence jobs of one request queued or running at once


class SentenceJobs:
    """Speaks `text` one sentence per SynthJob, so each holds the engine's lock for one sentence and other sessions get
    the engine between two; at most `MAX_IN_FLIGHT` are queued or running, and the audio comes out in order. The audio
    is exactly what one synthesis of the whole text gives (a custom voice's downsampler carries over between sentences).

    It has the consumer side of a SynthJob: `chunks()` and `cancel()`."""

    def __init__(
        self,
        tts,
        lock: asyncio.Lock,
        text: str,
        voice: str,
        *,
        speed: float = 1.0,
        language: str | None = None,
        realtime: bool = True,
    ) -> None:
        self._tts, self._lock, self._voice = tts, lock, voice
        self._speed, self._language, self._realtime = speed, language, realtime
        # A bare engine (not the VoiceRouter, which every server installs) is spoken in one job, as it is given.
        self._routed = hasattr(tts, "sentences")
        self._down = tts.down_resampler(voice) if self._routed else None
        self._sentences = deque(tts.sentences(text) if self._routed else [text])
        self._jobs: deque[SynthJob] = deque()
        self._cancelled = False
        self._pump()

    def _pcm(self, sentence: str) -> Iterator[bytes]:
        tts = self._tts
        extra = {"lexicon": False, "resampler": self._down} if self._routed else {}
        chunks = tts.synthesize(sentence, self._voice, speed=self._speed, language=self._language, **extra)
        for chunk in chunks:
            yield float_to_pcm16(resample(chunk, tts.sample_rate, OUTPUT_RATE))

    def _pump(self) -> None:
        # Jobs are created in sentence order and asyncio.Lock is FIFO, so they also produce in order: the shared
        # downsampler is never used by two at once.
        while (
            self._sentences
            and not self._cancelled
            and sum(not j.finished for j in self._jobs) < MAX_IN_FLIGHT
        ):
            job = SynthJob(self._lock, self._pcm(self._sentences.popleft()), realtime=self._realtime)
            job.on_finished(self._pump)
            self._jobs.append(job)

    def cancel(self) -> None:
        self._cancelled = True
        self._sentences.clear()
        for job in self._jobs:
            job.cancel()

    async def chunks(self) -> AsyncIterator[bytes]:
        while self._jobs:
            async for chunk in self._jobs[0].chunks():
                yield chunk
            self._jobs.popleft()
            self._pump()
        if self._down is not None and not self._cancelled:
            tail = self._down.flush()
            if len(tail):
                yield float_to_pcm16(resample(tail, self._tts.sample_rate, OUTPUT_RATE))


@asynccontextmanager
async def batch_ticket(request: Request) -> AsyncIterator[Ticket]:
    """A batch ticket of this request's own, abandoned when the client disconnects, so its MLX work stops at the next
    yield point (a Whisper window, a design chunk) and gives back the GPU, its engine lock and its place."""
    ticket = Ticket()

    async def watch() -> None:
        while not await request.is_disconnected():
            await asyncio.sleep(0.05)
        ticket.abandon()

    watcher = asyncio.create_task(watch())
    try:
        yield ticket
    finally:
        watcher.cancel()
        ticket.abandon()  # the request is over however it ended: nothing may keep working for it


async def run_for[T](ticket: Ticket, fn: Callable[[], T]) -> T:
    """`run_in_threadpool(fn)` on behalf of `ticket`, like `run_serialized`: if the caller is cancelled, the ticket is
    abandoned and the thread waited out (it stops at its next yield point) before the cancellation goes on, so the
    caller's engine lock and request place are never released while the thread still works."""

    def call() -> T:
        with working_for(ticket):
            return fn()

    fut = asyncio.ensure_future(run_in_threadpool(call))
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        ticket.abandon()
        await asyncio.wait({fut})
        if not fut.cancelled():
            fut.exception()  # retrieved (usually `Abandoned`), so asyncio does not report it
        raise


async def _watch_disconnect(request: Request, job: SynthJob | SentenceJobs) -> None:
    while not await request.is_disconnected():
        await asyncio.sleep(0.05)
    job.cancel()


def _unknown_voice(name: str) -> OpenAIError:
    return OpenAIError(404, f"voice '{name}' not found", param="voice", code="voice_not_found")


@router.post("/audio/speech")
async def speech(request: Request, body: SpeechRequest):
    slots = request.app.state.slots
    tts = slots.tts
    if tts is None:
        raise _disabled("TTS")
    fmt = body.response_format
    if fmt in COMPRESSED_FORMATS:
        raise OpenAIError(
            400,
            "Max Speech returns uncompressed audio; request 'pcm' or 'wav'",
            param="response_format",
            code="unsupported_response_format",
        )
    if fmt not in ("pcm", "wav"):
        raise OpenAIError(400, f"unknown response_format '{fmt}'", param="response_format")
    if body.stream_format == "audio" and fmt != "pcm":
        raise OpenAIError(400, "stream_format 'audio' requires response_format 'pcm'", param="stream_format")
    voice = resolve_voice(tts, body.voice)
    headers = {"X-Max-Speech-Engine": speech_engine_id(tts, voice)}
    # The language is an optional hint, so an unknown value is ignored rather than rejected.
    hint = whisper_language(body.language)
    job = SentenceJobs(tts, slots.speech_lock(voice), body.input, voice, speed=body.speed, language=hint)

    if body.stream_format is None:
        # The relay aborts a request on barge-in, so watch for the client leaving and stop synthesizing.
        watcher = asyncio.create_task(_watch_disconnect(request, job))
        try:
            pcm = b"".join([c async for c in job.chunks()])
        except UnknownVoiceError as exc:
            raise _unknown_voice(body.voice) from exc
        finally:
            watcher.cancel()
            job.cancel()
        if fmt == "wav":
            return Response(wav_bytes(pcm, OUTPUT_RATE), media_type="audio/wav", headers=headers)
        return Response(pcm, media_type="audio/pcm", headers=headers)

    # Fetch the first chunk before answering, so a failure that comes first is still a proper HTTP error.
    chunks = job.chunks()
    try:
        first = await anext(chunks, None)
    except BaseException as exc:
        job.cancel()  # no stream will follow: stop the sentence jobs still queued
        if isinstance(exc, UnknownVoiceError):
            raise _unknown_voice(body.voice) from exc
        raise

    async def pieces() -> AsyncIterator[bytes]:
        try:
            if first is not None:
                yield first
            async for piece in chunks:
                yield piece
        finally:
            job.cancel()  # client gone (or done): stop producing

    async def raw() -> AsyncIterator[bytes]:
        try:
            async for piece in pieces():
                yield piece
        except Exception:
            log.warning("speech stream from engine %s ended early", tts.id, exc_info=True)

    async def events() -> AsyncIterator[bytes]:
        try:
            async for piece in pieces():
                yield _sse({"type": "speech.audio.delta", "audio": base64.b64encode(piece).decode()})
            yield _sse({"type": "speech.audio.done"})
        except Exception:
            log.warning("speech stream from engine %s ended early", tts.id, exc_info=True)
            err = OpenAIError(500, "internal server error", type="server_error").body()
            yield _sse({"type": "error", **err})

    if body.stream_format == "audio":
        return StreamingResponse(raw(), media_type="audio/pcm", headers=headers)
    return StreamingResponse(
        events(), media_type="text/event-stream", headers={**headers, "Cache-Control": "no-cache"}
    )


async def _read_upload(file: UploadFile) -> bytes:
    data = bytearray()
    while chunk := await file.read(1024 * 1024):
        data += chunk
        if len(data) > MAX_UPLOAD_BYTES:
            raise OpenAIError(
                413,
                f"file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB",
                param="file",
                code="file_too_large",
            )
    return bytes(data)


@router.post("/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: Annotated[UploadFile, File()],
    model: Annotated[str | None, Form()] = None,  # accepted, not used: the active STT serves every model name
    language: Annotated[str | None, Form()] = None,
    prompt: Annotated[str | None, Form()] = None,
    response_format: Annotated[str, Form()] = "json",
    temperature: Annotated[float | None, Form()] = None,  # accepted for SDK compatibility, ignored
):
    slots = request.app.state.slots
    stt = slots.stt
    if stt is None:
        raise _disabled("STT")
    if response_format not in ("json", "text", "verbose_json"):
        raise OpenAIError(
            400,
            f"response_format '{response_format}' is not supported; use json, text or verbose_json",
            param="response_format",
            code="unsupported_response_format",
        )
    stt_language = None
    if language and language.strip():
        stt_language = whisper_language(language)
        if stt_language is None:
            raise OpenAIError(
                400,
                f"language '{language}' is not supported; use an ISO-639-1 code such as 'en' or 'zh'",
                param="language",
                code="invalid_language",
            )
    # The place this request holds (each holds tens of MB) was taken by TranscriptionSlotMiddleware (api/limits.py)
    # before the upload was read, so a flood is refused instead of spooled.
    return await _transcribe(request, slots, stt, file, stt_language, prompt, response_format)


async def _transcribe(request, slots, stt, file, stt_language, prompt, response_format):
    data = await _read_upload(file)

    def decode():
        try:
            info = sf.info(io.BytesIO(data))
            too_large = OpenAIError(
                400,
                "audio is too large once decoded; send mono or stereo speech",
                param="file",
                code="audio_too_large",
            )
            if info.channels > 2 or info.frames * info.channels > MAX_DURATION_S * 48_000 * 2:
                raise too_large
            if info.duration > MAX_DURATION_S:
                raise OpenAIError(
                    400,
                    f"audio is longer than {MAX_DURATION_S // 60} minutes",
                    param="file",
                    code="audio_too_long",
                )
        except sf.LibsndfileError:
            pass  # decode_audio below reports the unreadable file in its own words
        try:
            samples, rate = decode_audio(data)
        except AudioDecodeError as exc:
            raise OpenAIError(400, str(exc), param="file", code="invalid_audio") from exc
        return resample(samples, rate, INPUT_RATE)

    if slots.decode_gate is None:
        slots.decode_gate = asyncio.Semaphore(MAX_CONCURRENT_DECODES)
    async with slots.decode_gate:
        samples = await run_in_threadpool(decode)
    async with slots.batch_stt_lock():
        if await request.is_disconnected():
            return Response(status_code=499)  # the client left while queued; skip the inference
        async with batch_ticket(request) as ticket:
            try:
                result = await run_for(
                    ticket,
                    lambda: stt.transcribe(samples, INPUT_RATE, language=stt_language, prompt=prompt or None),
                )
            except Abandoned:
                return Response(status_code=499)  # the client left mid-transcription
    if response_format == "text":
        return PlainTextResponse(result.text)
    if response_format == "verbose_json":
        return {
            "task": "transcribe",
            "language": result.language,
            "duration": result.duration_s,
            "text": result.text,
            "segments": [
                {"id": i, "start": start, "end": end, "text": text}
                for i, (start, end, text) in enumerate(result.segments)
            ],
        }
    return {"text": result.text}


def _model_entry(model_id: str) -> dict:
    return {"id": model_id, "object": "model", "owned_by": "max-speech"}


def _model_ids(request: Request) -> list[str]:
    slots = request.app.state.slots
    ids = [e.id for e in (slots.stt, slots.tts) if e is not None]
    return list(dict.fromkeys([*ids, *MODEL_ALIASES]))


@router.get("/models")
async def list_models(request: Request):
    return {"object": "list", "data": [_model_entry(i) for i in _model_ids(request)]}


@router.get("/models/{model_id:path}")
async def get_model(model_id: str, request: Request):
    if model_id not in _model_ids(request):
        raise OpenAIError(
            404, f"the model '{model_id}' does not exist", param="model", code="model_not_found"
        )
    return _model_entry(model_id)


@router.get("/audio/voices")
async def voices(request: Request):
    tts = request.app.state.slots.tts
    if tts is None:
        raise _disabled("TTS")
    return {
        "voices": [
            {"id": v.id, "name": v.name, "languages": list(v.languages), "gender": v.gender}
            for v in tts.voices()
        ]
    }
