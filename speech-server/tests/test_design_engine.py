"""Qwen3MlxDesign with a fake model: lazy loading, language codes, seeding and the idle unload."""

import threading
from types import SimpleNamespace

import numpy as np
import pytest

from max_speech.engines.qwen3_design_mlx import Qwen3MlxDesign


class FakeModel:
    def __init__(self):
        self.calls: list[dict] = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        yield SimpleNamespace(audio=np.full(1200, 0.1, dtype=np.float32))
        yield SimpleNamespace(audio=np.full(1200, 0.2, dtype=np.float32))


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make(**kw):
    log = SimpleNamespace(loads=[], seeds=[], releases=0, model=FakeModel())

    def loader(path):
        log.loads.append(path)
        return log.model

    def release():
        log.releases += 1

    clock = Clock()
    engine = Qwen3MlxDesign(
        "/models/qd",
        "qwen3-tts-1.7b-voicedesign-mlx",
        clock=clock,
        loader=loader,
        seeder=log.seeds.append,
        release=release,
        sweeper=False,
        **kw,
    )
    return engine, log, clock


def test_nothing_loads_until_the_first_call():
    engine, log, _ = make()
    assert not engine.loaded and log.loads == []
    engine.design("a calm voice", "Hello.", "en", 7)
    assert engine.loaded and len(log.loads) == 1


def test_design_passes_description_language_and_seed_and_joins_chunks():
    engine, log, _ = make()
    audio = engine.design("a calm voice", "Hello.", "en", 7)
    # Streamed, so live speech can take the GPU between chunks (see STREAMING_INTERVAL).
    assert log.model.calls == [
        {
            "text": "Hello.",
            "instruct": "a calm voice",
            "lang_code": "english",
            "stream": True,
            "streaming_interval": 0.5,
        }
    ]
    assert log.seeds == [7]
    assert audio.dtype == np.float32 and audio.shape == (2400,)
    engine.design("低沉的男声", "你好。", "zh-CN", 8)
    assert log.model.calls[-1]["lang_code"] == "chinese" and log.seeds == [7, 8]
    assert len(log.loads) == 1  # loaded once


@pytest.mark.parametrize(("language", "description"), [("fr", "calm"), ("en", "  ")])
def test_bad_input_is_refused_before_loading(language, description):
    engine, log, _ = make()
    with pytest.raises(ValueError):
        engine.design(description, "Hi.", language, 1)
    assert log.loads == []


def test_unloads_after_ten_idle_minutes_and_reloads_on_demand():
    engine, log, clock = make()
    engine.design("calm", "Hi.", "en", 1)
    clock.now += 599
    assert engine.sweep() is False and engine.loaded
    clock.now += 2
    assert engine.sweep() is True and not engine.loaded and log.releases == 1
    assert engine.sweep() is False  # nothing left to unload
    engine.design("calm", "Hi.", "en", 1)
    assert len(log.loads) == 2


def test_use_resets_the_idle_clock():
    engine, _, clock = make()
    engine.design("calm", "Hi.", "en", 1)
    clock.now += 500
    engine.design("calm", "Hi.", "en", 2)
    clock.now += 500
    assert engine.sweep() is False and engine.loaded


def test_concurrent_first_calls_load_once():
    engine, log, _ = make()
    threads = [threading.Thread(target=engine.design, args=("calm", "Hi.", "en", i)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(log.loads) == 1 and len(log.seeds) == 6


def test_background_sweeper_unloads_when_idle():
    log = SimpleNamespace(released=threading.Event())
    clock = Clock()
    engine = Qwen3MlxDesign(
        "/m",
        "m",
        idle_seconds=10,
        sweep_seconds=0.01,
        clock=clock,
        loader=lambda p: FakeModel(),
        seeder=lambda s: None,
        release=log.released.set,
    )
    engine.design("calm", "Hi.", "en", 1)
    clock.now += 11
    assert log.released.wait(2)
    assert not engine.loaded
    engine.close()


def test_a_model_that_makes_no_audio_is_an_error():
    engine, log, _ = make()
    log.model.generate = lambda **kw: iter(())
    with pytest.raises(RuntimeError, match="no audio"):
        engine.design("calm", "Hi.", "en", 1)


def test_ensure_loaded_loads_once_and_design_reuses_it():
    engine, log, _ = make()
    engine.ensure_loaded()
    engine.ensure_loaded()
    assert engine.loaded and len(log.loads) == 1
    engine.design("calm", "Hi.", "en", 1)
    assert len(log.loads) == 1


def test_ensure_loaded_counts_as_use_for_the_idle_clock():
    engine, _, clock = make()
    engine.ensure_loaded()
    clock.now += 500
    assert engine.sweep() is False
    clock.now += 200
    assert engine.sweep() is True


def test_unloading_drops_the_model_and_frees_memory_inside_one_hold_of_the_mlx_gate():
    """Freeing MLX buffers (dropping the model, collecting, clearing the cache) is MLX work: it must not overlap
    another thread's evaluation, so all of it happens with the gate held, in one hold."""
    from max_speech.engines.mlx_gate import MLX_GATE

    seen = []
    engine, _log, clock = make()
    engine.design("a calm voice", "Hello.", "en", 7)

    def release():
        seen.append((MLX_GATE.held, engine._model is None))

    engine._release = release
    clock.now += engine.idle_seconds + 1
    assert engine.sweep() is True
    engine.design("a calm voice", "Hello.", "en", 7)
    engine.close()
    assert seen == [(True, True), (True, True)]  # the model was dropped inside the same hold
