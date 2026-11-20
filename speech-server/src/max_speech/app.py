from __future__ import annotations

import threading

from fastapi import FastAPI

from max_speech import __version__
from max_speech.api import discovery, openai_routes
from max_speech.api.auth import AuthMiddleware
from max_speech.api.errors import install_error_handlers
from max_speech.api.limits import UploadLimitMiddleware
from max_speech.api.slots import EngineSlots
from max_speech.engines.base import SttEngine, TtsEngine
from max_speech.settings import Settings

__all__ = ["EngineSlots", "create_app"]


def create_app(
    settings: Settings,
    *,
    stt: SttEngine | None,
    tts: TtsEngine | None,
    profile: str,
    ready: threading.Event | None = None,
) -> FastAPI:
    """Engines may also be filled in later through `app.state.slots`, then `slots.mark_ready()`."""
    # The interactive docs and schema are off: this is a local service and nothing consumes them.
    app = FastAPI(title="Max Speech", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    event = ready if ready is not None else threading.Event()
    if ready is None:
        event.set()
    app.state.settings = settings
    app.state.profile = profile
    app.state.slots = EngineSlots(stt=stt, tts=tts, ready_event=event)
    install_error_handlers(app)
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(AuthMiddleware, api_key=settings.api_key)  # added last = outermost: runs first

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "ready": app.state.slots.ready}

    app.include_router(discovery.router)
    app.include_router(openai_routes.router)
    return app
