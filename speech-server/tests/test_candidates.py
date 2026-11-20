import numpy as np

from max_speech.voices.candidates import CandidateCache


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def add(cache, n=0):
    return cache.add(
        audio=np.zeros(10, dtype=np.float32),
        rate=24000,
        text=f"t{n}",
        description="d",
        language="en",
        seed=n,
        model="m",
    )


def test_ids_have_the_contract_shape():
    cache = CandidateCache(clock=Clock())
    assert cache.get(add(cache).id) is not None
    import re

    assert re.fullmatch(r"c_[0-9a-f]{12}", add(cache).id)


def test_candidates_expire_after_the_ttl():
    clock = Clock()
    cache = CandidateCache(ttl=900, clock=clock)
    c = add(cache)
    clock.now = 899
    assert cache.get(c.id) is c
    clock.now = 900
    assert cache.get(c.id) is None and len(cache) == 0


def test_the_oldest_is_evicted_beyond_the_limit():
    cache = CandidateCache(limit=30, clock=Clock())
    items = [add(cache, i) for i in range(31)]
    assert len(cache) == 30
    assert cache.get(items[0].id) is None and cache.get(items[1].id) is items[1]


def test_malformed_ids_are_unknown():
    cache = CandidateCache(clock=Clock())
    c = add(cache)
    assert cache.get(c.id.upper()) is None and cache.get("../x") is None and cache.get(c.id + "0") is None


def test_take_consumes_and_restore_puts_back_with_the_original_expiry():
    clock = [0.0]
    cache = CandidateCache(ttl=100, clock=lambda: clock[0])
    item = cache.add(
        audio=np.zeros(4, dtype=np.float32),
        rate=24000,
        text="t",
        description="d",
        language="en",
        seed=1,
        model="m",
    )
    assert cache.take("nope") is None
    got = cache.take(item.id)
    assert got is item and cache.get(item.id) is None and cache.take(item.id) is None
    cache.restore(got)
    assert cache.get(item.id) is item
    clock[0] = 101
    assert cache.get(item.id) is None
