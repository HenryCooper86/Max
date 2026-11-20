"""Run a blocking engine call in the threadpool, serialized by the engine's asyncio lock."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from starlette.concurrency import run_in_threadpool


async def run_serialized[T](lock: asyncio.Lock, fn: Callable[..., T], *args) -> T:
    """`await run_in_threadpool(fn, *args)` while holding `lock`.

    If the caller is cancelled mid-call, the lock is held until the worker thread has really finished, so the
    next user of a non-re-entrant engine never overlaps with a thread still running inside it.
    """
    async with lock:
        fut = asyncio.ensure_future(run_in_threadpool(fn, *args))
        try:
            return await asyncio.shield(fut)
        except asyncio.CancelledError:
            await asyncio.wait({fut})  # the thread cannot be interrupted; wait it out, then propagate
            raise
