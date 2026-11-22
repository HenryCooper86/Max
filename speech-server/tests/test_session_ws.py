import asyncio
import json
import threading
import time

import numpy as np
import pytest
import uvicorn
import websockets
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from voice_helpers import good_wav, wav_of

from max_speech.engines.fake import FakeStt, FakeTts
from max_speech.engines.fake_cloning import FakeCloningTts
from max_speech.engines.mlx_gate import MLX_GATE, stepwise
from max_speech.settings import Settings
from max_speech.voices.store import VoiceStore

FRAME = 512
LOUD = (np.full(FRAME, 8000, dtype="<i2")).tobytes()
QUIET = np.zeros(FRAME, dtype="<i2").tobytes()


class Probe:
    """Records overlapping calls: engines are not re-entrant, so any overlap is a bug."""

    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.calls = 0
        self._lock = threading.Lock()

    def __enter__(self):
        with self._lock:
            self.active += 1
            self.calls += 1
            self.max_active = max(self.max_active, self.active)

    def __exit__(self, *exc):
        with self._lock:
            self.active -= 1


class FakeVadStream:
    frame_samples = FRAME

    def __init__(self, probe):
        self.probe = probe
        self.resets = 0

    def probability(self, frame):
        with self.probe:
            assert len(frame) == FRAME and frame.dtype == np.float32
            return 0.9 if float(np.abs(frame).max()) > 0.1 else 0.0

    def reset(self):
        self.resets += 1


class FakeVad:
    id = "fake-vad"
    model_id = "fake-vad-model"

    def __init__(self):
        self.probe = Probe()

    def new_stream(self):
        return FakeVadStream(self.probe)


class FakeSttStream:
    def __init__(self, engine, language, keyterms):
        self.engine = engine
        self.language = language
        self.keyterms = keyterms
        self.n = 0
        self.last = None

    def accept(self, audio):
        with self.engine.probe:
            self.n += len(audio)
            self.engine.fed.append(len(audio))
            text = f"heard {self.n // 1024}" if self.n >= 1024 else ""
            if text and text != self.last:
                self.last = text
                return text
            return None

    def finish(self):
        with self.engine.probe:
            return f"final {self.n // 1024}" if self.n >= 1024 else ""

    def reset(self):
        with self.engine.probe:
            self.n = 0
            self.last = None
            self.engine.resets += 1


class FakeStreamingStt:
    id = "fake-stream"
    model_id = "fake-stream-model"

    def __init__(self):
        self.probe = Probe()
        self.streams = []
        self.fed = []
        self.resets = 0

    def new_stream(self, *, language=None, keyterms=()):
        s = FakeSttStream(self, language, keyterms)
        self.streams.append(s)
        return s

    def warm_up(self):
        pass


class FakeTurn:
    id = "fake-turn"
    model_id = "fake-turn-model"

    def __init__(self, p=0.9):
        self.p = p
        self.probe = Probe()
        self.calls = []

    def turn_complete(self, utterance):
        with self.probe:
            self.calls.append(len(utterance))
            return self.p

    def warm_up(self):
        pass


class SlowTts(FakeTts):
    """One 100 ms chunk per sentence, and a record of what ran."""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.probe = Probe()
        self.texts = []

    def synthesize(self, text, voice, *, speed=1.0, language=None):
        with self.probe:
            self.texts.append((text, voice, language))
            time.sleep(self.delay)
        yield from super().synthesize(text, voice, speed=speed, language=language)


@pytest.fixture
def engines():
    return {
        "vad": FakeVad(),
        "turn": FakeTurn(),
        "stt_stream": FakeStreamingStt(),
        "tts": SlowTts(),
    }


@pytest.fixture
def build(make_app, engines):
    def go(settings=None, **kw):
        merged = {**engines, **kw}
        return make_app(settings, **merged)

    return go


def connect(app, headers=None, host="127.0.0.1"):
    client = TestClient(app, client=(host, 5000))
    return client, client.websocket_connect("/v1/speech/session", headers=dict(headers or {}))


def open_session(ws, update=None):
    ws.send_json(update or {"type": "session.update"})
    ready = ws.receive_json()
    assert ready["type"] == "ready", ready
    return ready


def recv_until(ws, kind, binary=None, limit=200):
    """Collect messages up to and including the first of type `kind`."""
    seen = []
    for _ in range(limit):
        message = ws.receive()
        if message.get("bytes") is not None:
            seen.append(message["bytes"])
            continue
        data = json.loads(message["text"])
        seen.append(data)
        if data["type"] == kind:
            return seen
    raise AssertionError(f"no {kind}: {seen}")


def say(ws, loud_frames=10, quiet_frames=12):
    for _ in range(loud_frames):
        ws.send_bytes(LOUD)
    for _ in range(quiet_frames):
        ws.send_bytes(QUIET)


# ---- the conversation --------------------------------------------------------------------------------------------
def test_ready_names_the_engines(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        ready = open_session(ws)
    assert ready == {
        "type": "ready",
        "protocol": "max-speech.session.v1",
        "engines": {
            "vad": "fake-vad-model",
            "turn": "fake-turn-model",
            "stt": "fake-stream-model",
            "tts": "fake-tts",
        },
        "idle_timeout_s": None,  # off by default: a quiet (muted) client is not closed
    }


def test_ready_says_when_an_idle_timeout_is_set(build):
    client, cm = connect(build(Settings(session_idle_timeout_s=90)))
    with client, cm as ws:
        assert open_session(ws)["idle_timeout_s"] == 90


def test_nothing_is_sent_before_the_first_session_update(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        ws.send_json({"type": "speak", "id": "r1", "text": "hi", "final": True})
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "no_session"
        open_session(ws)


def test_full_listening_turn(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws, {"type": "session.update", "languages": ["en"], "keyterms": ["Max"]})
        say(ws)
        msgs = recv_until(ws, "transcript.final")
    types = [m["type"] for m in msgs]
    assert types[0] == "speech.started"
    partials = [m["text"] for m in msgs if m["type"] == "transcript.partial"]
    assert partials and len(set(partials)) == len(partials)  # only on change
    assert partials[0] == "heard 1"
    final = msgs[-1]
    assert final["text"].startswith("final ") and final["text"] != "final 0"
    assert set(final["ms"]) == {"turn", "stt"}
    # audio time: smart-turn is asked after 7 quiet frames (224 ms), plus the (instant) check
    assert 224 <= final["ms"]["turn"] < 224 + 400
    stream = engines["stt_stream"].streams[0]
    assert stream.language == "en" and stream.keyterms == ("Max",)
    assert engines["turn"].calls  # smart-turn was asked
    assert engines["stt_stream"].resets >= 1


def test_two_turns_in_a_row(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        say(ws)
        first = recv_until(ws, "transcript.final")
        say(ws, loud_frames=8)
        second = recv_until(ws, "transcript.final")
    assert first[0]["type"] == second[0]["type"] == "speech.started"
    # a fresh stream: the first turn's 10 loud frames (5 s of samples // 1024) are not carried over
    assert second[-1]["text"].startswith("final") and second[-1]["text"] != first[-1]["text"]


def test_audio_sent_before_ready_is_not_lost(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        ws.send_bytes(LOUD)
        ws.send_bytes(LOUD)
        open_session(ws)
        say(ws, loud_frames=8)
        msgs = recv_until(ws, "transcript.final")
    assert msgs[0]["type"] == "speech.started"


def test_odd_byte_chunks_and_tiny_chunks_are_reassembled(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        data = LOUD * 10 + QUIET * 12
        for i in range(0, len(data), 333):  # not a multiple of 2 or of the frame
            ws.send_bytes(data[i : i + 333])
        msgs = recv_until(ws, "transcript.final")
    assert msgs[0]["type"] == "speech.started"


def test_blip_gives_an_empty_final(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        say(ws, loud_frames=2, quiet_frames=10)
        msgs = recv_until(ws, "transcript.final")
    assert msgs[-1]["text"] == ""


def test_turn_end_forces_the_final(build, engines):
    engines["turn"].p = 0.0  # smart-turn would wait
    app = build(turn=engines["turn"])
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        for _ in range(10):
            ws.send_bytes(LOUD)
        ws.send_json({"type": "turn.end"})
        msgs = recv_until(ws, "transcript.final")
    assert msgs[-1]["text"].startswith("final")


def test_turn_end_without_speech_does_nothing(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_json({"type": "turn.end"})
        ws.send_json({"type": "speak", "id": "r1", "text": "", "final": True})
        assert ws.receive_json() == {"type": "audio.done", "id": "r1", "cancelled": False}


def test_eagerness_is_applied(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws, {"type": "session.update", "turn": {"eagerness": "high"}})
        say(ws, loud_frames=10, quiet_frames=4)  # 128 ms quiet: past high's 120 ms, short of normal's 200
        recv_until(ws, "transcript.final")


def test_second_pass_replaces_the_text(build):
    app = build(second_pass=True)
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        say(ws)
        msgs = recv_until(ws, "transcript.final")
    assert msgs[-1]["text"].startswith("heard ") and "s" in msgs[-1]["text"]  # FakeStt: "heard 0.4s"


def test_second_pass_off_by_default(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        say(ws)
        msgs = recv_until(ws, "transcript.final")
    assert msgs[-1]["text"].startswith("final")


def test_session_update_can_change_languages_midway(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_json({"type": "session.update", "languages": ["zh"]})
        ws.send_json({"type": "speak", "id": "r1", "text": "", "final": True})
        ws.receive_json()  # audio.done: the update before it has been handled by now
    langs = [s.language for s in engines["stt_stream"].streams]
    deadline = time.time() + 2
    while langs[-1] != "zh" and time.time() < deadline:
        time.sleep(0.01)
        langs = [s.language for s in engines["stt_stream"].streams]
    assert langs == [None, "zh"]


# ---- speaking -------------------------------------------------------------------------------------------------------
def test_speak_streams_audio(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws, {"type": "session.update", "voice": "bravo"})
        ws.send_json({"type": "speak", "id": "r1", "text": "Hello there. How are", "final": False})
        ws.send_json({"type": "speak", "id": "r1", "text": " you?", "final": True})
        msgs = recv_until(ws, "audio.done")
    kinds = [m["type"] if isinstance(m, dict) else "audio" for m in msgs]
    assert kinds[0] == "audio.start" and kinds[-1] == "audio.done" and kinds.count("audio.start") == 1
    assert msgs[0] == {"type": "audio.start", "id": "r1", "sampleRate": 24000}
    assert msgs[-1] == {"type": "audio.done", "id": "r1", "cancelled": False}
    audio = [m for m in msgs if isinstance(m, bytes)]
    assert audio and all(len(a) % 2 == 0 for a in audio)
    # FakeTts is 22.05 kHz and "Hello there." is 0.2 s: resampled to 24 kHz
    assert len(audio[0]) == round(0.2 * 22050 * 24000 / 22050) * 2
    assert {v for _, v, _ in engines["tts"].texts} == {"bravo"}


def test_gender_picks_the_voice_and_voice_wins(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws, {"type": "session.update", "gender": "male"})
        ws.send_json({"type": "speak", "id": "a", "text": "Hi there.", "final": True})
        recv_until(ws, "audio.done")
        ws.send_json({"type": "session.update", "voice": "alpha", "gender": "male"})
        ws.send_json({"type": "speak", "id": "b", "text": "Hi again.", "final": True})
        recv_until(ws, "audio.done")
    assert [v for _, v, _ in engines["tts"].texts] == ["bravo", "alpha"]


def test_unknown_voice_is_an_error_and_the_session_continues(build, engines):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        ws.send_json({"type": "session.update", "voice": "nobody"})
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "unknown_voice"
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "speak", "id": "a", "text": "Hi there.", "final": True})
        recv_until(ws, "audio.done")
    assert engines["tts"].texts[0][1] == "alpha"


def test_replies_are_spoken_in_order(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_json({"type": "speak", "id": "a", "text": "One two. Three four.", "final": False})
        ws.send_json({"type": "speak", "id": "b", "text": "Five six.", "final": True})
        ws.send_json({"type": "speak", "id": "a", "text": "", "final": True})
        msgs = recv_until(ws, "audio.done")
        msgs += recv_until(ws, "audio.done")
    marks = [(m["type"], m["id"]) for m in msgs if isinstance(m, dict)]
    assert marks == [("audio.start", "a"), ("audio.done", "a"), ("audio.start", "b"), ("audio.done", "b")]


def test_cancel_stops_the_reply(build, engines):
    tts = SlowTts(delay=0.15)
    app = build(tts=tts)
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_json(
            {
                "type": "speak",
                "id": "r1",
                "text": "One two. Three four. Five six. Seven eight.",
                "final": True,
            }
        )
        ws.send_json({"type": "cancel", "id": "r1"})
        msgs = recv_until(ws, "audio.done")
        assert msgs[-1] == {"type": "audio.done", "id": "r1", "cancelled": True}
        ws.send_json({"type": "speak", "id": "r2", "text": "Hi there.", "final": True})
        after = recv_until(ws, "audio.done")
    assert after[-1] == {"type": "audio.done", "id": "r2", "cancelled": False}
    assert len(tts.texts) <= 3  # r1 stopped early; r2 ran
    assert not any(isinstance(m, dict) and m["type"] == "audio.done" and m["id"] == "r1" for m in after)


def test_listening_and_speaking_at_once(build):
    tts = SlowTts(delay=0.02)
    app = build(tts=tts)
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_json({"type": "speak", "id": "r1", "text": "One two. Three four. Five six.", "final": True})
        say(ws)
        seen = []
        done = finals = False
        while not (done and finals):
            m = ws.receive()
            if m.get("bytes") is not None:
                continue
            data = json.loads(m["text"])
            seen.append(data["type"])
            done = done or data["type"] == "audio.done"
            finals = finals or data["type"] == "transcript.final"
    assert "speech.started" in seen and seen.count("audio.done") == 1


# ---- malformed input ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "payload, code",
    [
        ("not json", "bad_message"),
        ("[1, 2]", "bad_message"),
        ("{}", "bad_message"),
        ('{"type": 5}', "bad_message"),
        ('{"type": "dance"}', "unknown_type"),
        ('{"type": "speak"}', "bad_message"),
        ('{"type": "speak", "id": "", "text": "x"}', "bad_message"),
        ('{"type": "speak", "id": "r", "text": 5}', "bad_message"),
        ('{"type": "speak", "id": "r", "text": "x", "final": "yes"}', "bad_message"),
        ('{"type": "cancel"}', "bad_message"),
        ('{"type": "session.update", "turn": {"eagerness": "frantic"}}', "bad_message"),
        ('{"type": "session.update", "languages": "en"}', "bad_message"),
        ('{"type": "session.update", "gender": "robot"}', "bad_message"),
    ],
)
def test_bad_messages_get_an_error_and_the_session_continues(build, payload, code):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_text(payload)
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == code and err["message"]
        ws.send_json({"type": "speak", "id": "ok", "text": "", "final": True})
        assert ws.receive_json() == {"type": "audio.done", "id": "ok", "cancelled": False}


def test_bad_first_message_does_not_end_the_handshake(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        ws.send_text("nope")
        assert ws.receive_json()["code"] == "bad_message"
        open_session(ws)


# ---- loading, disabled engines, auth --------------------------------------------------------------------------
def test_loading_gets_an_error_and_close_1013(build):
    app = build(ready=threading.Event())
    client, cm = connect(app)
    with client, cm as ws:
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "loading"
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 1013


def test_load_failure_is_reported(build):
    app = build(ready=threading.Event())
    app.state.slots.fail("no such model")
    client, cm = connect(app)
    with client, cm as ws:
        err = ws.receive_json()
        assert err["code"] == "load_failed" and "no such model" in err["message"]
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 1011


@pytest.mark.parametrize("missing", ["vad", "turn", "stt_stream", "tts"])
def test_a_disabled_engine_refuses_the_session(build, missing):
    app = build(**{missing: None})
    client, cm = connect(app)
    with client, cm as ws:
        err = ws.receive_json()
        assert err["code"] == "engine_disabled" and missing in err["message"]
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_key_required_closes_before_accept(build):
    app = build(Settings(api_key="secret"))
    for headers in (None, {"Authorization": "Bearer nope"}):
        client, cm = connect(app, headers)
        with client, pytest.raises(WebSocketDisconnect) as info, cm:
            pass
        assert info.value.code == 1008


def test_key_accepted(build):
    app = build(Settings(api_key="secret"))
    client, cm = connect(app, {"Authorization": "Bearer secret"}, host="10.1.2.3")
    with client, cm as ws:
        open_session(ws)


def test_non_loopback_without_key_is_refused(build):
    app = build()
    client, cm = connect(app, host="10.1.2.3")
    with client, pytest.raises(WebSocketDisconnect) as info, cm:
        pass
    assert info.value.code == 1008


# ---- concurrency and cleanup ---------------------------------------------------------------------------------------
class BlockingVad(FakeVad):
    """A VAD whose next `probability` call parks its worker thread until `gate` is set."""

    def __init__(self):
        super().__init__()
        self.gate = threading.Event()
        self.gate.set()
        self.entered = threading.Event()
        self.parked = 0  # threads waiting inside the engine on the gate

    def new_stream(self):
        stream = super().new_stream()
        inner = stream.probability

        def probability(frame):
            if not self.gate.is_set():
                self.parked += 1
                self.entered.set()
                self.gate.wait(10)
                self.parked -= 1
            return inner(frame)

        stream.probability = probability
        return stream


def test_disconnect_mid_turn_releases_every_lock(build, engines):
    vad = engines["vad"] = BlockingVad()
    app = build(vad=vad)
    slots = app.state.slots
    held_at_release = []

    def release_later():
        vad.entered.wait(5)
        time.sleep(0.3)  # the client is long gone by now
        held_at_release.append((slots.vad_lock.locked(), vad.parked))
        vad.gate.set()

    client, cm = connect(app)
    with client:
        with cm as ws:
            open_session(ws)
            vad.gate.clear()
            releaser = threading.Thread(target=release_later, daemon=True)
            releaser.start()
            ws.send_bytes(LOUD * 4)
            assert vad.entered.wait(5)
        # The client has disconnected while a thread is inside the VAD. Keep the server running (the test
        # client's loop would otherwise cancel the teardown) until that thread has been let go.
        releaser.join(10)
        wait_for(lambda: not slots.vad_lock.locked())
    assert held_at_release == [(True, 1)], "the lock must stay held while a thread is inside the engine"
    for lock in (slots.vad_lock, slots.turn_lock, slots.stt_stream_lock, slots.tts_lock, slots.stt_lock):
        assert not lock.locked()
    for engine in ("vad", "turn", "stt_stream"):
        assert engines[engine].probe.active == 0


def test_second_pass_in_flight_at_disconnect_is_cancelled(build):
    class SlowStt(FakeStt):
        def transcribe(self, audio, rate, **kw):
            time.sleep(0.5)
            return super().transcribe(audio, rate, **kw)

    app = build(stt=SlowStt(), second_pass=True)
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        say(ws)
        msgs = recv_until(ws, "transcript.final")
        assert msgs[-1]["text"].startswith("final")  # missed the 300 ms deadline
    assert not app.state.slots.stt_lock.locked()


def test_concurrent_sessions_never_overlap_inside_an_engine(build, engines):
    app = build(Settings(max_sessions=3), tts=SlowTts(delay=0.01))
    client = TestClient(app, client=("127.0.0.1", 5000))
    results = []

    def run(i):
        with client.websocket_connect("/v1/speech/session") as ws:
            open_session(ws)
            ws.send_json({"type": "speak", "id": f"r{i}", "text": "One two. Three four.", "final": True})
            say(ws)
            got = recv_until(ws, "transcript.final")
            if not any(isinstance(m, dict) and m["type"] == "audio.done" for m in got):
                recv_until(ws, "audio.done")
            results.append(got[-1]["text"])

    threads = [threading.Thread(target=run, args=(i,)) for i in range(3)]
    with client:  # one event loop for all three sessions, as in production
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
    assert len(results) == 3
    for key in ("vad", "turn", "stt_stream"):
        assert engines[key].probe.max_active == 1, key
    assert app.state.slots.tts.probe.max_active == 1


# ---- over a real socket (uvicorn): disconnects arrive as the server sees them, not as TestClient fakes them ------
@pytest.fixture
def live(build):
    servers = []

    def start(app):
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.time() + 10
        while not server.started and time.time() < deadline:
            time.sleep(0.01)
        servers.append((server, thread))
        return f"ws://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}/v1/speech/session"

    yield start
    for server, thread in servers:
        server.should_exit = True
        thread.join(timeout=5)


def wait_for(pred, timeout=5.0):
    end = time.time() + timeout
    while not pred():
        assert time.time() < end, "timed out"
        time.sleep(0.01)


async def test_live_disconnect_mid_speech_stops_synthesis_and_frees_the_lock(build, live):
    tts = SlowTts(delay=0.2)
    app = build(tts=tts)
    url = live(app)
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "session.update"}))
        assert json.loads(await ws.recv())["type"] == "ready"
        text = "One two. Three four. Five six. Seven eight."
        await ws.send(json.dumps({"type": "speak", "id": "r1", "text": text, "final": True}))
        wait_for(lambda: tts.texts)
    wait_for(lambda: tts.probe.active == 0 and not app.state.slots.tts_lock.locked())
    await asyncio.sleep(0.4)
    assert len(tts.texts) <= 2  # nothing new started after the client left
    assert not app.state.slots.tts_lock.locked()


SESSION_TASKS = (
    "_Session._work",
    "_Session._write",
    "_Session._shutdown",
    "ReplySpeaker._run",
    "SynthJob._run",
)


class LoopSpy:
    """ASGI wrapper that remembers the server's event loop so a test can look at its tasks."""

    def __init__(self, app):
        self.app = app
        self.loop = None
        self.state = app.state

    async def __call__(self, scope, receive, send):
        self.loop = asyncio.get_running_loop()
        await self.app(scope, receive, send)

    def session_tasks(self):
        async def names():
            return [
                t.get_coro().__qualname__
                for t in asyncio.all_tasks()
                if t.get_coro().__qualname__ in SESSION_TASKS
            ]

        return asyncio.run_coroutine_threadsafe(names(), self.loop).result(5)


async def test_live_disconnect_mid_turn_frees_every_lock(build, live, engines):
    vad = engines["vad"] = BlockingVad()
    spy = LoopSpy(build(vad=vad))
    url = live(spy)
    slots = spy.state.slots
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "session.update"}))
        assert json.loads(await ws.recv())["type"] == "ready"
        vad.gate.clear()
        await ws.send(LOUD * 4)
        wait_for(vad.entered.is_set)
    # The client is gone while a thread is inside the VAD: the lock stays held until that thread returns.
    await asyncio.sleep(0.3)
    assert slots.vad_lock.locked() and vad.parked == 1
    assert spy.session_tasks(), "the session is still shutting down, waiting for the engine"
    vad.gate.set()
    wait_for(lambda: not slots.vad_lock.locked() and not spy.session_tasks())
    for lock in (slots.turn_lock, slots.stt_stream_lock, slots.tts_lock, slots.stt_lock):
        assert not lock.locked()
    assert vad.probe.active == 0


async def test_live_refused_connection_is_http_403(build, live):
    url = live(build(Settings(api_key="secret")))
    with pytest.raises(websockets.exceptions.InvalidStatus) as info:
        async with websockets.connect(url):
            pass
    assert info.value.response.status_code == 403
    async with websockets.connect(url, additional_headers={"Authorization": "Bearer secret"}) as ws:
        await ws.send(json.dumps({"type": "session.update"}))
        assert json.loads(await ws.recv())["type"] == "ready"


async def test_live_loading_close_code(build, live):
    url = live(build(ready=threading.Event()))
    async with websockets.connect(url) as ws:
        assert json.loads(await ws.recv())["code"] == "loading"
        with pytest.raises(websockets.exceptions.ConnectionClosed) as info:
            await ws.recv()
    assert info.value.rcvd.code == 1013


# ---- bounded queues ------------------------------------------------------------------------------------------------
class FakeWs:
    def __init__(self):
        self.sent = []
        self.closed = None
        self.block = asyncio.Event()  # set: sends complete

    async def send_bytes(self, data):
        await self.block.wait()
        self.sent.append(data)

    async def send_text(self, text):
        await self.block.wait()
        self.sent.append(text)

    async def close(self, code=1000, reason=None):
        self.closed = (code, reason)


async def test_a_client_that_lets_audio_pile_up_is_closed_slow_reader():
    from max_speech.api import session_ws

    ws = FakeWs()
    session = session_ws._Session(ws, None)
    writer = asyncio.create_task(session._write())
    chunk = b"\0" * 48_000  # 1 s of 24 kHz PCM16
    session.emit(chunk)
    await asyncio.sleep(0.01)  # the writer is now stuck sending it
    for _ in range(6):
        session.emit(chunk)
    assert ws.closed is None and session.outbox_bytes == 6 * 48_000  # 5 s waiting is allowed
    session.emit(chunk)
    await asyncio.sleep(0.05)
    assert ws.closed == (1008, "slow_reader")
    assert session.dead and session.outbox.empty()
    session.emit(chunk)  # nothing more is queued
    assert session.outbox.empty()
    writer.cancel()
    await session._closing


async def test_a_client_that_takes_nothing_for_5_seconds_is_closed_slow_reader(monkeypatch):
    from max_speech.api import session_ws

    monkeypatch.setattr(session_ws, "SEND_TIMEOUT_S", 0.1)
    ws = FakeWs()  # a send never completes
    session = session_ws._Session(ws, None)
    writer = asyncio.create_task(session._write())
    session.emit({"type": "ready"})
    await asyncio.wait_for(writer, 2)
    await session._closing
    assert ws.closed == (1008, "slow_reader") and session.dead


async def test_one_long_chunk_is_not_a_backlog():
    from max_speech.api import session_ws

    ws = FakeWs()
    ws.block.set()
    session = session_ws._Session(ws, None)
    writer = asyncio.create_task(session._write())
    for _ in range(3):  # sentences of 20 s of audio, as a fast engine produces them
        session.emit(b"\0" * 960_000)
        await asyncio.sleep(0.01)
    assert ws.closed is None and len(ws.sent) == 3
    writer.cancel()


async def test_a_reading_client_is_not_closed():
    from max_speech.api import session_ws

    ws = FakeWs()
    ws.block.set()
    session = session_ws._Session(ws, None)
    writer = asyncio.create_task(session._write())
    for _ in range(30):  # 30 s of audio over time, always drained
        session.emit(b"\0" * 48_000)
        await asyncio.sleep(0.005)
    assert ws.closed is None and len(ws.sent) == 30 and session.outbox_bytes == 0
    writer.cancel()


def test_inbox_overflow_drops_audio_keeps_markers_and_reports_overrun():
    from max_speech.api import session_ws

    async def go():
        session = session_ws._Session(None, None)
        session._enqueue_audio(b"\0" * 200_000)
        session.inbox.put_nowait(session_ws._TurnEnd())
        session._enqueue_audio(b"\0" * 100_000)
        assert session.inbox_bytes == 300_000 and session.outbox.empty()
        session._enqueue_audio(b"\0" * 100_000)  # 400 KB > ~10 s
        items = [session.inbox.get_nowait() for _ in range(session.inbox.qsize())]
        assert [type(i).__name__ for i in items] == ["_TurnEnd", "_Overrun"]
        assert session.inbox_bytes == 0
        assert session.outbox.get_nowait()["code"] == "overrun"

    asyncio.run(go())


def test_overrun_mid_turn_closes_the_turn_with_an_empty_final(build, engines):
    vad = engines["vad"] = BlockingVad()
    app = build(vad=vad)
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        for _ in range(10):
            ws.send_bytes(LOUD)
        assert recv_until(ws, "speech.started")
        vad.gate.clear()
        ws.send_bytes(LOUD)  # the worker takes this one and parks inside the VAD
        assert vad.entered.wait(5)
        for _ in range(11):
            ws.send_bytes(b"\0" * 32_000)  # 352 KB queued behind it
        msgs = recv_until(ws, "error")
        assert msgs[-1]["code"] == "overrun"
        vad.gate.set()
        final = recv_until(ws, "transcript.final")[-1]
        assert final["text"] == ""
        # the session carries on: a new turn works
        say(ws)
        assert recv_until(ws, "transcript.final")[-1]["text"].startswith("final")


def test_engine_work_is_cut_into_pieces_of_at_most_a_second(build, engines, monkeypatch):
    from max_speech.api import session_ws

    pieces = []
    real = session_ws.run_serialized

    async def spy(lock, fn, *args):
        if fn.__name__ == "_probabilities":
            pieces.append(len(args[0]))
        return await real(lock, fn, *args)

    monkeypatch.setattr(session_ws, "run_serialized", spy)
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        ws.send_bytes(LOUD * 160 + QUIET * 40)  # 6.4 s in one message
        recv_until(ws, "transcript.final")
    # The turn ends around frame 170; the remaining quiet frames may or may not be processed before the client
    # closes, so only the speech up to the final is certain to have gone through the VAD.
    assert 160 <= sum(pieces) <= 200 and max(pieces) <= 31 and len(pieces) >= 6
    assert max(engines["stt_stream"].fed) <= 16_000


# ---- a turn that is dropped still ends ---------------------------------------------------------------------------
def test_an_engine_failure_mid_turn_still_closes_the_turn(build, engines):
    stt = engines["stt_stream"]
    real = stt.new_stream

    def new_stream(**kw):
        stream = real(**kw)
        accept = stream.accept
        calls = []

        def flaky(audio):
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("boom")
            return accept(audio)

        stream.accept = flaky
        return stream

    stt.new_stream = new_stream
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        for _ in range(10):
            ws.send_bytes(LOUD)
        msgs = recv_until(ws, "transcript.final")
    assert [m["type"] for m in msgs if isinstance(m, dict)][-2:] == ["error", "transcript.final"]
    assert msgs[-1]["text"] == "" and msgs[-1]["ms"] == {"turn": 0, "stt": 0}


def test_reconfigure_mid_turn_closes_the_turn(build):
    app = build()
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        for _ in range(10):
            ws.send_bytes(LOUD)
        assert recv_until(ws, "speech.started")
        ws.send_json({"type": "session.update", "languages": ["zh"]})
        final = recv_until(ws, "transcript.final")[-1]
        assert final["text"] == ""


def test_custom_voice_through_session_update(build, engines, tmp_path):
    from voice_helpers import STATEMENT, good_wav

    from max_speech.engines.fake_cloning import FakeCloningTts

    cloning = FakeCloningTts()
    app = build(Settings(data_dir=tmp_path), cloning=cloning)
    voice = app.state.slots.voices.create(
        audio=good_wav(),
        name="Ava",
        transcript="hello there",
        consent=True,
        consent_statement=STATEMENT,
        consent_speaker="Ava Lee",
    )
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws, {"type": "session.update", "voice": voice.id})
        ws.send_json({"type": "speak", "id": "r1", "text": "Hello there.", "final": True})
        msgs = recv_until(ws, "audio.done")
        ws.send_json({"type": "session.update", "voice": "v_0000000000"})
        err = ws.receive_json()
    assert msgs[-1] == {"type": "audio.done", "id": "r1", "cancelled": False}
    audio = [m for m in msgs if isinstance(m, bytes)]
    assert audio and len(audio[0]) == round(0.2 * 24000) * 2
    assert [c[1] for c in cloning.calls] == [voice.id]
    assert engines["tts"].texts == []  # the preset engine never ran
    assert err["type"] == "error" and err["code"] == "unknown_voice"


# ---- limits: concurrent sessions, handshake and idle timeouts -------------------------------------------------
def test_sessions_over_the_cap_are_refused_busy_with_1013(build):
    app = build(Settings(max_sessions=1))
    first_client, first_cm = connect(app)
    with first_client, first_cm as first:
        open_session(first)
        client, cm = connect(app)
        with client, cm as second:
            err = second.receive_json()
            assert err["type"] == "error" and err["code"] == "busy" and "1" in err["message"]
            with pytest.raises(WebSocketDisconnect) as info:
                second.receive_json()
            assert (info.value.code, info.value.reason) == (1013, "busy")
        first.send_json({"type": "speak", "id": "r1", "text": "", "final": True})  # the first is unaffected
        assert first.receive_json()["type"] == "audio.done"
    assert app.state.slots.sessions == 0


def test_a_finished_session_frees_its_place(build):
    app = build(Settings(max_sessions=1))
    for _ in range(3):
        client, cm = connect(app)
        with client, cm as ws:
            open_session(ws)


def test_the_default_cap_follows_the_profile(build):
    from max_speech.api import session_ws

    assert session_ws.session_cap(Settings(), "cpu") == 2
    assert session_ws.session_cap(Settings(max_sessions=5), "cpu") == 5


def test_a_client_that_never_sends_session_update_is_dropped(build):
    app = build(Settings(session_handshake_timeout_s=0.2))
    client, cm = connect(app)
    with client, cm as ws:
        err = ws.receive_json()
        assert err["code"] == "handshake_timeout" and "session.update" in err["message"]
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert (info.value.code, info.value.reason) == (1008, "handshake_timeout")
    assert app.state.slots.sessions == 0


def test_an_idle_session_is_closed_and_any_message_keeps_it_alive(build):
    app = build(Settings(session_idle_timeout_s=0.4))
    client, cm = connect(app)
    with client, cm as ws:
        open_session(ws)
        for _ in range(4):  # 0.8 s in all, but never 0.4 s without a message
            time.sleep(0.2)
            ws.send_bytes(QUIET)
        err = ws.receive_json()
        assert err["code"] == "idle_timeout"
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert (info.value.code, info.value.reason) == (1000, "idle_timeout")


def test_a_quiet_session_is_kept_open_by_default(build, monkeypatch):
    """A muted rider's relay stops sending audio; with the default settings the session is not timed out."""
    waits = []
    real = asyncio.wait_for

    async def spy(aw, timeout):
        waits.append(timeout)
        return await real(aw, timeout)

    monkeypatch.setattr("max_speech.api.session_ws.asyncio.wait_for", spy)
    client, cm = connect(build())
    with client, cm as ws:
        open_session(ws)
        ws.send_bytes(QUIET)
        ws.send_json({"type": "speak", "id": "r1", "text": "", "final": True})
        assert ws.receive_json()["type"] == "audio.done"
    assert waits[0] == 15.0  # the handshake keeps its timeout
    assert None in waits[1:] and all(w is None or w == 5.0 for w in waits[1:])  # receives: none; sends: 5 s


def test_a_dead_peer_is_closed_by_the_server_ping_and_frees_its_slot(build):
    """The server's own uvicorn config (cli._uvicorn_config) pings every client; a peer that stops answering (its
    network went away) is closed when the pong is late, and its session slot is freed. The intervals are shortened
    here; in production they are cli.WS_PING_INTERVAL_S and cli.WS_PING_TIMEOUT_S."""
    import socket

    from max_speech import cli

    app = build(Settings(max_sessions=1))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = cli._uvicorn_config(app, Settings(host="127.0.0.1", port=port))
    config.ws_ping_interval, config.ws_ping_timeout = 0.3, 0.3
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    wait_for(lambda: server.started, timeout=10)
    url = f"ws://127.0.0.1:{port}/v1/speech/session"

    async def scenario():
        dead = await websockets.connect(url, ping_interval=None)
        await dead.send(json.dumps({"type": "session.update"}))
        assert json.loads(await dead.recv())["type"] == "ready"
        assert app.state.slots.sessions == 1
        dead.transport.pause_reading()  # gone: it neither reads nor answers pings from here on
        start = time.monotonic()
        while app.state.slots.sessions:
            assert time.monotonic() - start < 5, "the dead peer still holds its slot"
            await asyncio.sleep(0.05)
        async with websockets.connect(url) as ws:  # the slot is free for the next rider
            await ws.send(json.dumps({"type": "session.update"}))
            assert json.loads(await ws.recv())["type"] == "ready"
        dead.transport.abort()

    try:
        asyncio.run(scenario())
    finally:
        server.should_exit = True
        thread.join(5)


def test_timeouts_of_zero_are_off(build):
    app = build(Settings(session_handshake_timeout_s=0, session_idle_timeout_s=0))
    client, cm = connect(app)
    with client, cm as ws:
        time.sleep(0.3)
        open_session(ws)
        time.sleep(0.3)
        ws.send_json({"type": "speak", "id": "r1", "text": "", "final": True})
        assert ws.receive_json()["type"] == "audio.done"


# ---- what the live recognizer can do: languages and keyterms --------------------------------------------------
class BilingualStt(FakeStreamingStt):
    languages = ("zh", "en")
    keyterms = False


def _warnings(ws, count_after):
    """Send a barrier (an empty final reply) and return the warnings seen before its audio.done."""
    ws.send_json({"type": "speak", "id": count_after, "text": "", "final": True})
    return [m for m in recv_until(ws, "audio.done") if isinstance(m, dict) and m["type"] == "warning"]


def test_ready_publishes_the_live_languages_and_keyterm_support(build):
    client, cm = connect(build(stt_stream=BilingualStt()))
    with client, cm as ws:
        ready = open_session(ws)
    assert ready["languages"] == ["zh", "en"] and ready["keyterms"] is False


def test_ready_omits_what_the_engine_does_not_declare(build):
    client, cm = connect(build())
    with client, cm as ws:
        ready = open_session(ws)
    assert "languages" not in ready and "keyterms" not in ready


def test_an_unsupported_language_without_a_second_pass_gets_one_warning(build):
    client, cm = connect(build(stt_stream=BilingualStt()))
    with client, cm as ws:
        ws.send_json({"type": "session.update", "languages": ["en", "ja"]})
        assert ws.receive_json()["type"] == "ready"
        warning = ws.receive_json()
        assert warning["type"] == "warning" and warning["code"] == "language_unsupported"
        assert warning["languages"] == ["ja"] and warning["supported"] == ["zh", "en"]
        ws.send_json({"type": "session.update", "languages": ["en", "ja"]})  # the same request again
        assert _warnings(ws, "b1") == []
        ws.send_json({"type": "session.update", "languages": ["ko"]})  # a different one
        assert [w["languages"] for w in _warnings(ws, "b2")] == [["ko"]]


def test_a_second_pass_covers_a_language_the_stream_cannot_do(build):
    client, cm = connect(build(stt_stream=BilingualStt(), second_pass=True, stt=FakeStt()))
    with client, cm as ws:
        ws.send_json({"type": "session.update", "languages": ["ja"]})
        assert ws.receive_json()["type"] == "ready"
        assert _warnings(ws, "b1") == []


def test_supported_languages_and_region_tags_do_not_warn(build):
    client, cm = connect(build(stt_stream=BilingualStt()))
    with client, cm as ws:
        ws.send_json({"type": "session.update", "languages": ["zh-CN", "en_US"]})
        assert ws.receive_json()["type"] == "ready"
        assert _warnings(ws, "b1") == []


def test_an_unrecognised_language_code_is_dropped_with_a_warning(build, engines):
    client, cm = connect(build())
    with client, cm as ws:
        ws.send_json({"type": "session.update", "languages": ["xx", "fr-CA"]})
        warning = ws.receive_json()
        assert warning["type"] == "warning" and warning["code"] == "language_unknown"
        assert warning["languages"] == ["xx"]
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "speak", "id": "a", "text": "Hi there.", "final": True})
        recv_until(ws, "audio.done")
    assert engines["tts"].texts[0][2] == "fr"  # the one valid language, normalised


def test_keyterms_a_stream_cannot_use_get_one_warning(build):
    client, cm = connect(build(stt_stream=BilingualStt()))
    with client, cm as ws:
        ws.send_json({"type": "session.update", "keyterms": ["Max"]})
        assert ws.receive_json()["type"] == "ready"
        assert ws.receive_json()["code"] == "keyterms_unsupported"
        ws.send_json({"type": "session.update", "keyterms": ["Max", "Kokoro"]})
        assert _warnings(ws, "b1") == []


def test_speak_with_bad_fields_names_its_reply(build):
    client, cm = connect(build())
    with client, cm as ws:
        open_session(ws)
        ws.send_json({"type": "speak", "id": "r7", "text": 5, "final": True})
        err = ws.receive_json()
        assert err["code"] == "bad_message" and err["id"] == "r7"


# ---- live speech and the MLX gate: a batch call holding the GPU must not stall the sessions -------------------------

VOICE_CONSENT = {
    "consent": True,
    "consent_statement": "Synthetic test voice; no real person is cloned.",
    "consent_speaker": "Test voice",
}


class GatedCloning(FakeCloningTts):
    """Like the Qwen3 MLX engine: every chunk is computed under the MLX gate."""

    def synthesize_cloned(self, text, reference, *, speed=1.0, language=None):
        yield from stepwise(super().synthesize_cloned(text, reference, speed=speed, language=language))


class BatchOnGate:
    """Holds the MLX gate from another thread, as a long transcription or a voice design does."""

    def __init__(self):
        self.release = threading.Event()
        entered = threading.Event()

        def run():
            with MLX_GATE:
                entered.set()
                self.release.wait(10)

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        assert entered.wait(5)

    def stop(self):
        self.release.set()
        self.thread.join(5)


@pytest.fixture
def cloned_app(build, tmp_path):
    store = VoiceStore(tmp_path / "voices")
    voice = store.create(
        audio=good_wav(), name="Clone", transcript="Hello there.", languages="en", **VOICE_CONSENT
    )
    app = build(Settings(max_sessions=2), cloning=GatedCloning(), voice_store=store)
    return app, voice.id


def test_a_preset_sentence_does_not_wait_for_a_cloned_sentence_stuck_on_the_gate(cloned_app):
    """The reviewer's case: a batch call holds the GPU, a cloned sentence of one session waits for it, and another
    session's preset (ONNX) sentence still plays at once."""
    app, voice = cloned_app
    batch = BatchOnGate()
    try:
        client = TestClient(app, client=("127.0.0.1", 5000))
        with (
            client,
            client.websocket_connect("/v1/speech/session") as a,
            client.websocket_connect("/v1/speech/session") as b,
        ):
            open_session(a, {"type": "session.update", "voice": voice})
            open_session(b)
            a.send_json({"type": "speak", "id": "c1", "text": "Hello there.", "final": True})
            wait_for(lambda: MLX_GATE.realtime_waiting == 1)  # the cloned sentence is waiting for the GPU
            start = time.monotonic()
            b.send_json({"type": "speak", "id": "p1", "text": "Hello there.", "final": True})
            got = recv_until(b, "audio.done")
            elapsed = time.monotonic() - start
            assert elapsed < 1.0, f"the preset sentence took {elapsed:.2f}s"
            assert got[-1] == {"type": "audio.done", "id": "p1", "cancelled": False}
            assert MLX_GATE.realtime_waiting == 1  # the cloned one is still waiting
            batch.stop()
            got = recv_until(a, "audio.done")
            assert got[-1]["cancelled"] is False and any(isinstance(m, bytes) for m in got)
    finally:
        batch.stop()


async def test_a_closing_session_frees_its_slot_while_its_sentence_waits_for_the_gate(cloned_app, live):
    """Over a real socket: the client leaves while its cloned sentence waits for a batch call's GPU time. The session
    gives up its place in the queue and frees its slot at once, without waiting for the batch call to finish."""
    app, voice = cloned_app
    url = live(app)
    batch = BatchOnGate()
    try:
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "session.update", "voice": voice}))
            assert json.loads(await ws.recv())["type"] == "ready"
            await ws.send(json.dumps({"type": "speak", "id": "c1", "text": "Hello there.", "final": True}))
            wait_for(lambda: MLX_GATE.realtime_waiting == 1)
            assert app.state.slots.sessions == 1
        start = time.monotonic()
        wait_for(lambda: app.state.slots.sessions == 0, timeout=2.0)
        assert time.monotonic() - start < 1.0
        assert (
            MLX_GATE.held and MLX_GATE.realtime_waiting == 0
        )  # gave up its place; the batch call carries on
        assert not app.state.slots.cloning_lock.locked()
    finally:
        batch.stop()


def test_cancelling_a_cloned_reply_that_waits_for_the_gate_ends_it_without_an_error(cloned_app):
    app, voice = cloned_app
    batch = BatchOnGate()
    try:
        client, cm = connect(app)
        with client, cm as ws:
            open_session(ws, {"type": "session.update", "voice": voice})
            ws.send_json({"type": "speak", "id": "c1", "text": "Hello there.", "final": True})
            wait_for(lambda: MLX_GATE.realtime_waiting == 1)
            start = time.monotonic()
            ws.send_json({"type": "cancel", "id": "c1"})
            got = recv_until(ws, "audio.done")
            assert time.monotonic() - start < 1.0  # not when the batch call lets go of the GPU
            assert got == [{"type": "audio.done", "id": "c1", "cancelled": True}]
            assert MLX_GATE.realtime_waiting == 0 and MLX_GATE.held
    finally:
        batch.stop()


class InterleavingStt(FakeStt):
    """An STT engine that, like MLX Whisper, may be called again while a call is running."""

    interleaves = True

    def __init__(self):
        self.batch_started = threading.Event()
        self.batch_release = threading.Event()
        self.live_calls = 0

    def transcribe(self, audio, rate, **kw):
        if len(audio) > rate * 60:  # the upload
            self.batch_started.set()
            self.batch_release.wait(10)
        else:
            self.live_calls += 1
        return super().transcribe(audio, rate, **kw)


def test_a_long_upload_does_not_make_sessions_skip_their_second_pass(build):
    stt = InterleavingStt()
    app = build(stt=stt, second_pass=True)
    upload = wav_of(np.zeros(16000 * 61, dtype=np.float32), 16000)
    client = TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000))
    result = {}
    with client:
        uploader = threading.Thread(
            target=lambda: result.setdefault(
                "r", client.post("/v1/audio/transcriptions", files={"file": ("a.wav", upload, "audio/wav")})
            )
        )
        uploader.start()
        assert stt.batch_started.wait(5)
        with client.websocket_connect("/v1/speech/session") as ws:
            open_session(ws)
            say(ws)
            msgs = recv_until(ws, "transcript.final")
        stt.batch_release.set()
        uploader.join(5)
    assert stt.live_calls == 1 and msgs[-1]["text"].startswith("heard ") and "s" in msgs[-1]["text"]
    assert result["r"].status_code == 200


async def test_closing_a_session_whose_second_pass_waits_for_the_gate_logs_no_error(build, live, caplog):
    """The abandoned second pass raises `Abandoned` in its thread; that must be retrieved, not reported by asyncio as
    "Task exception was never retrieved"."""
    import gc
    import logging

    class GatedStt(FakeStt):
        def transcribe(self, audio, rate, **kw):
            with MLX_GATE:
                return super().transcribe(audio, rate, **kw)

    app = build(stt=GatedStt(), second_pass=True)
    url = live(app)
    batch = BatchOnGate()
    caplog.set_level(logging.ERROR)
    try:
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "session.update"}))
            assert json.loads(await ws.recv())["type"] == "ready"
            for _ in range(10):
                await ws.send(LOUD)
            for _ in range(12):
                await ws.send(QUIET)
            wait_for(lambda: MLX_GATE.realtime_waiting == 1)  # the turn's second pass waits for the GPU
        try:
            wait_for(lambda: app.state.slots.sessions == 0 and MLX_GATE.realtime_waiting == 0)
        except AssertionError:
            raise AssertionError(
                (app.state.slots.sessions, MLX_GATE.realtime_waiting, MLX_GATE.batch_waiting)
            ) from None
        await asyncio.sleep(0.1)
        gc.collect()
        await asyncio.sleep(0.1)
    finally:
        batch.stop()
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert not errors, [r.getMessage() for r in errors]
