from __future__ import annotations

import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from max_speech import __version__
from max_speech.api import discovery, openai_routes, session_ws, voice_routes
from max_speech.api.auth import AuthMiddleware
from max_speech.api.errors import install_error_handlers
from max_speech.api.limits import TranscriptionSlotMiddleware, UploadLimitMiddleware
from max_speech.api.slots import EngineSlots
from max_speech.engines.base import (
    CloningTtsEngine,
    DesignEngine,
    StreamingSttEngine,
    SttEngine,
    TtsEngine,
    TurnDetector,
    VadEngine,
)
from max_speech.engines.router import VoiceRouter
from max_speech.settings import Settings
from max_speech.voices.lexicon import Lexicon
from max_speech.voices.store import VoiceStore

__all__ = ["EngineSlots", "create_app"]


def create_app(
    settings: Settings,
    *,
    stt: SttEngine | None,
    tts: TtsEngine | None,
    profile: str,
    ready: threading.Event | None = None,
    vad: VadEngine | None = None,
    turn: TurnDetector | None = None,
    stt_stream: StreamingSttEngine | None = None,
    second_pass: bool = False,
    cloning: CloningTtsEngine | None = None,
    design: DesignEngine | None = None,
    voice_store: VoiceStore | None = None,
    lexicon: Lexicon | None = None,
) -> FastAPI:
    """Engines may also be filled in later through `app.state.slots`, then `slots.mark_ready()`."""
    # The interactive docs and schema are off: this is a local service and nothing consumes them.
    app = FastAPI(title="Max Speech", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    event = ready if ready is not None else threading.Event()
    if ready is None:
        event.set()
    app.state.settings = settings
    app.state.profile = profile
    if isinstance(tts, VoiceRouter):
        router, voice_store, lexicon, cloning = tts, tts.store, tts.lexicon, tts.cloning
    else:
        voice_store = voice_store or VoiceStore(
            settings.data_dir / "voices", audit_log=settings.data_dir / "voice-audit.log"
        )
        lexicon = lexicon or Lexicon(settings.data_dir / "lexicon.json")
        router = None if tts is None else VoiceRouter(tts, cloning, voice_store, lexicon)
    app.state.slots = EngineSlots(
        stt=stt,
        tts=router,
        cloning=cloning,
        design=design,
        voices=voice_store,
        lexicon=lexicon,
        vad=vad,
        turn=turn,
        stt_stream=stt_stream,
        second_pass=second_pass,
        ready_event=event,
        max_transcriptions=settings.max_transcriptions,
    )
    install_error_handlers(app)
    app.add_middleware(TranscriptionSlotMiddleware)  # inside the auth check, before any body is read
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(
        AuthMiddleware,
        api_key=settings.api_key,
        allowed_origins=settings.allowed_origins,
        bind_host=settings.host,
    )  # added last = outermost: runs first

    @app.get("/healthz")
    async def healthz():
        # 503 only once the load has failed for good, so a healthcheck's start period can cover a slow first
        # download; the error is in the body while it is retrying too.
        slots = app.state.slots
        error = slots.load_error or slots.retry_error
        body = {"ok": slots.load_error is None, "ready": slots.ready, **({"error": error} if error else {})}
        return JSONResponse(body, status_code=503 if slots.load_error else 200)

    app.include_router(discovery.router)
    app.include_router(openai_routes.router)
    app.include_router(voice_routes.router)
    app.include_router(session_ws.router)
    return app
