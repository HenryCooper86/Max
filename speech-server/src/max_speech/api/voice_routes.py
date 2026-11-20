"""Custom voices (admin): create from a recording plus consent, list, edit, delete, preview; and the lexicon."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, StrictStr
from starlette.concurrency import run_in_threadpool

from max_speech.api.errors import OpenAIError
from max_speech.api.openai_routes import _pcm_chunks, _read_upload, require_ready
from max_speech.audio import INPUT_RATE, OUTPUT_RATE, resample, wav_bytes
from max_speech.engines.base import UnknownVoiceError
from max_speech.voices.lexicon import LexiconError
from max_speech.voices.store import CustomVoice, VoiceError, VoiceStore, check_consent, process_reference

router = APIRouter(prefix="/v1", dependencies=[Depends(require_ready)])

MAX_PREVIEW_CHARS = 300
PREVIEW_TEXT = {"en": "Hello, this is my voice.", "zh": "你好，这是我的声音。"}


def _store(request: Request) -> VoiceStore:
    store = request.app.state.slots.voices
    if store is None:  # create_app always sets it; guards a hand-built EngineSlots
        raise OpenAIError(503, "custom voices are not available", type="server_error", code="engine_disabled")
    return store


def _voice_error(exc: VoiceError) -> OpenAIError:
    return OpenAIError(400, exc.message, param=exc.param, code=exc.code)


def _not_found(voice_id: str) -> OpenAIError:
    return OpenAIError(404, f"voice '{voice_id[:40]}' not found", param="voice", code="voice_not_found")


def _cloning_unavailable() -> OpenAIError:
    return OpenAIError(409, "voice cloning is not available on this server", code="cloning_unavailable")


def _custom_json(v: CustomVoice) -> dict:
    return {**v.to_dict(), "kind": "custom"}


async def _blocking(fn, *args, **kwargs):
    """Run store work off the event loop, turning its errors into API errors."""
    try:
        return await run_in_threadpool(lambda: fn(*args, **kwargs))
    except VoiceError as exc:
        raise _voice_error(exc) from exc
    except UnknownVoiceError as exc:
        raise _not_found(kwargs.get("voice_id") or (args[0] if args else "")) from exc


@router.get("/voices")
async def list_voices(request: Request):
    slots = request.app.state.slots
    store = _store(request)
    preset = slots.tts.preset.voices() if slots.tts is not None else []
    voices = [
        {"id": v.id, "name": v.name, "kind": "preset", "languages": list(v.languages), "gender": v.gender}
        for v in preset
    ]
    voices += [_custom_json(v) for v in store.list()]
    return {"voices": voices, "cloning": slots.cloning is not None}


@router.post("/voices", status_code=201)
async def create_voice(
    request: Request,
    audio: Annotated[UploadFile | None, File()] = None,
    name: Annotated[str | None, Form()] = None,
    transcript: Annotated[str | None, Form()] = None,
    languages: Annotated[str | None, Form()] = None,
    gender: Annotated[str | None, Form()] = None,
    consent: Annotated[str | None, Form()] = None,
    consent_statement: Annotated[str | None, Form()] = None,
    consent_speaker: Annotated[str | None, Form()] = None,
    created_by: Annotated[str | None, Form()] = None,
):
    slots = request.app.state.slots
    store = _store(request)
    if slots.cloning is None:
        raise _cloning_unavailable()
    consented = (consent or "").strip().lower() == "true"
    try:
        check_consent(consented, consent_statement, consent_speaker)  # before any audio is read or decoded
    except VoiceError as exc:
        raise _voice_error(exc) from exc
    if audio is None:
        raise OpenAIError(400, "send the recording in the 'audio' field", param="audio", code="invalid_audio")
    data = await _read_upload(audio)
    reference = await _blocking(process_reference, data)
    text = (transcript or "").strip()
    source = "given"
    if not text:
        stt = slots.stt
        if stt is None:
            raise OpenAIError(
                400,
                "send a transcript of the recording: this server has no speech recognizer to write one",
                param="transcript",
                code="transcript_required",
            )
        hint = (languages or "").split(",")[0].strip().lower().split("-")[0] or None
        samples = resample(reference.audio, reference.rate, INPUT_RATE)
        async with slots.stt_lock:
            result = await run_in_threadpool(lambda: stt.transcribe(samples, INPUT_RATE, language=hint))
        text, source = result.text.strip(), "stt"
        if not text:
            raise OpenAIError(
                400,
                "could not transcribe the recording; send a transcript",
                param="transcript",
                code="transcript_required",
            )
        text = text[:1000]
    voice = await _blocking(
        store.create,
        audio=reference,
        name=name,
        transcript=text,
        languages=languages,
        gender=gender,
        consent=consented,
        consent_statement=consent_statement,
        consent_speaker=consent_speaker,
        created_by=created_by,
        transcript_source=source,
    )
    return JSONResponse(_custom_json(voice), status_code=201, headers={"Location": f"/v1/voices/{voice.id}"})


@router.get("/voices/{voice_id}")
async def get_voice(voice_id: str, request: Request):
    try:
        return _custom_json(_store(request).info(voice_id))
    except UnknownVoiceError as exc:
        raise _not_found(voice_id) from exc


class VoicePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StrictStr | None = None
    languages: list[StrictStr] | StrictStr | None = None
    gender: StrictStr | None = None
    transcript: StrictStr | None = None


@router.patch("/voices/{voice_id}")
async def patch_voice(voice_id: str, body: VoicePatch, request: Request):
    store = _store(request)
    voice = await _blocking(
        store.update,
        voice_id,
        name=body.name,
        languages=body.languages,
        gender=body.gender,
        transcript=body.transcript,
    )
    return _custom_json(voice)


@router.delete("/voices/{voice_id}", status_code=204)
async def delete_voice(voice_id: str, request: Request):
    await _blocking(_store(request).delete, voice_id)
    return Response(status_code=204)


@router.get("/voices/{voice_id}/reference")
async def voice_reference(voice_id: str, request: Request):
    store = _store(request)
    try:
        path = store.reference_path(voice_id)
    except UnknownVoiceError as exc:
        raise _not_found(voice_id) from exc
    try:
        data = await run_in_threadpool(path.read_bytes)
    except OSError as exc:
        raise _not_found(voice_id) from exc
    return Response(data, media_type="audio/wav", headers={"Cache-Control": "no-store"})


class PreviewRequest(BaseModel):
    text: StrictStr | None = None


@router.post("/voices/{voice_id}/preview")
async def preview_voice(voice_id: str, request: Request, body: PreviewRequest | None = None):
    slots = request.app.state.slots
    store = _store(request)
    try:
        voice = store.info(voice_id)
    except UnknownVoiceError as exc:
        raise _not_found(voice_id) from exc
    if slots.cloning is None or slots.tts is None:
        raise _cloning_unavailable()
    language = voice.languages[0] if voice.languages else "en"
    text = ((body.text if body else None) or "").strip() or PREVIEW_TEXT.get(language, PREVIEW_TEXT["en"])
    if len(text) > MAX_PREVIEW_CHARS:
        raise OpenAIError(
            400, f"text must be at most {MAX_PREVIEW_CHARS} characters", param="text", code="text_too_long"
        )
    tts = slots.tts
    async with slots.tts_lock:
        try:
            pcm = await run_in_threadpool(lambda: b"".join(_pcm_chunks(tts, text, voice_id, 1.0, language)))
        except UnknownVoiceError as exc:
            raise _not_found(voice_id) from exc
    return Response(
        wav_bytes(pcm, OUTPUT_RATE), media_type="audio/wav", headers={"X-Max-Speech-Engine": tts.id}
    )


class LexiconBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: dict[StrictStr, StrictStr]


def _lexicon(request: Request):
    lexicon = request.app.state.slots.lexicon
    if lexicon is None:
        raise OpenAIError(503, "the lexicon is not available", type="server_error", code="engine_disabled")
    return lexicon


@router.get("/lexicon")
async def get_lexicon(request: Request):
    return {"entries": _lexicon(request).entries}


@router.put("/lexicon")
async def put_lexicon(body: LexiconBody, request: Request):
    lexicon = _lexicon(request)
    try:
        entries = await run_in_threadpool(lexicon.replace, body.entries)
    except LexiconError as exc:
        raise OpenAIError(400, str(exc), param="entries", code="invalid_lexicon") from exc
    return {"entries": entries}
