"""Reject oversized request bodies before they are read whole.

Uploads (a transcription file, a voice reference clip) get the audio cap plus multipart overhead; the lexicon gets
`MAX_LEXICON_BYTES`, the largest body its own limits allow; every other body is JSON and gets `MAX_JSON_BYTES`, so a
design request or a PATCH cannot make the server buffer megabytes that validation would reject anyway."""

from __future__ import annotations

import asyncio
import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from max_speech.api import openai_routes
from max_speech.api.errors import OpenAIError
from max_speech.voices import lexicon

_OVERHEAD = 1024 * 1024  # multipart boundaries and the other form fields
MAX_JSON_BYTES = 256 * 1024
# The largest valid lexicon: every key and value at its length limit, every character written the longest way JSON
# allows (outside the BMP with ensure_ascii, a surrogate pair "\ud840\udc00" is 12 bytes for one character), plus
# room per entry for quotes, colon, comma and pretty-printing, plus the envelope. 1,172,096 bytes; a full lexicon of
# BMP CJK is about 282 KB as UTF-8 and 560 KB escaped, both over MAX_JSON_BYTES.
_JSON_BYTES_PER_CHAR = 12
_JSON_BYTES_PER_ENTRY = 32
MAX_LEXICON_BYTES = (
    lexicon.MAX_ENTRIES
    * ((lexicon.MAX_KEY_CHARS + lexicon.MAX_VALUE_CHARS) * _JSON_BYTES_PER_CHAR + _JSON_BYTES_PER_ENTRY)
    + 4096
)
_JSON_CAPS = {("PUT", "/v1/lexicon"): MAX_LEXICON_BYTES}
_UPLOADS = frozenset({("POST", "/v1/audio/transcriptions"), ("POST", "/v1/voices")})
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


class UploadLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        if (scope["method"], scope["path"]) in _UPLOADS:
            cap = openai_routes.MAX_UPLOAD_BYTES + _OVERHEAD
            err = OpenAIError(413, "file is too large", param="file", code="file_too_large")
        else:
            cap = _JSON_CAPS.get((scope["method"], scope["path"]), MAX_JSON_BYTES)
            err = OpenAIError(
                413,
                f"request body is larger than {cap // 1024} KB",
                code="request_too_large",
            )
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > cap:
            await self._reject(send, err)
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
            await self._reject(send, err)

    async def _reject(self, send: Send, err: OpenAIError) -> None:
        await _send_error(send, err)


async def _send_error(send: Send, err: OpenAIError) -> None:
    body = json.dumps(err.body()).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    headers += [(k.lower().encode(), v.encode()) for k, v in (err.headers or {}).items()]
    await send({"type": "http.response.start", "status": err.status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


_TRANSCRIPTIONS = ("POST", "/v1/audio/transcriptions")


class TranscriptionSlotMiddleware:
    """At most `slots.max_transcriptions` transcription requests in flight; the rest get 429 before their body is read.

    It has to be middleware: the route's File()/Form() parameters make FastAPI read and spool the whole multipart body
    (up to 26 MB) before the handler runs. The place is taken here, before anything is received, and given back when
    the request ends however it ends: a response, an error, a client that disconnects mid-upload, or cancellation."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or (scope["method"], scope["path"]) != _TRANSCRIPTIONS:
            await self.app(scope, receive, send)
            return
        slots = scope["app"].state.slots
        if slots.transcriptions >= slots.max_transcriptions:
            await _send_error(
                send,
                OpenAIError(
                    429,
                    "too many transcriptions in progress; retry shortly",
                    type="rate_limit_error",
                    code="too_many_requests",
                    headers={"Retry-After": str(openai_routes.RETRY_AFTER_S)},
                ),
            )
            return
        slots.transcriptions += 1
        try:
            limit = scope["app"].state.settings.upload_timeout_s
            if limit:
                await self._with_deadline(scope, receive, send, limit)
            else:
                await self.app(scope, receive, send)
        finally:
            slots.transcriptions -= 1

    async def _with_deadline(self, scope: Scope, receive: Receive, send: Send, limit: float) -> None:
        """Run the request, but answer 408 if its body has not fully arrived `limit` seconds after the start."""
        deadline = asyncio.get_running_loop().time() + limit
        body_done = timed_out = False

        async def timed_receive() -> Message:
            nonlocal body_done, timed_out
            if timed_out:
                return {"type": "http.disconnect"}
            if body_done:
                return await receive()
            remaining = deadline - asyncio.get_running_loop().time()
            try:
                message = await asyncio.wait_for(receive(), max(remaining, 0))
            except TimeoutError:
                timed_out = True  # the route sees a disconnect and stops; the client gets the 408 below
                return {"type": "http.disconnect"}
            if message["type"] != "http.request" or not message.get("more_body", False):
                body_done = True
            return message

        async def guarded_send(message: Message) -> None:
            if not timed_out:
                await send(message)

        try:
            await self.app(scope, timed_receive, guarded_send)
        except Exception:
            if not timed_out:
                raise
        if timed_out:
            await _send_error(
                send,
                OpenAIError(
                    408, f"the upload did not arrive within {limit:g} s", param="file", code="upload_timeout"
                ),
            )
