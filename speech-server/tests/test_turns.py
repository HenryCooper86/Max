import asyncio

import numpy as np
import pytest

from max_speech.session.turns import (
    EAGERNESS,
    FeedStt,
    FinishTurn,
    Partial,
    RunTurnCheck,
    SpeechStarted,
    TurnTaker,
    finalize_turn,
)

FRAME = 512
FRAME_MS = FRAME / 16000 * 1000  # 32


def frame(v=0.0):
    return np.full(FRAME, v, dtype=np.float32)


class Driver:
    """Pushes frames with a fake clock that advances one frame length per push."""

    def __init__(self, eagerness="normal"):
        self.taker = TurnTaker(eagerness)
        self.now = 0.0
        self.log = []

    def push(self, p, v=None):
        self.now += FRAME_MS
        cmds = self.taker.push(p, frame(p if v is None else v), self.now)
        self.log.extend(cmds)
        return cmds

    def run(self, p, n):
        out = []
        for _ in range(n):
            out += self.push(p)
        return out

    def of(self, kind):
        return [c for c in self.log if isinstance(c, kind)]


def start(d, voiced=10):
    d.run(0.9, voiced)


def test_speech_start_needs_two_frames():
    d = Driver()
    assert d.push(0.9) == []
    cmds = d.push(0.9)
    assert isinstance(cmds[0], SpeechStarted)


def test_a_single_voiced_frame_is_not_speech():
    d = Driver()
    d.push(0.9)
    d.push(0.1)
    assert d.push(0.9) == []
    assert not d.of(SpeechStarted)


def test_in_between_probability_is_not_voiced_for_the_start():
    d = Driver()
    d.run(0.45, 5)
    assert not d.of(SpeechStarted)


def test_preroll_is_fed_to_stt_with_the_trigger_frames():
    d = Driver()
    for i in range(20):  # more silence than the pre-roll holds
        d.taker.push(0.0, frame(float(i) / 100), 0)
    first = d.taker.push(0.9, frame(1.0), 0)
    assert first == []
    cmds = d.taker.push(0.9, frame(2.0), 0)
    feed = next(c for c in cmds if isinstance(c, FeedStt))
    n = len(feed.audio) // FRAME
    assert n == 12  # 10 frames (320 ms) of pre-roll + the 2 trigger frames
    assert feed.audio[-FRAME:][0] == 2.0 and feed.audio[-2 * FRAME :][0] == 1.0
    assert feed.audio[0] == pytest.approx(0.10)  # frames 10..19 of the silence were kept


def test_frames_during_speech_are_fed_one_by_one():
    d = Driver()
    start(d, 2)
    cmds = d.push(0.9)
    assert [type(c) for c in cmds] == [FeedStt]
    assert len(cmds[0].audio) == FRAME


def test_partials_only_on_change():
    d = Driver()
    assert d.taker.partial("hi") == []  # not in a turn
    start(d, 2)
    assert d.taker.partial(None) == []
    assert d.taker.partial("hello") == [Partial("hello")]
    assert d.taker.partial("hello") == []
    assert d.taker.partial("hello there") == [Partial("hello there")]


def test_partial_state_resets_for_the_next_turn():
    d = Driver()
    start(d, 10)
    d.taker.partial("hello")
    d.taker.force_end(d.now)
    start(d, 2)
    assert d.taker.partial("hello") == [Partial("hello")]


@pytest.mark.parametrize("eagerness", ["low", "normal", "high"])
def test_check_runs_when_quiet_reaches_pause(eagerness):
    d = Driver(eagerness)
    start(d, 10)
    pause = EAGERNESS[eagerness][0]
    frames_needed = -(-pause // 32)  # ceil
    for _ in range(frames_needed - 1):
        assert not any(isinstance(c, RunTurnCheck) for c in d.push(0.1))
    cmds = d.push(0.1)
    assert any(isinstance(c, RunTurnCheck) for c in cmds)


def test_check_audio_is_the_last_eight_seconds():
    d = Driver()
    d.run(0.9, 400)  # 12.8 s of speech
    cmds = d.run(0.1, 7)
    check = next(c for c in cmds if isinstance(c, RunTurnCheck))
    assert len(check.audio) == 8 * 16000


def test_check_audio_is_everything_when_the_utterance_is_short():
    d = Driver()
    d.run(0.9, 10)
    check = next(c for c in d.run(0.1, 7) if isinstance(c, RunTurnCheck))
    assert len(check.audio) == 17 * FRAME


def test_high_probability_ends_the_turn():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    cmds = d.taker.turn_checked(0.8, d.now)
    (end,) = cmds
    assert isinstance(end, FinishTurn) and end.reason == "turn" and not end.empty
    assert len(end.audio) == 17 * FRAME
    assert not d.taker.active


def test_turn_ms_is_audio_quiet_plus_the_check_time():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    (end,) = d.taker.turn_checked(0.9, d.now + 12)  # the smart-turn call took 12 ms
    assert end.turn_ms == round(7 * FRAME_MS + 12)


def test_turn_ms_ignores_how_late_the_worker_processed_the_frames():
    taker = TurnTaker()
    wall = 10_000.0  # frames processed in a burst long after they were spoken: wall time is meaningless
    for _ in range(10):
        taker.push(0.9, frame(), wall)
    cmds = []
    for _ in range(7):
        cmds += taker.push(0.1, frame(), wall)
    assert any(isinstance(c, RunTurnCheck) for c in cmds)
    (end,) = taker.turn_checked(0.9, wall + 40)
    assert end.turn_ms == round(7 * FRAME_MS + 40)


def test_in_between_frames_count_towards_turn_ms_but_not_towards_quiet():
    d = Driver()
    start(d, 10)
    d.run(0.4, 3)
    d.run(0.1, 7)
    (end,) = d.taker.force_end(d.now)
    assert end.turn_ms == round(10 * FRAME_MS)


def test_a_second_check_runs_at_pause_plus_400_ms_with_a_lower_bar():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)  # first check at 224 ms of quiet
    assert d.taker.turn_checked(0.4, d.now) == []  # 0.4 < 0.5: keep waiting
    cmds = d.run(0.1, 11)  # 18 frames = 576 ms of quiet: short of 200 + 400
    assert not any(isinstance(c, (RunTurnCheck, FinishTurn)) for c in cmds)
    cmds = d.run(0.1, 1)  # 608 ms
    assert any(isinstance(c, RunTurnCheck) for c in cmds)
    assert sum(isinstance(c, RunTurnCheck) for c in d.log) == 2
    (end,) = d.taker.turn_checked(0.35, d.now + 5)  # 0.35 >= 0.3
    assert end.reason == "turn" and end.turn_ms == round(19 * FRAME_MS + 5)


def test_a_second_check_below_the_lower_bar_waits_for_max_wait():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    d.taker.turn_checked(0.4, d.now)
    d.run(0.1, 14)
    assert sum(isinstance(c, RunTurnCheck) for c in d.log) == 2
    assert d.taker.turn_checked(0.2, d.now) == []
    more = d.run(0.1, 20)
    assert not any(isinstance(c, RunTurnCheck) for c in more)  # only two checks per pause
    d.run(0.1, 20)
    assert d.of(FinishTurn) and d.of(FinishTurn)[0].reason == "max_wait"


def test_resumed_speech_resets_the_second_check():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    d.taker.turn_checked(0.4, d.now)
    d.run(0.9, 3)
    d.run(0.1, 7)
    assert sum(isinstance(c, RunTurnCheck) for c in d.log) == 2  # a fresh first check, not a second
    assert d.taker.turn_checked(0.4, d.now) == []  # and it still needs 0.5


def test_no_second_check_when_max_wait_comes_first():
    d = Driver("high")  # pause 120, max wait 800: second check would be at 520
    start(d, 10)
    d.run(0.1, 4)
    d.taker.turn_checked(0.0, d.now)
    d.run(0.1, 30)
    assert sum(isinstance(c, RunTurnCheck) for c in d.log) == 2
    assert d.of(FinishTurn)[0].reason == "max_wait"


def test_low_probability_waits_and_a_check_is_not_repeated():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    assert d.taker.turn_checked(0.2, d.now) == []
    assert d.taker.active
    more = d.run(0.1, 10)
    assert not any(isinstance(c, (RunTurnCheck, FinishTurn)) for c in more)


def test_resumed_speech_continues_the_turn_and_checks_again_later():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    d.taker.turn_checked(0.2, d.now)
    d.run(0.9, 5)  # speech resumes: same turn, no new SpeechStarted
    assert len(d.of(SpeechStarted)) == 1
    assert d.taker.active
    cmds = d.run(0.1, 7)
    assert any(isinstance(c, RunTurnCheck) for c in cmds)


def test_quiet_until_max_wait_ends_the_turn():
    d = Driver()
    start(d, 10)
    d.run(0.1, 7)
    d.taker.turn_checked(0.2, d.now)
    quiet_so_far = 7 * FRAME_MS
    frames = int(-(-(1500 - quiet_so_far) // 32))
    cmds = d.run(0.1, frames - 1)
    assert not any(isinstance(c, FinishTurn) for c in cmds)
    last = d.push(0.1)
    end = next(c for c in last if isinstance(c, FinishTurn))
    assert end.reason == "max_wait" and not end.empty


@pytest.mark.parametrize("eagerness", ["low", "normal", "high"])
def test_max_wait_per_eagerness(eagerness):
    d = Driver(eagerness)
    start(d, 10)
    pause, wait = EAGERNESS[eagerness]
    d.run(0.1, -(-pause // 32))
    d.taker.turn_checked(0.0, d.now)
    n = 0
    while not d.of(FinishTurn):
        d.push(0.1)
        n += 1
        assert n < 200
    assert -(-wait // 32) - 1 <= n + (-(-pause // 32)) - 0 <= -(-wait // 32) + 1


def test_in_between_frames_do_not_count_as_quiet():
    d = Driver()
    start(d, 10)
    cmds = d.run(0.4, 20)
    assert not any(isinstance(c, (RunTurnCheck, FinishTurn)) for c in cmds)


def test_a_short_blip_ends_empty_without_a_check():
    d = Driver()
    d.run(0.9, 2)  # 64 ms of voice
    cmds = d.run(0.1, 7)
    assert not any(isinstance(c, RunTurnCheck) for c in cmds)
    end = next(c for c in cmds if isinstance(c, FinishTurn))
    assert end.empty and end.reason == "blip"
    assert not d.taker.active


def test_exactly_enough_voice_is_a_real_utterance():
    d = Driver()
    d.run(0.9, 7)  # 224 ms >= 200
    cmds = d.run(0.1, 7)
    assert any(isinstance(c, RunTurnCheck) for c in cmds)


def test_thirty_seconds_ends_the_turn():
    d = Driver()
    start(d, 2)
    cmds = []
    n = 2
    while not any(isinstance(c, FinishTurn) for c in cmds):
        cmds = d.push(0.9)
        n += 1
        assert n < 2000
    end = next(c for c in cmds if isinstance(c, FinishTurn))
    assert end.reason == "max_length"
    assert n * FRAME_MS == pytest.approx(30_000, abs=FRAME_MS)
    # speech goes on: a new turn starts after two more voiced frames
    assert d.push(0.9) == []
    assert any(isinstance(c, SpeechStarted) for c in d.push(0.9))


def test_force_end():
    d = Driver()
    assert d.taker.force_end(d.now) == []  # nobody is talking
    start(d, 10)
    (end,) = d.taker.force_end(d.now + 5)
    assert end.reason == "forced" and not end.empty and end.turn_ms == 0  # still talking: no quiet yet
    assert not d.taker.active


def test_force_end_is_not_a_blip_even_when_short():
    d = Driver()
    d.run(0.9, 2)
    (end,) = d.taker.force_end(d.now)
    assert not end.empty


def test_reset_drops_the_turn():
    d = Driver()
    start(d, 10)
    d.taker.reset()
    assert not d.taker.active
    assert d.taker.turn_checked(0.9, 0) == []


def test_set_eagerness_validates():
    t = TurnTaker()
    with pytest.raises(ValueError):
        t.set_eagerness("eager")
    t.set_eagerness("high")
    assert t.pause_ms == 120


def test_after_a_turn_the_next_needs_fresh_start_frames():
    d = Driver()
    start(d, 10)
    d.taker.force_end(d.now)
    assert d.push(0.9) == []
    assert isinstance(d.push(0.9)[0], SpeechStarted)


# ---- finalize_turn -------------------------------------------------------------------------------------------
def finish_cmd(empty=False):
    return FinishTurn(audio=np.zeros(1600, dtype=np.float32), turn_ms=40, reason="turn", empty=empty)


async def test_finalize_uses_the_stream_text():
    async def finish():
        return "hello"

    end = await finalize_turn(finish_cmd(), finish=finish)
    assert end.text == "hello" and end.ms["turn"] == 40 and end.ms["stt"] >= 0


async def test_finalize_blip_skips_the_stream():
    async def finish():
        raise AssertionError("should not run")

    end = await finalize_turn(finish_cmd(empty=True), finish=finish)
    assert end.text == "" and end.ms == {"turn": 40, "stt": 0}


async def test_second_pass_wins_when_in_time():
    async def finish():
        return "stream text"

    async def second(audio):
        return " better text "

    end = await finalize_turn(finish_cmd(), finish=finish, second_pass=second)
    assert end.text == "better text"


async def test_second_pass_empty_keeps_stream_text():
    async def finish():
        return "stream text"

    async def second(audio):
        return "  "

    assert (await finalize_turn(finish_cmd(), finish=finish, second_pass=second)).text == "stream text"


async def test_second_pass_error_keeps_stream_text():
    async def finish():
        return "stream text"

    async def second(audio):
        raise RuntimeError("boom")

    assert (await finalize_turn(finish_cmd(), finish=finish, second_pass=second)).text == "stream text"


async def test_a_second_pass_that_misses_its_deadline_is_cancelled_and_tracked_until_it_stops():
    """Its text would be thrown away, so it is not left running (as live work, holding the STT lock): it is cancelled,
    which abandons it at the GPU gate, and kept in `background` until it has really stopped."""
    release = asyncio.Event()
    finished, cancelled = [], []

    async def finish():
        return "stream text"

    async def second(audio):
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.append(1)
            await asyncio.sleep(0.05)  # like run_serialized, it waits for its thread before it stops
            raise
        finished.append(1)
        return "late text"

    background = set()
    end = await finalize_turn(
        finish_cmd(), finish=finish, second_pass=second, deadline_ms=50, background=background
    )
    assert end.text == "stream text"
    assert len(background) == 1  # tracked while it winds down
    try:
        await asyncio.wait_for(asyncio.gather(*background, return_exceptions=True), 1)
    finally:
        release.set()
    await asyncio.sleep(0)
    assert cancelled == [1] and finished == [] and not background


async def test_second_pass_deadline_counts_from_the_decision():
    async def finish():
        await asyncio.sleep(0.12)
        return "stream text"

    async def second(audio):
        await asyncio.sleep(0.1)
        return "second"

    end = await finalize_turn(finish_cmd(), finish=finish, second_pass=second, deadline_ms=150)
    assert end.text == "second"  # already done when finish returned
    end = await finalize_turn(finish_cmd(), finish=finish, second_pass=second_slow(), deadline_ms=130)
    assert end.text == "stream text"


def second_slow():
    async def second(audio):
        await asyncio.sleep(0.5)
        return "never"

    return second
