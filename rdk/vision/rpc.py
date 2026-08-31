"""Newline-delimited JSON control protocol for the Max vision sidecar.

Requests carry an ``id`` and receive exactly one response with the same ``id``.
The sidecar may also push unsolicited messages carrying ``event`` — that channel
is how a future BPU ADAS loop reports hazards without changing this boundary.

Preview frames never travel here; they are served as MJPEG over local HTTP.
"""

from __future__ import annotations

import json
from typing import Callable

Handler = Callable[[dict], dict]


def decode_lines(buffer: str) -> tuple[list[dict], str]:
    """Split a byte-stream fragment into whole messages plus the remainder.

    A malformed line is skipped rather than raised: one bad frame must not take
    the control socket down.
    """
    parts = buffer.split("\n")
    rest = parts.pop()
    messages: list[dict] = []
    for part in parts:
        line = part.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return messages, rest


def encode_response(
    request_id: str,
    status: str,
    reason: str | None = None,
    detail: str | None = None,
) -> str:
    payload: dict = {"id": request_id, "status": status}
    if reason:
        payload["reason"] = reason
    if detail:
        payload["detail"] = detail
    return json.dumps(payload, ensure_ascii=False) + "\n"


def encode_event(name: str, **fields) -> str:
    return json.dumps({"event": name, **fields}, ensure_ascii=False) + "\n"


def dispatch(message: dict, handlers: dict[str, Handler]) -> str:
    """Run one request and return the line to write back.

    Returns an empty string for a message with no ``id`` — the agent correlates
    on it, so a response without one could never be matched.
    """
    request_id = message.get("id")
    if not isinstance(request_id, str):
        return ""

    handler = handlers.get(message.get("op", ""))
    if handler is None:
        return encode_response(request_id, "unsupported", reason="device.notYet")

    try:
        result = handler(message.get("args") or {})
    except Exception:  # noqa: BLE001 - any handler fault must still answer
        return encode_response(request_id, "failed", reason="capture.failed")

    return encode_response(
        request_id,
        result.get("status", "ok"),
        reason=result.get("reason"),
        detail=result.get("detail"),
    )
