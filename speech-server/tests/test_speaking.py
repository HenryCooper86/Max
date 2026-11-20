import asyncio
import threading
import time

import numpy as np
import pytest

from max_speech.audio import OUTPUT_RATE
from max_speech.engines.base import UnknownVoiceError
from max_speech.engines.fake import FakeTts
from max_speech.session.speaking import ReplySpeaker


class Recorder:
    def __init__(self):
        self.items = []

    def __call__(self, item):
        self.items.append(item)

    def types(self):
        return [i["type"] if isinstance(i, dict) else "audio" for i in self.items]

    def dicts(self, type_=None):
        return [i for i in self.items if isinstance(i, dict) and (type_ is None or i["type"] == type_)]

    def done(self, rid):
        return [d for d in self.dicts("audio.done") if d["id"] == rid]


class Gated(FakeTts):
    """Each sentence is one chunk, recorded; `gate` (if set) must be released before each chunk is produced."""

    def __init__(self, delay=0.0, rate=24000):
        self.delay = delay
        self.sample_rate = rate
        self.texts = []
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()
        self.gate: threading.Event | None = None

    def synthesize(self, text, voice, *, speed=1.0, language=None):
        if voice not in {v.id for v in self._VOICES}:
            raise UnknownVoiceError(voice)
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            self.texts.append(text)
            if self.gate is not None:
                self.gate.wait(5)
            time.sleep(self.delay)
            yield np.full(100, 0.1, dtype=np.float32)
        finally:
            with self._lock:
                self.active -= 1


async def settle(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < end, "timed out"
        await asyncio.sleep(0.005)


def make(tts=None, **kw):
    rec = Recorder()
    tts = tts or Gated()
    return ReplySpeaker(tts, asyncio.Lock(), rec, voice="alpha", **kw), rec, tts


async def test_one_reply_start_audio_done():
    sp, rec, _ = make()
    sp.speak("r1", "Hello there. How are you?", True)
    await settle(lambda: rec.done("r1"))
    assert rec.types() == ["audio.start", "audio", "audio", "audio.done"]
    assert rec.items[0] == {"type": "audio.start", "id": "r1", "sampleRate": OUTPUT_RATE}
    assert rec.items[-1] == {"type": "audio.done", "id": "r1", "cancelled": False}
    assert len(rec.items[1]) == 200  # 100 samples at 24 kHz stay 100 int16 samples
    await sp.close()


async def test_output_is_resampled_to_24k_pcm16():
    sp, rec, _ = make(Gated(rate=12000))
    sp.speak("r1", "Hi there.", True)
    await settle(lambda: rec.done("r1"))
    assert isinstance(rec.items[1], bytes) and len(rec.items[1]) == 200 * 2
    await sp.close()


async def test_a_reply_with_only_final_gets_just_audio_done():
    sp, rec, tts = make()
    sp.speak("r1", "", True)
    await settle(lambda: rec.done("r1"))
    assert rec.items == [{"type": "audio.done", "id": "r1", "cancelled": False}]
    assert tts.texts == []
    await sp.close()


async def test_streaming_deltas_synthesize_sentences_as_they_complete():
    sp, rec, tts = make()
    sp.speak("r1", "First sentence. Second sen", False)
    await settle(lambda: tts.texts == ["First sentence."])
    assert not rec.done("r1")
    sp.speak("r1", "tence here.", False)
    sp.speak("r1", "", True)
    await settle(lambda: rec.done("r1"))
    assert tts.texts == ["First sentence.", "Second sentence here."]
    await sp.close()


async def test_the_first_chunk_is_cut_early():
    sp, rec, tts = make()
    sp.speak("r1", "Well, I think that this is a rather long sentence without end", False)
    await settle(lambda: tts.texts)
    assert tts.texts[0] == "Well, I think that this is"  # cut at six words, not at the sentence end
    sp.speak("r1", "", True)
    await settle(lambda: rec.done("r1"))
    await sp.close()


async def test_replies_play_in_the_order_ids_first_appear():
    sp, rec, _tts = make(Gated(delay=0.02))
    sp.speak("a", "Alpha one.", False)
    sp.speak("b", "Bravo one.", True)
    sp.speak("a", " Alpha two.", True)
    await settle(lambda: rec.done("a") and rec.done("b"))
    order = [(i["type"], i["id"]) for i in rec.dicts()]
    assert order == [
        ("audio.start", "a"),
        ("audio.done", "a"),
        ("audio.start", "b"),
        ("audio.done", "b"),
    ]
    # b's audio never lands between a's start and done
    assert rec.types().count("audio") == 3
    await sp.close()


async def test_synthesis_runs_one_chunk_at_a_time_under_the_lock():
    tts = Gated(delay=0.02)
    sp, rec, _ = make(tts)
    sp.speak("a", "One. Two. Three. Four.", True)
    sp.speak("b", "Five. Six.", True)
    await settle(lambda: rec.done("a") and rec.done("b"))
    assert tts.max_active == 1
    await sp.close()


async def test_cancel_mid_reply():
    tts = Gated()
    tts.gate = threading.Event()
    sp, rec, _ = make(tts)
    sp.speak("r1", "One. Two. Three. Four.", True)
    await settle(lambda: tts.active == 1)  # first sentence in the worker thread
    sp.cancel("r1")
    tts.gate.set()
    await settle(lambda: rec.done("r1"))
    await asyncio.sleep(0.05)
    assert rec.done("r1") == [{"type": "audio.done", "id": "r1", "cancelled": True}]
    assert "audio" not in rec.types()  # audio produced after the cancel is dropped
    assert tts.texts == ["One."]  # stopped between chunks: the rest was never synthesized
    assert sp.lock.locked() is False
    await sp.close()


async def test_cancel_drops_later_text_for_that_reply():
    tts = Gated()
    tts.gate = threading.Event()
    sp, rec, _ = make(tts)
    sp.speak("r1", "One. Two.", False)
    await settle(lambda: tts.active == 1)
    sp.cancel("r1")
    sp.speak("r1", " Three.", True)  # a delta that was already in flight
    tts.gate.set()
    await settle(lambda: rec.done("r1"))
    await asyncio.sleep(0.05)
    assert len(rec.done("r1")) == 1 and not rec.dicts("error")
    assert tts.texts == ["One."]
    await sp.close()


async def test_cancel_of_a_queued_reply_emits_done_without_audio_and_skips_it():
    tts = Gated()
    tts.gate = threading.Event()
    sp, rec, _ = make(tts)
    sp.speak("a", "Alpha. Next", False)  # never final: keeps `a` active
    sp.speak("b", "Bravo.", True)
    await settle(lambda: tts.active == 1)
    sp.cancel("b")
    assert rec.done("b") == [{"type": "audio.done", "id": "b", "cancelled": True}]
    tts.gate.set()
    sp.speak("a", "", True)
    await settle(lambda: rec.done("a"))
    await asyncio.sleep(0.05)
    assert tts.texts == ["Alpha.", "Next"]
    assert [d["id"] for d in rec.dicts("audio.done")] == ["b", "a"]
    assert len(rec.done("b")) == 1
    await sp.close()


async def test_cancel_unknown_or_finished_is_a_noop_and_done_is_never_repeated():
    sp, rec, _ = make()
    sp.cancel("nope")
    sp.speak("r1", "Hi there.", True)
    await settle(lambda: rec.done("r1"))
    sp.cancel("r1")
    sp.cancel("r1")
    await asyncio.sleep(0.02)
    assert len(rec.done("r1")) == 1 and rec.done("r1")[0]["cancelled"] is False
    await sp.close()


async def test_speaking_into_a_finished_reply_is_an_error():
    sp, rec, _ = make()
    sp.speak("r1", "Hi.", True)
    await settle(lambda: rec.done("r1"))
    sp.speak("r1", "more", False)
    assert rec.dicts("error")[0]["code"] == "bad_speak"
    await sp.close()


async def test_text_after_final_is_an_error():
    sp, rec, _tts = make()
    sp.speak("r1", "Hi.", True)
    sp.speak("r1", "more", False)
    assert rec.dicts("error")[0]["code"] == "bad_speak"
    await settle(lambda: rec.done("r1"))
    assert len(rec.done("r1")) == 1
    await sp.close()


async def test_unknown_voice_is_an_error_and_the_reply_still_ends_once():
    sp, rec, _ = make()
    sp.voice = "nobody"
    sp.speak("r1", "Hi there. And more.", True)
    await settle(lambda: rec.done("r1"))
    assert rec.dicts("error")[0]["code"] == "unknown_voice"
    assert len(rec.done("r1")) == 1
    sp.voice = "alpha"
    sp.speak("r2", "Fine now.", True)
    await settle(lambda: rec.done("r2"))
    assert "audio" in rec.types()
    await sp.close()


async def test_engine_failure_reports_and_continues_with_the_next_reply():
    class Boom(Gated):
        def synthesize(self, text, voice, **kw):
            if "boom" in text:
                raise RuntimeError("engine exploded")
            yield from super().synthesize(text, voice, **kw)

    sp, rec, _ = make(Boom())
    sp.speak("a", "boom.", True)
    sp.speak("b", "Fine.", True)
    await settle(lambda: rec.done("a") and rec.done("b"))
    assert rec.dicts("error")[0]["code"] == "tts_failed"
    assert rec.done("a")[0]["cancelled"] is False
    assert any(isinstance(i, bytes) for i in rec.items)
    await sp.close()


async def test_close_stops_work_sends_nothing_and_frees_the_lock():
    tts = Gated()
    tts.gate = threading.Event()
    sp, rec, _ = make(tts)
    sp.speak("a", "One. Two. Three.", False)
    sp.speak("b", "Other.", True)
    await settle(lambda: tts.active == 1)
    closing = asyncio.create_task(sp.close())
    await asyncio.sleep(0.05)
    assert not closing.done()  # waits for the thread that is inside the engine
    tts.gate.set()
    await asyncio.wait_for(closing, 3)
    assert sp.lock.locked() is False
    assert tts.active == 0
    assert tts.texts == ["One."]
    assert rec.dicts("audio.done") == []
    await asyncio.sleep(0.05)
    assert tts.texts == ["One."]


async def test_close_with_nothing_running():
    sp, _, _ = make()
    await sp.close()


@pytest.mark.parametrize("n", [5])
async def test_exactly_one_done_per_id_under_mixed_cancels(n):
    sp, rec, _ = make(Gated(delay=0.005))
    ids = [f"r{i}" for i in range(n)]
    for i, rid in enumerate(ids):
        sp.speak(rid, "Sentence one. Sentence two.", i % 2 == 0)
    sp.cancel("r1")
    sp.cancel("r3")
    sp.speak("r1", "", True)
    sp.speak("r3", "", True)
    sp.speak("r4", "", True)
    await settle(lambda: all(rec.done(r) for r in ids))
    await asyncio.sleep(0.05)
    for rid in ids:
        assert len(rec.done(rid)) == 1, rid
    assert rec.done("r1")[0]["cancelled"] and rec.done("r3")[0]["cancelled"]
    await sp.close()
