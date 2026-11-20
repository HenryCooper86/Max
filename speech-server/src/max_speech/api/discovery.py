from __future__ import annotations

from fastapi import APIRouter, Request

from max_speech import __version__
from max_speech.licenses import companions, load_registry

router = APIRouter()


def _engine_info(engine) -> dict | None:
    return None if engine is None else {"id": engine.id, "model": engine.model_id}


def _attributions(engines) -> list[dict]:
    registry = load_registry()
    out = []
    for engine in engines:
        if engine is None:
            continue
        # An engine may load more than one model (Kokoro adds its Chinese model).
        seen = {a["model"] for a in out}
        for model_id in (engine.model_id, *getattr(engine, "extra_model_ids", ())):
            entry = registry.get(model_id)
            if entry is None:  # fakes (fake-*) and anything unregistered have nothing to credit
                continue
            # Companion models (a codec the engine needs) are credited with it.
            for e in (entry, *companions(entry, registry)):
                if e.id not in seen:
                    seen.add(e.id)
                    out.append({"model": e.id, "weights_license": e.weights_license, "text": e.attribution})
    return out


@router.get("/.well-known/max-speech")
async def discovery(request: Request):
    slots = request.app.state.slots
    # Task D adds these fields to EngineSlots; until then they read as not loaded.
    vad, turn, stt_stream = (getattr(slots, name, None) for name in ("vad", "turn", "stt_stream"))
    live = (vad, turn, stt_stream, slots.tts)
    cloning = slots.cloning
    design = slots.design if cloning is not None else None  # a designed voice is spoken by cloning
    return {
        "protocol": "max-speech.v1",
        "version": __version__,
        "profile": request.app.state.profile,
        "ready": slots.ready,
        "engines": {"stt": _engine_info(slots.stt), "tts": _engine_info(slots.tts)},
        "features": {
            "openai_compatible": True,
            "streaming_tts": True,
            "session_ws": all(e is not None for e in live),
            "cloning": cloning is not None,
            "voice_design": design is not None,
        },
        "attributions": _attributions([slots.stt, slots.tts, cloning, design, vad, turn, stt_stream]),
    }
