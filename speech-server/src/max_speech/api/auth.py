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


def _origin_allowed(headers: list[tuple[bytes, bytes]], allowed: tuple[str, ...]) -> bool:
    try:
        check_origin(headers, allowed)
    except OpenAIError:
        return False
    return True


def _host_name(raw: str) -> str:
    """Hostname of a Host header value: port stripped, brackets removed, lowercased."""
    try:
        return (urlsplit("//" + raw.strip()).hostname or "").lower()
    except ValueError:
        return ""


def check_host(headers: list[tuple[bytes, bytes]], bind_host: str | None) -> None:
    """Refuse a request whose Host is not this machine (DNS rebinding: an attacker name resolving to 127.0.0.1)."""
    raw = dict(headers).get(b"host", b"").decode("latin-1")
    name = _host_name(raw)
    if name in _LOCAL_HOSTS:
        return
    if bind_host and bind_host not in ("0.0.0.0", "::") and name == bind_host.strip("[]").lower():
        return
    raise OpenAIError(
        403,
        "this Host is not allowed without SPEECH_API_KEY; use localhost or 127.0.0.1",
        code="forbidden_host",
    )


class AuthMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        api_key: str | None = None,
        allowed_origins: tuple[str, ...] = (),
        bind_host: str | None = None,
    ) -> None:
        self.app = app
        self.api_key = api_key
        self.allowed_origins = allowed_origins
        self.bind_host = bind_host

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        is_ws = scope["type"] == "websocket"
        guarded = scope["path"].startswith("/v1/")
        client = scope.get("client")
        headers = scope["headers"]
        try:
            if not is_ws:
                # Browser-driven requests (CORS "simple" writes need no preflight) and rebinding, before any body is read.
                if b"origin" in dict(headers) and not _origin_allowed(headers, self.allowed_origins):
                    raise OpenAIError(
                        403,
                        "this origin may not use the server; add it to SPEECH_ALLOWED_ORIGINS",
                        code="forbidden_origin",
                    )
                if not self.api_key:
                    check_host(headers, self.bind_host)
            if guarded:
                check_auth(self.api_key, headers, client[0] if client else None)
                if is_ws:
                    check_origin(headers, self.allowed_origins)
            elif is_ws:
                await self.app(scope, receive, send)
                return
        except OpenAIError as err:
            if is_ws:
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
