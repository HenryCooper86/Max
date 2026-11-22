"""OpenAI-shaped errors, so the official SDKs raise their usual exception types."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)


class OpenAIError(Exception):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        type: str = "invalid_request_error",
        param: str | None = None,
        code: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.type = type
        self.param = param
        self.code = code
        self.headers = headers

    def body(self) -> dict:
        return {"error": {"message": self.message, "type": self.type, "param": self.param, "code": self.code}}


def _response(err: OpenAIError) -> JSONResponse:
    return JSONResponse(err.body(), status_code=err.status, headers=err.headers)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(OpenAIError)
    async def _openai(_: Request, exc: OpenAIError):
        return _response(exc)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        # loc is ("body", "input") or ("body",): the field name is the last string element.
        names = [p for p in first.get("loc", ()) if isinstance(p, str) and p not in ("body", "query")]
        message = first.get("msg", "invalid request")
        return _response(OpenAIError(400, message, param=names[-1] if names else None))

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        if request.url.path.startswith("/v1/"):
            kind = "invalid_request_error" if exc.status_code < 500 else "server_error"
            return _response(OpenAIError(exc.status_code, str(exc.detail), type=kind))
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.error("unhandled error on %s", request.url.path, exc_info=exc)
        return _response(OpenAIError(500, "internal server error", type="server_error"))
