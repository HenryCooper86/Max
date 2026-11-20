"""Custom voices (admin): create from a recording plus consent, list, edit, delete, preview; and the lexicon."""

from __future__ import annotations

import logging
import re
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, StrictInt, StrictStr
from starlette.concurrency import run_in_threadpool

from max_speech.api.errors import OpenAIError
from max_speech.api.openai_routes import _pcm_chunks, _read_upload, require_ready
from max_speech.audio import INPUT_RATE, OUTPUT_RATE, float_to_pcm16, resample, wav_bytes
from max_speech.engines.base import UnknownVoiceError
from max_speech.voices.candidates import expires_iso
from max_speech.voices.lexicon import LexiconError
from max_speech.voices.store import (
    MAX_DESCRIPTION,
    CustomVoice,
    VoiceError,
    VoiceStore,
    check_consent,
    process_reference,
    reference_from_samples,
)

log = logging.getLogger(__name__)

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
    return {
        "voices": voices,
        "cloning": slots.cloning is not None,
        "design": slots.design is not None and slots.cloning is not None,
    }


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


# ---- voice design --------------------------------------------------------------------------------------------------

MAX_DESIGN_TEXT = 300
# Sample sentences measured on the real model (6 voices each, trimmed): English 4.9 to 6.1 s, Chinese 4.3 to 7.3 s.
# A reference under MIN_DESIGN_SECONDS (3 s) is refused at save time, so these stay well above it.
DESIGN_TEXT = {
    "en": "Hello! This is how I sound when I read a few sentences aloud, so you can hear my voice.",
    "zh": "你好！这是我朗读一小段话时的声音，你可以听听看。",
}
# A user's own sample must be long enough to give a 3 s reference (roughly 15 Latin chars or 6 Han chars a
# second of speech at the model's pace, with margin).
MIN_SAMPLE_LATIN = 25
MIN_SAMPLE_HAN = 12
_HAN_CHAR = "㐀-䶿一-鿿"
_HAN = re.compile(f"[{_HAN_CHAR}]")

# ---- imitation guard ----
# Best effort, not a safeguard. It refuses descriptions that ask for a particular person's voice and lets generic
# descriptors through ("a young woman's voice", "the voice of a cheerful young girl", "a deep voice from the
# south"). Names are recognised by capitalisation (English) or by being 2 to 4 Han characters that are not a
# common descriptive word (Chinese), so it misses lower-case or unusual names, and it can wrongly refuse a
# capitalised word it does not know is not a name. A determined user can phrase around it.
_CAP = r"[A-Z][a-z]{1,}"
_NAME = rf"{_CAP}(?:\s+{_CAP})*"
_EN_NAMED = re.compile(
    rf"(?:\b(?:[Ll]ike|[Aa]s)\s+(?P<a>{_NAME}))"  # "like Morgan Freeman", "Speak as Taylor Swift"
    rf"|(?:\bvoice\s+of\s+(?P<b>{_NAME}))"  # "the voice of Barack Obama"
    rf"|(?:(?P<c>{_NAME})'s\s+voice)"  # "Taylor Swift's voice"
    rf"|(?:(?P<d>{_CAP}\s+{_CAP}(?:\s+{_CAP})*)\s+(?:voice|accent|speech))"  # "Morgan Freeman voice"
)
_EN_VERBS = re.compile(
    r"(?i:\bimitat\w*|\bimpersonat\w*|\bmimic\w*|\bclon(?:e|es|ed|ing)\b|\bin\s+the\s+style\s+of\b"
    r"|\bsound(?:s|ing)?\s+like\s+(?!(?:a|an|the|he|she|they|it|you|i|someone\s+who|something)\b))"
)
# Capitalised words that are not people: sentence starts, places, nationalities, family words, descriptors.
_EN_NOT_NAMES = frozenset(
    """a an the i my your his her our their it its this that these those one some any very slightly
    american british english chinese southern northern eastern western australian irish scottish welsh indian
    french german spanish italian russian japanese korean canadian texan cockney mandarin cantonese african
    european asian latin midwestern new england london
    mom dad mum mother father grandma grandpa grandmother grandfather uncle aunt sister brother
    woman man girl boy child kid lady gentleman old young middle aged elderly teen teenage adult
    narrator teacher host announcer robot voice female male warm calm deep bright soft gentle""".split()  # noqa: SIM905
)
_ZH_VERBS = re.compile(r"模仿|冒充|仿照|克隆")
# Name candidates: 2 to 4 Han characters after these frames, or before 的声音.
_ZH_NAMED = re.compile(
    rf"听起来像(?P<a>[{_HAN_CHAR}]{{2,4}})"
    rf"|听上去像(?P<b>[{_HAN_CHAR}]{{2,4}})"
    rf"|像(?P<c>[{_HAN_CHAR}]{{2,4}})一样说话"
    rf"|像(?P<d>[{_HAN_CHAR}]{{2,4}})那样说话"
    rf"|学(?P<e>[{_HAN_CHAR}]{{2,4}})说话"
    rf"|像(?P<f>[{_HAN_CHAR}]{{2,4}})的(?:声音|嗓音|口吻|语气)"
    rf"|(?P<g>[{_HAN_CHAR}]{{2,4}})的(?:声音|嗓音|口吻|语气)"
)
# A candidate containing one of these is a description, not a name.
_ZH_DESCRIPTIVE = [
    "女人",
    "男人",
    "孩子",
    "老人",
    "年轻人",
    "女孩",
    "男孩",
    "播音员",
    "主持人",
    "老师",
    "女声",
    "男声",
    "童声",
    "老年",
    "中年",
    "青年",
    "少年",
    "少女",
    "小孩",
    "儿童",
    "女性",
    "男性",
    "女士",
    "先生",
    "妈妈",
    "爸爸",
    "奶奶",
    "爷爷",
    "姐姐",
    "哥哥",
    "学生",
    "医生",
    "机器人",
    "动画",
    "角色",
    "主播",
    "解说",
    "旁白",
    "温柔",
    "温和",
    "柔和",
    "清脆",
    "低沉",
    "沙哑",
    "甜美",
    "磁性",
    "清澈",
    "清爽",
    "轻柔",
    "圆润",
    "爽朗",
    "细腻",
    "浑厚",
    "洪亮",
    "稳重",
    "成熟",
    "年轻",
    "苍老",
    "活泼",
    "可爱",
    "开朗",
    "平静",
    "自然",
    "亲切",
    "沉稳",
    "明亮",
    "悦耳",
    "动听",
    "好听",
    "干净",
    "标准",
    "普通",
    "清晰",
    "缓慢",
    "轻快",
    "低音",
    "高音",
    "嘶哑",
    "稚嫩",
    "慈祥",
    "威严",
    "严肃",
    "热情",
    "冷静",
    "友好",
    "某位",
    "某个",
    "一个",
    "一位",
    "别人",
    "别的",
    "其他",
    "另一",
    "自己",
    "我的",
    "你的",
    "他的",
    "她的",
    "这个",
    "那个",
    "这种",
    "那种",
    "这样",
    "那样",
    "什么",
]


def _imitates(description: str) -> bool:
    """True when the description appears to ask for a specific real person's voice; see the notes above."""
    if _EN_VERBS.search(description) or _ZH_VERBS.search(description):
        return True
    for m in _EN_NAMED.finditer(description):
        name = next(v for v in m.groupdict().values() if v)
        if any(w.lower() not in _EN_NOT_NAMES for w in name.split()):
            return True
    for m in _ZH_NAMED.finditer(description):
        name = next(v for v in m.groupdict().values() if v)
        if name[0] not in "个位一某这那" and not any(word in name for word in _ZH_DESCRIPTIVE):
            return True
    return False


def _unavailable_design() -> OpenAIError:
    return OpenAIError(409, "voice design is not available on this server", code="design_unavailable")


def _no_candidate(cid: str) -> OpenAIError:
    return OpenAIError(
        404, f"candidate '{cid[:40]}' not found or expired", param="candidate", code="candidate_not_found"
    )


def _design_text(value: str | None, field_name: str, max_len: int, *, required: bool = False) -> str:
    text = " ".join((value or "").split())
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise OpenAIError(
            400, f"{field_name} must not contain control characters", param=field_name, code="invalid_field"
        )
    if required and not text:
        raise OpenAIError(400, f"{field_name} is required", param=field_name, code="invalid_field")
    if len(text) > max_len:
        raise OpenAIError(
            400, f"{field_name} must be at most {max_len} characters", param=field_name, code="invalid_field"
        )
    return text


class DesignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: StrictStr
    text: StrictStr | None = None
    language: StrictStr | None = None
    count: StrictInt = 3
    created_by: StrictStr | None = None


@router.post("/voices/design")
async def design_voice(body: DesignRequest, request: Request):
    slots = request.app.state.slots
    engine = slots.design
    if engine is None or slots.cloning is None:
        raise _unavailable_design()
    description = _design_text(body.description, "description", MAX_DESCRIPTION, required=True)
    if _imitates(description):
        raise OpenAIError(
            400,
            "describe a voice by its qualities (age, pitch, tone, pace), not as someone's voice: "
            "imitating a real person is not allowed",
            param="description",
            code="design_refused",
        )
    text = _design_text(body.text, "text", MAX_DESIGN_TEXT)
    if not 1 <= body.count <= 3:
        raise OpenAIError(400, "count must be 1 to 3", param="count", code="invalid_field")
    if body.language:
        language = body.language.strip().lower().replace("_", "-").split("-", 1)[0]
    else:
        language = "zh" if _HAN.search(text or description) else "en"
    if language not in engine.languages:
        raise OpenAIError(
            400,
            f"voice design supports {', '.join(engine.languages)}; got '{language[:12]}'",
            param="language",
            code="invalid_language",
        )
    if text:
        short = len(_HAN.findall(text)) < MIN_SAMPLE_HAN if language == "zh" else len(text) < MIN_SAMPLE_LATIN
        if short:
            need = (
                f"{MIN_SAMPLE_HAN} Chinese characters"
                if language == "zh"
                else f"{MIN_SAMPLE_LATIN} characters"
            )
            raise OpenAIError(
                400,
                f"text is too short to make a usable sample: use at least {need}",
                param="text",
                code="sample_text_too_short",
            )
    text = text or DESIGN_TEXT.get(language, DESIGN_TEXT["en"])
    # Load the weights (several seconds the first time) before taking the speech lock, so live speech never waits
    # for the load, only for one generated sentence at a time.
    try:
        await run_in_threadpool(engine.ensure_loaded)
    except Exception as exc:  # a failed load (missing weights, out of memory) is a 503, not a crash
        log.exception("voice design model failed to load")
        raise OpenAIError(
            503, "the voice design model could not be loaded", type="server_error", code="design_unavailable"
        ) from exc
    base_seed = secrets.randbelow(2**31 - 4)
    made = []
    for i in range(body.count):
        seed = base_seed + i  # distinct, so the candidates differ
        # One candidate per lock hold: live speech waits for at most one sentence, not the whole batch.
        async with slots.tts_lock:
            try:
                audio = await run_in_threadpool(lambda s=seed: engine.design(description, text, language, s))
            except ValueError as exc:
                raise OpenAIError(400, str(exc), param="description", code="invalid_field") from exc
        made.append(
            slots.candidates.add(
                audio=audio,
                rate=engine.sample_rate,
                text=text,
                description=description,
                language=language,
                seed=seed,
                model=engine.model_id,
            )
        )
    expires = expires_iso(slots.candidates.ttl)
    return {
        "candidates": [
            {
                "id": c.id,
                "text": c.text,
                "description": c.description,
                "language": c.language,
                "expires_at": expires,
            }
            for c in made
        ]
    }


@router.get("/voices/design/{cid}/audio")
async def design_audio(cid: str, request: Request):
    item = request.app.state.slots.candidates.get(cid)
    if item is None:
        raise _no_candidate(cid)
    wav = await run_in_threadpool(lambda: wav_bytes(float_to_pcm16(item.audio), item.rate))
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})


class DesignSave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StrictStr
    gender: StrictStr | None = None
    languages: list[StrictStr] | StrictStr | None = None
    created_by: StrictStr | None = None


@router.post("/voices/design/{cid}/save", status_code=201)
async def save_designed_voice(cid: str, body: DesignSave, request: Request):
    slots = request.app.state.slots
    store = _store(request)
    # Saving consumes the candidate: a second save (or a double click) is a 404, not a duplicate voice. It is put
    # back if this save fails, so the admin can retry.
    item = slots.candidates.take(cid)
    if item is None:
        raise _no_candidate(cid)
    try:
        voice = await _save_candidate(store, item, body)
    except BaseException:
        slots.candidates.restore(item)
        raise
    return JSONResponse(_custom_json(voice), status_code=201, headers={"Location": f"/v1/voices/{voice.id}"})


async def _save_candidate(store: VoiceStore, item, body: DesignSave) -> CustomVoice:
    # The sample becomes the voice's reference and its text the transcript; the cloning engine then speaks it.
    reference = await _blocking(reference_from_samples, item.audio, item.rate)
    return await _blocking(
        store.create_designed,
        audio=reference,
        name=body.name,
        transcript=item.text,
        description=item.description,
        seed=item.seed,
        model=item.model,
        languages=body.languages if body.languages not in (None, "", []) else item.language,
        gender=body.gender,
        created_by=body.created_by,
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
