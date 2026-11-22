"""One gate for every MLX evaluation in the process, with live work first.

Why one gate: the server serialises each engine behind its own lock, which keeps a model from running twice. But
mlx-whisper (second pass, transcriptions) and the Qwen3 cloning and design engines are different engines on different
locks, so they could encode Metal work from two threads at once, and not every MLX release survives that (crashes,
corrupted audio). So every MLX evaluation runs with `MLX_GATE` held, and only one thread holds it at a time. Kokoro and
the streaming recognizer are ONNX and never take it, so preset voices and live partials never wait for it.

Why two lanes: a batch call (a 15-minute upload, a voice design) must not keep live speech off the GPU for its whole
length. Work is done on behalf of a `Ticket`: a realtime ticket (a session's sentence or second pass, a live
`/v1/audio/speech`, a voice preview: anything that holds a speech lock, since work queued behind that lock cannot wait
at the gate itself) or a batch one (each batch request has its own, so it can be abandoned alone). While a realtime
thread is waiting, batch threads do not take the gate, and a batch call that holds it gives it up at its next `yield_point()` (mlx-whisper: before each 30 s window; voice
design: between streamed chunks, through `stepwise`). So a live waiter waits for at most one unit of batch work, never
for the whole call. Realtime holders do not yield to each other: their units are a sentence's chunk or a short turn.
A live sentence lets go of the gate between its chunks (a hop back to the event loop, a few ms), so batch work also
waits `REALTIME_GRACE_S` after a realtime release before it takes the gate: the sentence keeps the GPU from its first
chunk to its last and plays as fast as on an idle server, instead of waiting for a batch unit at every chunk. Batch
work runs in the gaps between live sentences, so it is slower while riders talk; it is never refused. So that back-to-
back live sentences (a long reply, several riders, overlapping live threads) cannot starve it, the oldest batch waiter
becomes due once `BATCH_PATIENCE_S` has passed both since it arrived and since batch work last ran (a batch release or
yield), and never while batch work holds the gate: it then takes the next free moment, ahead of realtime waiters, for
one unit. Being due therefore never passes from one batch caller straight to another, so live work waits for at most
one batch unit, and batch work gets at least one unit every `BATCH_PATIENCE_S`. Batch waiters
are served first come, first served, and a batch call yields to another batch waiter at its yield points too, so one
long or stepwise batch caller cannot starve another.

Abandoning: a ticket whose work is no longer wanted (its session closed, its request was cancelled) is abandoned;
a thread waiting for the gate on its behalf raises `Abandoned` at once (also while waiting for its turn back inside a
yield point), and a batch call raises it at its next yield point, so a closing session never waits for the GPU just
to throw the result away.

Lock order, everywhere: an engine's asyncio lock (taken on the event loop) -> an engine's own threading lock (voice
design's load/generate lock) -> MLX_GATE (taken in a worker thread). A thread holding the gate never waits on anything
else, so no cycle is possible.

Threads: mlx keeps GPU streams (and its random generator) per thread, so a computation that spans several units (a
streamed synthesis, a transcription that yields) must stay on one thread: SynthJob advances its generator on its
lock's own thread, and the other callers run each call on a single thread.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Self

REALTIME_GRACE_S = 0.15  # how long batch work stays off the gate after a realtime unit ends
BATCH_PATIENCE_S = 2.0  # a batch waiter older than this is no longer held off by the grace


class Abandoned(Exception):
    """The work waiting for the gate is no longer wanted."""


class Ticket:
    """Whom a thread works for: realtime or batch, and whether that work was abandoned."""

    __slots__ = ("_abandoned", "realtime")

    def __init__(self, *, realtime: bool = False) -> None:
        self.realtime = realtime
        self._abandoned = False

    @property
    def abandoned(self) -> bool:
        return self._abandoned

    def abandon(self) -> None:
        """Thread-safe and idempotent; wakes a thread waiting for the gate on this ticket's behalf."""
        self._abandoned = True
        MLX_GATE.wake()


_BATCH = Ticket()  # threads that never said whom they work for: HTTP batch routes, warm-up, model loads
_local = threading.local()


def current_ticket() -> Ticket:
    return getattr(_local, "ticket", None) or _BATCH


@contextmanager
def working_for(ticket: Ticket) -> Iterator[None]:
    """Run the body on behalf of `ticket` (in this thread)."""
    previous = getattr(_local, "ticket", None)
    _local.ticket = ticket
    try:
        yield
    finally:
        _local.ticket = previous


class _Waiter:
    __slots__ = ("since", "ticket")

    def __init__(self, ticket: Ticket, since: float) -> None:
        self.ticket, self.since = ticket, since


class MlxGate:
    """A re-entrant lock with a realtime lane. Use as `with MLX_GATE:`.

    Who may take a free gate, in order: a batch waiter that is due (it has waited `BATCH_PATIENCE_S`; one unit, then it
    is not due any more); the oldest realtime waiter; the oldest batch waiter, once no realtime work is waiting and the grace
    after the last realtime unit has run out (or it has waited out its patience)."""

    def __init__(
        self, *, grace_s: float = REALTIME_GRACE_S, patience_s: float = BATCH_PATIENCE_S, clock=time.monotonic
    ) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._owner: int | None = None
        self._owner_realtime = False
        self._depth = 0
        self._realtime: deque[_Waiter] = deque()  # realtime waiters, oldest first
        self._batch: deque[_Waiter] = deque()  # batch waiters, oldest first
        self._due: _Waiter | None = None  # the batch waiter that goes next, ahead of realtime waiters
        self._grace_s = grace_s
        self._patience_s = patience_s
        self._clock = clock
        self._realtime_until = 0.0  # batch work may not take the gate before this (clock time)
        # When batch work last ran (a batch holder released or yielded): a batch waiter's patience counts from here, so
        # being due cannot pass from one batch caller straight to another while live work waits.
        self._batch_ran_at = 0.0

    @property
    def held(self) -> bool:
        return self._owner is not None

    @property
    def realtime_waiting(self) -> int:
        return len(self._realtime)

    @property
    def batch_waiting(self) -> int:
        return len(self._batch)

    def _may_take(self, waiter: _Waiter) -> bool:
        if self._owner is not None:
            return False
        if waiter.ticket.realtime:
            return self._due is None and self._realtime[0] is waiter
        if waiter is self._due:
            return True
        if self._due is not None or not self._batch or self._batch[0] is not waiter or self._realtime:
            return False
        return self._clock() >= self._realtime_until

    def _wait(self, waiter: _Waiter) -> None:
        """Wait for a change, or until the oldest batch waiter's grace or patience runs out (nothing notifies then)."""
        if (
            waiter.ticket.realtime
            or not self._batch
            or self._batch[0] is not waiter
            or self._due is not None
            or (self._owner is not None and not self._owner_realtime)  # batch work is running: never due now
        ):
            self._cond.wait()  # a release or a yield notifies
            return
        now = self._clock()  # read once: the grace and the patience are judged at the same moment
        patience_at = max(waiter.since, self._batch_ran_at) + self._patience_s
        if now >= patience_at:
            self._due = waiter  # it has waited long enough: next free moment is its, ahead of realtime work
            self._cond.notify_all()
            return  # re-check at once: the gate may be free right now
        deadline = patience_at
        if self._owner is None and not self._realtime:  # only the grace keeps it out
            deadline = min(deadline, self._realtime_until)
        if deadline > now:
            self._cond.wait(deadline - now)

    def _enter(self, waiter: _Waiter, *, abandonable: bool) -> None:
        """Called with `_cond` held: wait until `waiter` may take the gate, then take it (depth 1)."""
        realtime = waiter.ticket.realtime
        queue = self._realtime if realtime else self._batch
        queue.append(waiter)
        try:
            while not (abandonable and waiter.ticket.abandoned) and not self._may_take(waiter):
                self._wait(waiter)
            if abandonable and waiter.ticket.abandoned:
                raise Abandoned
        finally:
            queue.remove(waiter)
            if self._due is waiter:
                self._due = None
            self._cond.notify_all()  # the queue changed: whoever is next re-checks
        self._owner, self._owner_realtime, self._depth = threading.get_ident(), realtime, 1

    def acquire(self) -> None:
        with self._cond:
            if self._owner == threading.get_ident():
                self._depth += 1
                return
            self._enter(_Waiter(current_ticket(), self._clock()), abandonable=True)

    def release(self) -> None:
        with self._cond:
            if self._owner != threading.get_ident():
                left = getattr(_local, "left_levels", 0)
                if left:  # this thread already left the gate from inside a yield point (abandoned): unwinding
                    _local.left_levels = left - 1
                    return
                raise RuntimeError("MLX_GATE released by a thread that does not hold it")
            self._depth -= 1
            if self._depth == 0:
                if self._owner_realtime:
                    self._realtime_until = self._clock() + self._grace_s
                else:
                    self._batch_ran_at = self._clock()
                self._owner = None
                self._cond.notify_all()

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()

    def wake(self) -> None:
        with self._cond:
            self._cond.notify_all()

    def yield_point(self) -> None:
        """Between two units of work: if this is batch work and anyone else is waiting, let them go first (live work
        first, other batch work in turn).

        Call only with the gate held and no MLX work half-built that another thread could disturb (between two
        evaluations). Raises `Abandoned` when this thread's ticket was abandoned: with the gate still held if it was
        abandoned before the yield, or at once, without the gate, if it was abandoned while waiting for its turn back (the
        caller's `with` blocks then unwind without releasing anything)."""
        me = threading.get_ident()
        ticket = current_ticket()
        with self._cond:
            if self._owner != me:
                return
            if ticket.abandoned:
                raise Abandoned
            if ticket.realtime or not (self._realtime or self._batch):
                return
            depth = self._depth
            self._owner, self._depth = None, 0
            self._batch_ran_at = self._clock()
            self._cond.notify_all()
            try:
                self._enter(_Waiter(ticket, self._clock()), abandonable=True)
            except Abandoned:
                _local.left_levels = (
                    getattr(_local, "left_levels", 0) + depth
                )  # the caller's `with`s release nothing
                raise
            self._depth = depth


MLX_GATE = MlxGate()


def stepwise[T](iterator: Iterator[T]) -> Iterator[T]:
    """Yield from `iterator`, holding the gate only while it computes the next item.

    A streaming synthesis is suspended between chunks while the client plays them; holding the gate across a yield
    would block every other MLX call for as long as the consumer takes. Each item is one unit of work, so live
    waiters get the gate between a batch caller's items."""
    iterator = iter(iterator)
    while True:
        with MLX_GATE:
            try:
                item = next(iterator)
            except StopIteration:
                return
        yield item
