"""Reject oversized uploads before Starlette spools the whole multipart body to disk."""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from max_speech.api import openai_routes
from max_speech.api.errors import OpenAIError

_OVERHEAD = 1024 * 1024  # multipart boundaries and the other form fields
_PATH = "/v1/audio/transcriptions"


class UploadLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != _PATH:
            await self.app(scope, receive, send)
            return
        cap = openai_routes.MAX_UPLOAD_BYTES + _OVERHEAD
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > cap:
            await self._reject(send)
            return

        received = 0
        exceeded = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > cap:  # chunked bodies have no Content-Length to check
                    exceeded = True
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            if not exceeded:
                await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not exceeded:
                raise
        if exceeded:
            await self._reject(send)

    async def _reject(self, send: Send) -> None:
        err = OpenAIError(413, "file is too large", param="file", code="file_too_large")
        body = json.dumps(err.body()).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
