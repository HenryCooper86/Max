"""Run a blocking engine call in the threadpool, serialized by the engine's asyncio lock."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from starlette.concurrency import run_in_threadpool

from max_speech.engines.mlx_gate import Ticket, working_for


async def run_serialized[T](lock: asyncio.Lock, fn: Callable[..., T], *args) -> T:
    """`await run_in_threadpool(fn, *args)` while holding `lock`, as live (realtime) work.

    If the caller is cancelled mid-call, the lock is held until the worker thread has really finished, so the
    next user of a non-re-entrant engine never overlaps with a thread still running inside it. The call is
    abandoned at the same time, so a thread still waiting for the MLX gate gives up at once instead of running a
    call nobody wants.
    """
    ticket = Ticket(realtime=True)

    def call() -> T:
        with working_for(ticket):
            return fn(*args)

    async with lock:
        fut = asyncio.ensure_future(run_in_threadpool(call))
        try:
            return await asyncio.shield(fut)
        except asyncio.CancelledError:
            ticket.abandon()
            await asyncio.wait({fut})  # the thread cannot be interrupted; wait it out, then propagate
            if not fut.cancelled():
                fut.exception()  # retrieved (often `Abandoned`), so asyncio does not log it as never retrieved
            raise
