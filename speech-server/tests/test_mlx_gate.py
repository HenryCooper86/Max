"""All MLX evaluation in the process goes through one lock: Metal command encoding from two threads at once is not
safe in every MLX release, and on the mlx profile Whisper (second pass) and the Qwen3 engines run on different
engine locks, so the server's own locks do not keep them apart."""

import itertools
import sys
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from max_speech.engines import mlx_gate
from max_speech.engines.base import ReferenceVoice
from max_speech.engines.mlx_gate import MLX_GATE, Abandoned, Ticket, working_for
from max_speech.engines.qwen3_design_mlx import Qwen3MlxDesign
from max_speech.engines.qwen3_mlx import Qwen3MlxCloning
from max_speech.engines.whisper_mlx import WhisperMlxStt


class Overlap:
    """What an MLX call looks like from outside: it must never be running twice at once."""

    def __init__(self):
        self.active = 0
        self.peak = 0
        self.calls = 0
        self._lock = threading.Lock()

    def enter(self):
        with self._lock:
            self.active += 1
            self.calls += 1
            self.peak = max(self.peak, self.active)

    def leave(self):
        with self._lock:
            self.active -= 1


def _fake_whisper(monkeypatch, probe):
    def transcribe(samples, **kw):
        probe.enter()
        time.sleep(0.03)
        probe.leave()
        return {"text": "hi", "segments": [], "language": "en"}

    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=transcribe))
    monkeypatch.setitem(
        sys.modules, "mlx_whisper.transcribe", SimpleNamespace()
    )  # no ModelHolder: no yield points
    return WhisperMlxStt("/models/w", "mlx-whisper-large-v3-turbo")


class SteppingModel:
    """generate() does its evaluation inside next(), as mlx-audio does."""

    def __init__(self, probe, steps=3):
        self.probe, self.steps = probe, steps

    def generate(self, **kw):
        for _ in range(self.steps):
            self.probe.enter()
            time.sleep(0.02)
            self.probe.leave()
            yield SimpleNamespace(audio=np.full(240, 0.1, dtype=np.float32))


def _run_together(*jobs):
    errors = []

    def wrap(job):
        def go():
            try:
                job()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        return go

    threads = [threading.Thread(target=wrap(job)) for job in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert not errors, errors


def test_whisper_and_cloning_never_evaluate_at_the_same_time(monkeypatch):
    probe = Overlap()
    stt = _fake_whisper(monkeypatch, probe)
    cloning = Qwen3MlxCloning(None, "q", model=SteppingModel(probe), to_array=lambda s: s)
    ref = ReferenceVoice("v", np.zeros(2400, dtype=np.float32), 24000, "Hello.", "en")

    def speak():
        for _ in range(3):
            list(cloning.synthesize_cloned("One. Two. Three.", ref))

    def listen():
        for _ in range(6):
            stt.transcribe(np.zeros(16000, dtype=np.float32), 16000)

    _run_together(speak, listen, listen)
    assert probe.calls > 20 and probe.peak == 1


def test_design_and_whisper_never_evaluate_at_the_same_time(monkeypatch):
    probe = Overlap()
    stt = _fake_whisper(monkeypatch, probe)
    design = Qwen3MlxDesign(
        "/m",
        "d",
        loader=lambda p: SteppingModel(probe),
        seeder=lambda s: None,
        release=lambda: None,
        sweeper=False,
    )

    def make_voice():
        for i in range(3):
            design.design("a calm voice", "Hello.", "en", i)

    def listen():
        for _ in range(6):
            stt.transcribe(np.zeros(16000, dtype=np.float32), 16000)

    _run_together(make_voice, listen)
    assert probe.peak == 1


def test_a_paused_stream_does_not_hold_the_lock(monkeypatch):
    """A sentence's audio waits in a queue while the client plays it: that wait must not block Whisper."""
    probe = Overlap()
    stt = _fake_whisper(monkeypatch, probe)
    cloning = Qwen3MlxCloning(None, "q", model=SteppingModel(probe, steps=2), to_array=lambda s: s)
    ref = ReferenceVoice("v", np.zeros(2400, dtype=np.float32), 24000, "Hello.", "en")
    stream = cloning.synthesize_cloned("One.", ref)
    next(stream)  # suspended mid-sentence, as when the consumer is not reading
    done = threading.Event()
    threading.Thread(
        target=lambda: (stt.transcribe(np.zeros(16000, dtype=np.float32), 16000), done.set()), daemon=True
    ).start()
    assert done.wait(2), "whisper was blocked by a suspended synthesis stream"
    list(stream)


# ---- live work first: the gate's two lanes ------------------------------------------------------------------------


def _until(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < end, "timed out"
        time.sleep(0.002)


def _hold_in_thread(ticket=None, *, until):
    """A thread that takes the gate (as batch work unless `ticket` says otherwise) and keeps it until `until` is set."""
    entered = threading.Event()

    def run():
        with working_for(ticket or Ticket()), MLX_GATE:
            entered.set()
            until.wait(10)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert entered.wait(5)
    return thread


def test_realtime_waiters_go_before_batch_waiters():
    release = threading.Event()
    holder = _hold_in_thread(until=release)
    order = []

    def wait(name, realtime):
        with working_for(Ticket(realtime=realtime)), MLX_GATE:
            order.append(name)

    batch = threading.Thread(target=wait, args=("batch", False))
    batch.start()
    time.sleep(0.05)  # the batch waiter is queued first
    live = threading.Thread(target=wait, args=("live", True))
    live.start()
    _until(lambda: MLX_GATE.realtime_waiting == 1)
    release.set()
    for t in (holder, batch, live):
        t.join(5)
    assert order == ["live", "batch"]


def test_batch_work_yields_to_a_live_waiter_at_its_next_yield_point():
    """A long batch call (many windows) lets a live waiter in between two windows, then carries on."""
    windows, order = 10, []
    live_waited = []

    def batch():
        with MLX_GATE:
            for i in range(windows):
                MLX_GATE.yield_point()
                order.append(f"w{i}")
                time.sleep(0.05)

    def live():
        start = time.monotonic()
        with working_for(Ticket(realtime=True)), MLX_GATE:
            live_waited.append(time.monotonic() - start)
            order.append("live")

    b = threading.Thread(target=batch)
    b.start()
    _until(lambda: len(order) >= 2)
    live_thread = threading.Thread(target=live)
    live_thread.start()
    b.join(5)
    live_thread.join(5)
    assert "live" in order and order.index("live") < len(order) - 2, order
    assert live_waited[0] < 0.2  # at most one window (0.05 s), not the rest of the call (0.4 s)
    assert sorted(x for x in order if x != "live") == sorted(f"w{i}" for i in range(windows))
    assert not MLX_GATE.held


def test_a_yield_point_keeps_a_reentrant_hold_intact():
    with MLX_GATE, MLX_GATE:
        MLX_GATE.yield_point()  # nobody waiting: a no-op
        assert MLX_GATE.held
    assert not MLX_GATE.held
    release = threading.Event()
    done = []

    def live():
        with working_for(Ticket(realtime=True)), MLX_GATE:
            done.append(True)

    def batch():
        with MLX_GATE, MLX_GATE:
            release.set()
            _until(lambda: MLX_GATE.realtime_waiting == 1)
            MLX_GATE.yield_point()  # gives up both levels, then takes both back
            done.append(MLX_GATE.held)
        done.append(MLX_GATE.held)

    b = threading.Thread(target=batch)
    b.start()
    release.wait(5)
    live_thread = threading.Thread(target=live)
    live_thread.start()
    b.join(5)
    live_thread.join(5)
    assert done == [True, True, False]


def test_batch_work_waits_out_the_short_gaps_between_a_live_sentences_chunks():
    """A live sentence takes the gate once per chunk and lets go in between (a hop back to the event loop). Batch work
    waiting for the gate must not slip into those gaps, or the sentence would wait for a batch unit at every chunk
    and finish late (and play back with gaps)."""
    order = []
    live_started = threading.Event()

    def live():
        with working_for(Ticket(realtime=True)):
            for i in range(8):
                with MLX_GATE:
                    live_started.set()
                    order.append(f"chunk{i}")
                    time.sleep(0.02)
                time.sleep(0.01)  # the hop between two chunks

    def batch():
        live_started.wait(5)
        with MLX_GATE:
            order.append("batch")

    threads = [threading.Thread(target=live), threading.Thread(target=batch)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert order[-1] == "batch", order


def test_back_to_back_live_sentences_cannot_starve_batch_work():
    """Live sentences with no pause between them (a long reply, several riders) would keep batch work inside the grace
    forever; after BATCH_PATIENCE_S a waiting batch call gets one unit anyway (live work still goes first whenever it
    is actually waiting)."""
    stop = threading.Event()
    got_in = []

    def live():
        with working_for(Ticket(realtime=True)):
            while not stop.is_set():
                with MLX_GATE:
                    time.sleep(0.02)
                time.sleep(0.005)  # always back within the grace

    def batch():
        start = time.monotonic()
        with MLX_GATE:
            got_in.append(time.monotonic() - start)

    live_thread = threading.Thread(target=live)
    live_thread.start()
    time.sleep(0.05)
    b = threading.Thread(target=batch)
    b.start()
    patience = getattr(mlx_gate, "BATCH_PATIENCE_S", 2.0)
    try:
        b.join(patience + 3)
    finally:
        stop.set()
        live_thread.join(5)
        b.join(5)
    assert got_in, "batch work never got the gate"
    assert patience - 0.1 <= got_in[0] < patience + 0.5, got_in


def test_an_abandoned_waiter_stops_waiting_at_once():
    release = threading.Event()
    holder = _hold_in_thread(until=release)
    ticket = Ticket(realtime=True)
    outcome = []

    def wait():
        try:
            with working_for(ticket), MLX_GATE:
                outcome.append("ran")
        except Abandoned:
            outcome.append("abandoned")

    t = threading.Thread(target=wait)
    t.start()
    _until(lambda: MLX_GATE.realtime_waiting == 1)
    start = time.monotonic()
    ticket.abandon()
    t.join(5)
    assert outcome == ["abandoned"] and time.monotonic() - start < 0.5
    assert MLX_GATE.realtime_waiting == 0 and MLX_GATE.held  # the holder is untouched
    release.set()
    holder.join(5)


def test_an_abandoned_batch_call_stops_at_its_next_yield_point():
    ticket = Ticket()
    steps = []

    def batch():
        try:
            with working_for(ticket), MLX_GATE:
                for i in range(100):
                    MLX_GATE.yield_point()
                    steps.append(i)
                    time.sleep(0.01)
        except Abandoned:
            steps.append("abandoned")

    t = threading.Thread(target=batch)
    t.start()
    _until(lambda: len(steps) >= 3)
    ticket.abandon()
    t.join(5)
    assert steps[-1] == "abandoned" and len(steps) < 20
    assert not MLX_GATE.held


def test_stepwise_lets_a_live_waiter_in_between_batch_items():
    def items():
        for i in range(6):
            time.sleep(0.05)
            yield i

    order = []

    def batch():
        for i in mlx_gate.stepwise(items()):
            order.append(i)  # noqa: PERF402 - appended one at a time, while the live thread watches

    b = threading.Thread(target=batch)
    b.start()
    _until(lambda: len(order) >= 1)

    def live():
        with working_for(Ticket(realtime=True)), MLX_GATE:
            order.append("live")

    live_thread = threading.Thread(target=live)
    live_thread.start()
    b.join(5)
    live_thread.join(5)
    assert order.index("live") <= 3, order


# ---- the MLX engines cut long batch work into short units -----------------------------------------------------------
class _WindowModel:
    def decode(self, segment, options):
        time.sleep(0.05)
        return "window"


class _Holder:
    """Stands in for mlx_whisper.transcribe.ModelHolder: the real transcribe() calls model.decode once per 30 s window
    (and once more per temperature fallback)."""

    model = None

    @classmethod
    def get_model(cls, path, dtype):
        if cls.model is None:
            cls.model = _WindowModel()
        return cls.model


def _windowed_whisper(monkeypatch, windows):
    _Holder.model = None

    def transcribe(samples, **kw):
        model = _Holder.get_model(kw["path_or_hf_repo"], None)
        for _ in range(windows):
            model.decode(None, None)
        return {"text": "hi", "segments": [], "language": "en"}

    package = SimpleNamespace(transcribe=transcribe)
    monkeypatch.setitem(sys.modules, "mlx_whisper", package)
    monkeypatch.setitem(sys.modules, "mlx_whisper.transcribe", SimpleNamespace(ModelHolder=_Holder))
    return WhisperMlxStt("/models/w", "mlx-whisper-large-v3-turbo")


def test_a_long_transcription_lets_a_live_cloned_sentence_in_between_windows(monkeypatch):
    """The reviewer's case: a batch transcription (20 windows, 1 s) and a live cloned sentence that arrives during it.
    The sentence waits for one window, not for the whole transcription."""
    stt = _windowed_whisper(monkeypatch, windows=20)
    probe = Overlap()
    cloning = Qwen3MlxCloning(None, "q", model=SteppingModel(probe, steps=2), to_array=lambda s: s)
    ref = ReferenceVoice("v", np.zeros(2400, dtype=np.float32), 24000, "Hello.", "en")
    started = threading.Event()
    batch = threading.Thread(
        target=lambda: (started.set(), stt.transcribe(np.zeros(16000, dtype=np.float32), 16000))
    )
    batch.start()
    started.wait(5)
    _until(lambda: MLX_GATE.held)
    time.sleep(0.1)
    t0 = time.monotonic()
    with working_for(Ticket(realtime=True)):
        first = next(iter(cloning.synthesize_cloned("Hello.", ref)))
    waited = time.monotonic() - t0
    batch.join(5)
    assert first.size and waited < 0.2, f"the live sentence waited {waited:.2f}s behind the transcription"
    assert probe.peak == 1


def test_a_live_second_pass_runs_beside_a_batch_transcription(monkeypatch):
    stt = _windowed_whisper(monkeypatch, windows=20)
    batch = threading.Thread(target=lambda: stt.transcribe(np.zeros(16000, dtype=np.float32), 16000))
    batch.start()
    _until(lambda: MLX_GATE.held)
    time.sleep(0.1)
    t0 = time.monotonic()
    with working_for(Ticket(realtime=True)):
        stt.transcribe(np.zeros(1600, dtype=np.float32), 16000)  # 20 windows of its own: 1 s
    elapsed = time.monotonic() - t0
    batch.join(5)
    assert elapsed < 1.3, elapsed  # its own work plus at most one batch window, not the batch's whole second


def test_without_the_model_holder_a_transcription_still_holds_the_gate(monkeypatch):
    probe = Overlap()
    stt = _fake_whisper(
        monkeypatch, probe
    )  # a module with no ModelHolder: no yield points, but still exclusive
    calls = []
    real = stt._mlx.transcribe

    def spy(samples, **kw):
        calls.append(MLX_GATE.held)
        return real(samples, **kw)

    stt._mlx = SimpleNamespace(transcribe=spy)
    stt.transcribe(np.zeros(16000, dtype=np.float32), 16000)
    assert calls == [True]


class StreamingDesignModel:
    """A design model that streams: each chunk is a unit of evaluation."""

    def __init__(self, probe, chunks=8, step=0.05):
        self.probe, self.chunks, self.step = probe, chunks, step
        self.calls = []

    def generate(self, **kw):
        self.calls.append(kw)
        for _ in range(self.chunks if kw.get("stream") else 1):
            self.probe.enter()
            time.sleep(self.step if kw.get("stream") else self.step * self.chunks)
            self.probe.leave()
            yield SimpleNamespace(audio=np.full(240, 0.1, dtype=np.float32))


def test_voice_design_lets_a_live_sentence_in_between_chunks(monkeypatch):
    probe = Overlap()
    model = StreamingDesignModel(probe, chunks=10, step=0.05)
    design = Qwen3MlxDesign(
        "/m", "d", loader=lambda p: model, seeder=lambda s: None, release=lambda: None, sweeper=False
    )
    design.ensure_loaded()
    cloning = Qwen3MlxCloning(None, "q", model=SteppingModel(probe, steps=1), to_array=lambda s: s)
    ref = ReferenceVoice("v", np.zeros(2400, dtype=np.float32), 24000, "Hello.", "en")
    batch = threading.Thread(target=lambda: design.design("a calm voice", "Hello there.", "en", 3))
    batch.start()
    _until(lambda: MLX_GATE.held)
    time.sleep(0.07)
    t0 = time.monotonic()
    with working_for(Ticket(realtime=True)):
        list(cloning.synthesize_cloned("Hello.", ref))
    waited = time.monotonic() - t0
    batch.join(5)
    assert waited < 0.2, f"the live sentence waited {waited:.2f}s behind voice design"
    assert model.calls[0]["stream"] is True and probe.peak == 1


def test_mlx_random_state_is_per_thread():
    """Voice design seeds mlx's generator and then lets other MLX work run between its chunks: that only keeps the
    seed's promise (same seed, same voice) because mlx keeps the generator per thread."""
    mx = pytest.importorskip("mlx.core")

    def draw(interfere):
        mx.random.seed(7)
        first = mx.random.uniform(shape=(4,)).tolist()
        if interfere:
            t = threading.Thread(target=lambda: [mx.random.uniform(shape=(4,)).tolist() for _ in range(3)])
            t.start()
            t.join()
        return first, mx.random.uniform(shape=(4,)).tolist()

    assert draw(False) == draw(True)


def test_batch_waiters_are_served_first_come_first_served():
    """A stepwise batch caller (voice design) takes the gate again right after each chunk; another batch waiter (a
    transcription) must get its turn after one chunk, not after the whole design."""
    order = []

    def design():
        for i in range(20):
            with MLX_GATE:
                order.append(f"d{i}")
                time.sleep(0.02)
            sum(range(200))  # its own work between chunks

    d = threading.Thread(target=design)
    d.start()
    _until(lambda: len(order) >= 2)
    start = time.monotonic()
    with MLX_GATE:
        waited = time.monotonic() - start
        order.append("other")
    d.join(5)
    assert waited < 0.1, f"the other batch caller waited {waited:.2f}s"
    assert order.index("other") <= 5, order


def test_a_long_batch_call_takes_turns_with_another_batch_caller_at_its_yield_points():
    order = []

    def long_call():
        with MLX_GATE:
            for i in range(20):
                MLX_GATE.yield_point()
                order.append(f"w{i}")
                time.sleep(0.02)

    t = threading.Thread(target=long_call)
    t.start()
    _until(lambda: len(order) >= 2)
    with MLX_GATE:
        order.append("other")
    t.join(5)
    assert order.index("other") <= 5, order


def test_batch_work_keeps_moving_when_two_live_threads_overlap():
    """Two live threads whose units overlap keep a realtime waiter present at every moment; once a batch waiter has
    waited BATCH_PATIENCE_S it is due and takes the next free moment, for one unit, ahead of them. Live work then
    waits for at most that one unit."""
    stop = threading.Event()
    live_waits = []

    def live(hold):
        with working_for(Ticket(realtime=True)):
            while not stop.is_set():
                start = time.monotonic()
                with MLX_GATE:
                    live_waits.append(time.monotonic() - start)
                    time.sleep(hold)
                time.sleep(0.003)

    threads = [threading.Thread(target=live, args=(h,)) for h in (0.05, 0.3)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    got = []
    unit = 0.05

    def batch():
        for _ in range(3):
            start = time.monotonic()
            with MLX_GATE:
                got.append(time.monotonic() - start)
                time.sleep(unit)

    b = threading.Thread(target=batch)
    b.start()
    try:
        b.join(3 * mlx_gate.BATCH_PATIENCE_S + 3)
    finally:
        stop.set()
        for t in threads:
            t.join(5)
        b.join(5)
    assert len(got) == 3, got
    assert all(w < mlx_gate.BATCH_PATIENCE_S + 0.5 for w in got), got
    assert max(live_waits) < 0.3 + unit + 0.15, max(live_waits)  # one live unit plus at most one batch unit


def test_a_batch_waiter_whose_patience_runs_out_while_the_gate_is_free_takes_it():
    """Regression: becoming due while nobody holds the gate (only the grace keeps it out) must not leave the waiter
    sleeping with nothing left to wake it."""
    gate = mlx_gate.MlxGate(grace_s=1.0, patience_s=0.2)
    took = []
    held = threading.Event()
    release = threading.Event()

    def live():
        with working_for(Ticket(realtime=True)), gate:
            held.set()
            release.wait(5)

    def batch():
        start = time.monotonic()
        with gate:
            took.append(time.monotonic() - start)

    r = threading.Thread(target=live)
    r.start()
    held.wait(5)
    b = threading.Thread(target=batch)
    b.start()
    time.sleep(0.05)
    release.set()  # the grace now runs for 1 s; the batch waiter's patience runs out first, with the gate free
    b.join(3)
    r.join(3)
    assert took and took[0] < 0.6, took


def test_the_decode_yield_point_leaves_no_reference_cycle(monkeypatch):
    """The patched decode must not tie the model to itself (model -> wrapper -> bound method -> model): a cycle keeps
    the weights alive until a full garbage collection, which then frees MLX memory at an arbitrary moment."""
    import gc
    import weakref

    class Model:
        def decode(self, segment, options):
            return "window"

    class Holder:
        model = None

        @classmethod
        def get_model(cls, path, dtype):
            if cls.model is None:
                cls.model = Model()
            return cls.model

    monkeypatch.setitem(
        sys.modules, "mlx_whisper", SimpleNamespace(transcribe=lambda samples, **kw: {"text": ""})
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper.transcribe", SimpleNamespace(ModelHolder=Holder))
    stt = WhisperMlxStt("/models/w", "mlx-whisper-large-v3-turbo")
    stt.transcribe(np.zeros(1600, dtype=np.float32), 16000)
    with MLX_GATE:
        assert Holder.model.decode(None, None) == "window"  # still decodes, through the yield point
    ref = weakref.ref(Holder.model)
    gc.disable()
    try:
        Holder.model = None
        assert ref() is None, "the model is only freed by the cycle collector"
    finally:
        gc.enable()


# ---- due batch work must not chain across batch callers; clock edges; abandoning inside a yield -------------------
def _batch_vs_live(unit, patience, duration):
    """Two batch callers (yield points between units of `unit` s) and two overlapping live threads on a private gate.
    Returns (holder timeline, live waits, batch units run)."""
    gate = mlx_gate.MlxGate(patience_s=patience, grace_s=0.05)
    stop = threading.Event()
    timeline, live_waits = [], []

    def live(name):
        with working_for(Ticket(realtime=True)):
            while not stop.is_set():
                start = time.monotonic()
                with gate:
                    live_waits.append(time.monotonic() - start)
                    timeline.append(name)
                    time.sleep(0.05)
                time.sleep(0.002)

    def batch(name):
        with working_for(Ticket()), gate:
            while not stop.is_set():
                timeline.append(name)
                time.sleep(unit)
                gate.yield_point()

    threads = [threading.Thread(target=live, args=(n,), daemon=True) for n in ("R1", "R2")]
    for t in threads:
        t.start()
    time.sleep(0.02)
    threads += [threading.Thread(target=batch, args=(n,), daemon=True) for n in ("B1", "B2")]
    for t in threads[2:]:
        t.start()
    time.sleep(duration)
    stop.set()
    for t in threads:
        t.join(unit + 2)
    return timeline, live_waits, sum(1 for h in timeline if h.startswith("B"))


def _batch_handoffs(timeline):
    return sum(
        1 for a, b in itertools.pairwise(timeline) if a.startswith("B") and b.startswith("B") and a != b
    )


def test_due_batch_work_does_not_chain_from_one_batch_caller_to_another():
    """Two batch callers at the gate: when one has run its due unit, the other must not be due at once (it has not
    waited a patience since batch work last ran), or the two alternate and live work waits for both or for ever."""
    timeline, live_waits, batch_units = _batch_vs_live(unit=0.1, patience=0.3, duration=3.0)
    assert max(live_waits) < 0.1 + 0.05 + 0.1, max(live_waits)  # one batch unit and one live unit, with slack
    assert _batch_handoffs(timeline) == 0, timeline
    assert batch_units >= 4  # batch still moves: about one unit per patience


def test_a_batch_unit_longer_than_the_patience_does_not_starve_live_work():
    timeline, live_waits, batch_units = _batch_vs_live(unit=0.5, patience=0.3, duration=3.0)
    assert max(live_waits) < 0.5 + 0.05 + 0.15, max(live_waits)
    assert _batch_handoffs(timeline) == 0, timeline
    assert batch_units >= 2


def test_a_batch_waiter_does_not_oversleep_when_the_grace_ends_between_two_clock_reads():
    """Deterministic: the clock jumps past the end of the grace right after `_may_take` said no. The waiter must
    re-check at once, not sleep until its patience runs out with the gate free."""
    offset = [0.0]
    jumped = []

    class Gapped(mlx_gate.MlxGate):
        def _may_take(self, waiter):
            ok = super()._may_take(waiter)
            if (
                not ok
                and not jumped
                and not waiter.ticket.realtime
                and self._owner is None
                and not self._realtime
                and self._clock() < self._realtime_until
            ):
                jumped.append(True)
                offset[0] += self._realtime_until - self._clock() + 1e-6  # the grace ends right here
            return ok

    gate = Gapped(clock=lambda: time.monotonic() + offset[0], patience_s=2.0, grace_s=0.15)

    def live():
        with working_for(Ticket(realtime=True)), gate:
            time.sleep(0.2)

    took = []

    def batch():
        with gate:
            took.append(time.monotonic())

    r = threading.Thread(target=live)
    r.start()
    time.sleep(0.05)
    b = threading.Thread(target=batch)
    b.start()
    r.join(5)
    released = time.monotonic()
    b.join(5)
    assert jumped and took and took[0] - released < 0.3, (jumped, took and took[0] - released)


def test_an_abandoned_batch_call_waiting_inside_a_yield_point_leaves_at_once():
    gate_held = threading.Event()
    release = threading.Event()

    def live():  # a long live unit, so the batch call's turn is far away
        with working_for(Ticket(realtime=True)), MLX_GATE:
            gate_held.set()
            release.wait(5)

    ticket = Ticket()
    outcome = []

    def batch():
        try:
            with working_for(ticket), MLX_GATE:
                live_thread.start()
                _until(lambda: MLX_GATE.realtime_waiting == 1)
                MLX_GATE.yield_point()  # a live waiter is queued: give the gate up and wait for a turn
                outcome.append("resumed")
        except Abandoned:
            outcome.append("abandoned")
        except Exception as exc:  # noqa: BLE001 - e.g. a release by a thread that does not hold the gate
            outcome.append(repr(exc))

    live_thread = threading.Thread(target=live)
    b = threading.Thread(target=batch)
    b.start()
    _until(lambda: gate_held.is_set())  # the live thread got the gate at the batch call's yield point
    start = time.monotonic()
    ticket.abandon()
    b.join(2)
    left = time.monotonic() - start
    try:
        assert outcome == ["abandoned"] and left < 0.3, (outcome, left)
        assert MLX_GATE.held and MLX_GATE.batch_waiting == 0  # the live unit still runs; nothing left queued
    finally:
        release.set()
        live_thread.join(5)
    with MLX_GATE:  # and the gate is in order afterwards
        pass
    assert not MLX_GATE.held
