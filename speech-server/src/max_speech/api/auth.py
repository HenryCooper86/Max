"""API-key / loopback check as a pure ASGI middleware, so it runs before any request body is parsed."""

from __future__ import annotations

import hmac
import ipaddress
import json
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from max_speech.api.errors import OpenAIError


def _is_loopback(host: str | None) -> bool:
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # dual-stack sockets report 127.0.0.1 as ::ffff:127.0.0.1
    return ip.is_loopback


def check_auth(api_key: str | None, headers: list[tuple[bytes, bytes]], client_host: str | None) -> None:
    if api_key:
        header = dict(headers).get(b"authorization", b"").decode("latin-1")
        scheme, _, token = header.partition(" ")
        supplied = token.strip() if scheme.lower() == "bearer" else ""
        if not hmac.compare_digest(supplied.encode(), api_key.encode()):
            raise OpenAIError(401, "incorrect API key provided", code="invalid_api_key")
        return
    # No key configured: refuse anything that is not local, so binding 0.0.0.0 never exposes an open server.
    if not _is_loopback(client_host):
        raise OpenAIError(
            401,
            "set SPEECH_API_KEY to accept connections from other machines",
            code="api_key_required",
        )


_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def check_origin(headers: list[tuple[bytes, bytes]], allowed: tuple[str, ...]) -> None:
    """Refuse a WebSocket opened by a web page from another site (a browser always sends `Origin`).

    No `Origin` (a native client) passes; so do localhost origins on any port and anything listed in `allowed`.
    """
    raw = dict(headers).get(b"origin")
    if raw is None:
        return
    origin = raw.decode("latin-1").strip().rstrip("/").lower()
    if origin in allowed:
        return
    try:
        parts = urlsplit(origin)
        if parts.scheme in ("http", "https") and parts.hostname in _LOCAL_HOSTS:
            return
    except ValueError:
        pass
    raise OpenAIError(
        403,
        "this origin may not use the session; add it to SPEECH_ALLOWED_ORIGINS",
        code="origin_not_allowed",
    )


class AuthMiddleware:
    def __init__(
        self, app: ASGIApp, api_key: str | None = None, allowed_origins: tuple[str, ...] = ()
    ) -> None:
        self.app = app
        self.api_key = api_key
        self.allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/v1/"):
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        try:
            check_auth(self.api_key, scope["headers"], client[0] if client else None)
            if scope["type"] == "websocket":
                check_origin(scope["headers"], self.allowed_origins)
        except OpenAIError as err:
            if scope["type"] == "websocket":
                # Closing before accept makes the server answer the upgrade with HTTP 403.
                await send({"type": "websocket.close", "code": 1008, "reason": err.message})
                return
            body = json.dumps(err.body()).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": err.status,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
