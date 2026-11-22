"""Turn-taking: when does the user start and finish talking.

`TurnTaker` is a pure state machine. It never calls an engine and never sleeps: it is fed one VAD frame at a time
and answers with *commands* for the caller to carry out (feed the STT stream, run smart-turn, finish the turn).
That keeps every blocking call in the WebSocket layer, where it runs in the threadpool under the engine's lock,
and keeps this file testable with no engines and no clock beyond the `now_ms` it is handed.

Time inside the machine is audio time (frames x frame length), so a worker that falls behind real time does not
count that as silence. `now_ms` is wall time and is only used to time the smart-turn call itself: the
`TurnEnded.ms["turn"]` latency is "audio since the speaker stopped" plus "how long the check took".

The hand-off for a turn check is:

    cmds = taker.push(p, frame, now_ms)         # ... [RunTurnCheck(audio)]
    p_end = <run smart-turn on audio>
    cmds = taker.turn_checked(p_end, now_ms)    # ... [FinishTurn(...)] when p_end >= 0.5, else [] (keep waiting)

When the first check says "not done" and the speaker stays quiet for `SECOND_CHECK_MS` more, a second check runs
with a lower bar (`SECOND_TURN_PROB`): short phrases score low on the first check but not on the second.

and for the end of a turn `finalize_turn` does the STT flush and the optional second pass under its deadline.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

START_PROB = 0.5  # a frame at or above this is voiced
QUIET_PROB = 0.35  # a frame below this is quiet; in between neither starts nor ends anything
START_FRAMES = 2
PREROLL_MS = 300
TURN_PROB = 0.5
SECOND_CHECK_MS = 400  # a second smart-turn check this long after the first, if the speaker stayed quiet
SECOND_TURN_PROB = 0.3
CHECK_WINDOW_S = 8
MAX_UTTERANCE_MS = 30_000
MIN_VOICED_MS = 200
SECOND_PASS_DEADLINE_MS = 300

# eagerness -> (quiet ms before smart-turn is asked, quiet ms after which the turn ends regardless)
EAGERNESS: dict[str, tuple[int, int]] = {
    "low": (400, 2000),
    "normal": (200, 1500),
    "high": (120, 800),
}


# ---- what the machine asks of its caller --------------------------------------------------------------------
@dataclass(frozen=True)
class SpeechStarted:
    pass


@dataclass(frozen=True)
class FeedStt:
    audio: np.ndarray  # for the first one: the pre-roll plus the frames that triggered the start


@dataclass(frozen=True)
class RunTurnCheck:
    audio: np.ndarray  # the last 8 s of the utterance; answer with `turn_checked`
    n: int = 1  # 1 for the first check of a pause, 2 for the second


@dataclass(frozen=True)
class FinishTurn:
    audio: np.ndarray  # the whole utterance, for the second pass
    turn_ms: int  # audio since the speaker stopped, plus the smart-turn check's own time
    reason: str  # turn | max_wait | max_length | forced | blip
    empty: bool  # a blip: nothing to transcribe, the final text is ""


Command = SpeechStarted | FeedStt | RunTurnCheck | FinishTurn


@dataclass(frozen=True)
class Partial:
    text: str


@dataclass(frozen=True)
class TurnEnded:
    text: str
    ms: dict[str, int]  # {"turn": N, "stt": N}


class TurnTaker:
    def __init__(self, eagerness: str = "normal", *, frame_samples: int = 512, rate: int = 16_000) -> None:
        self._frame_samples = frame_samples
        self._rate = rate
        self.frame_ms = frame_samples * 1000 / rate
        self._ring: deque[np.ndarray] = deque(maxlen=math.ceil(PREROLL_MS / self.frame_ms) + START_FRAMES)
        self.set_eagerness(eagerness)
        self.reset()

    def set_eagerness(self, eagerness: str) -> None:
        if eagerness not in EAGERNESS:
            raise ValueError(f"eagerness must be one of {', '.join(EAGERNESS)}")
        self.eagerness = eagerness
        self.pause_ms, self.max_wait_ms = EAGERNESS[eagerness]

    def reset(self) -> None:
        """Back to idle, dropping any turn in progress."""
        self._ring.clear()
        self._run = 0  # consecutive voiced frames while idle
        self.active = False
        self._utterance: list[np.ndarray] = []
        self._voiced = 0
        self._quiet = 0
        self._checks = 0  # smart-turn checks asked since the speaker last talked
        self._checking = False  # a check is out and its answer has not arrived
        self._check_sent_ms = 0.0
        self._since_voiced = 0  # frames since the last voiced one
        self._last_text = ""

    # ---- input -------------------------------------------------------------------------------------------
    def push(self, prob: float, frame: np.ndarray, now_ms: float) -> list[Command]:
        if not self.active:
            return self._idle(prob, frame, now_ms)
        self._utterance.append(frame)
        cmds: list[Command] = [FeedStt(frame)]
        if prob >= START_PROB:
            self._voiced += 1
            self._quiet = 0
            self._checks = 0
            self._since_voiced = 0
        else:
            self._since_voiced += 1
            if prob < QUIET_PROB:
                self._quiet += 1
        if len(self._utterance) * self.frame_ms >= MAX_UTTERANCE_MS:
            cmds.append(self._finish(now_ms, "max_length"))
            return cmds
        quiet_ms = self._quiet * self.frame_ms
        if self._checks:
            if quiet_ms >= self.max_wait_ms:
                cmds.append(self._finish(now_ms, "max_wait"))
            elif self._checks == 1 and not self._checking and quiet_ms >= self.pause_ms + SECOND_CHECK_MS:
                cmds.append(self._ask(2, now_ms))
        elif self._quiet and quiet_ms >= self.pause_ms:
            if self._voiced * self.frame_ms < MIN_VOICED_MS:
                cmds.append(self._finish(now_ms, "blip"))
            else:
                cmds.append(self._ask(1, now_ms))
        return cmds

    def _ask(self, n: int, now_ms: float) -> RunTurnCheck:
        self._checks = n
        self._checking = True
        self._check_sent_ms = now_ms
        return RunTurnCheck(self._tail(), n)

    def turn_checked(self, p: float, now_ms: float) -> list[Command]:
        """The result of a `RunTurnCheck`: the turn ends when the model says the speaker is done."""
        if not self.active:
            return []
        self._checking = False
        if p < (TURN_PROB if self._checks == 1 else SECOND_TURN_PROB):
            return []
        return [self._finish(now_ms, "turn", check_ms=max(0.0, now_ms - self._check_sent_ms))]

    def force_end(self, now_ms: float) -> list[Command]:
        """`turn.end` from the client. With nobody talking there is no turn to end."""
        return [self._finish(now_ms, "forced")] if self.active else []

    def partial(self, text: str | None) -> list[Partial]:
        """The result of feeding the STT stream: an event only when the cumulative text changed."""
        if not self.active or text is None or text == self._last_text:
            return []
        self._last_text = text
        return [Partial(text)]

    # ---- internals ---------------------------------------------------------------------------------------
    def _idle(self, prob: float, frame: np.ndarray, now_ms: float) -> list[Command]:
        self._ring.append(frame)
        self._run = self._run + 1 if prob >= START_PROB else 0
        if self._run < START_FRAMES:
            return []
        self.active = True
        self._utterance = list(self._ring)
        self._ring.clear()
        self._voiced = self._run
        self._quiet = 0
        self._checks = 0
        self._checking = False
        self._since_voiced = 0
        self._last_text = ""
        return [SpeechStarted(), FeedStt(np.concatenate(self._utterance))]

    def _tail(self) -> np.ndarray:
        frames = math.ceil(CHECK_WINDOW_S * self._rate / self._frame_samples)
        return np.concatenate(self._utterance[-frames:])

    def _finish(self, now_ms: float, reason: str, *, check_ms: float = 0.0) -> FinishTurn:
        # Audio time since the speaker stopped, plus how long the turn check itself took (wall time).
        cmd = FinishTurn(
            audio=np.concatenate(self._utterance),
            turn_ms=round(self._since_voiced * self.frame_ms + check_ms),
            reason=reason,
            empty=reason == "blip",
        )
        self.reset()
        return cmd


# ---- the end of a turn ----------------------------------------------------------------------------------------
def _adopt(task: asyncio.Task, background: set[asyncio.Task] | None) -> None:
    """Track a second pass that is being stopped until it really has (it waits out its thread), so shutdown can await
    it, and log a failure instead of letting asyncio report it as never retrieved."""

    def done(t: asyncio.Task) -> None:
        if background is not None:
            background.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.warning("second pass failed", exc_info=t.exception())

    if background is not None:
        background.add(task)
    task.add_done_callback(done)


async def finalize_turn(
    cmd: FinishTurn,
    *,
    finish: Callable[[], Awaitable[str]],
    second_pass: Callable[[np.ndarray], Awaitable[str]] | None = None,
    deadline_ms: float = SECOND_PASS_DEADLINE_MS,
    clock: Callable[[], float] = lambda: time.monotonic() * 1000,
    background: set[asyncio.Task] | None = None,
) -> TurnEnded:
    """Turn a `FinishTurn` into the final text.

    `finish()` flushes the streaming STT. When `second_pass` is given (a batch engine), it starts alongside and its
    text replaces the streaming text if it is non-empty and arrives within `deadline_ms` of the decision; otherwise
    nothing would use its text, so it is cancelled (abandoning its wait for the GPU, see `run_serialized`) and tracked
    in `background` until its thread has stopped.
    """
    if cmd.empty:
        return TurnEnded("", {"turn": cmd.turn_ms, "stt": 0})
    started = clock()
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    task = asyncio.ensure_future(second_pass(cmd.audio)) if second_pass is not None else None
    try:
        text = await finish()
    except BaseException:
        if task is not None:
            _adopt(task, background)
            task.cancel()
        raise
    if task is not None:
        remaining = max(0.0, deadline_ms / 1000 - (loop.time() - t0))
        try:
            done, _ = await asyncio.wait({task}, timeout=remaining)
        except BaseException:  # cancelled while waiting (the session is closing): stop the second pass too
            _adopt(task, background)
            task.cancel()
            raise
        if task in done:
            try:
                better = (task.result() or "").strip()
            except Exception:  # the streaming text stands
                log.warning("second pass failed", exc_info=True)
                better = ""
            if better:
                text = better
        else:
            _adopt(task, background)
            task.cancel()
    return TurnEnded(text, {"turn": cmd.turn_ms, "stt": max(0, round(clock() - started))})
