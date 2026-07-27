import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json

from events import EventBus


def collector():
    lines = []
    return lines.append, lines


def test_broadcast_with_no_clients_delivers_to_nobody():
    assert EventBus().broadcast({"event": "hazard"}) == 0


def test_broadcast_reaches_every_registered_client():
    bus = EventBus()
    first_write, first = collector()
    second_write, second = collector()
    bus.register(first_write)
    bus.register(second_write)

    assert bus.broadcast({"event": "hazard", "severity": "warn"}) == 2
    assert json.loads(first[0]) == {"event": "hazard", "severity": "warn"}
    assert first == second


def test_each_broadcast_is_one_newline_terminated_line():
    # The agent frames on newlines; a line without one merges into the next.
    bus = EventBus()
    write, lines = collector()
    bus.register(write)
    bus.broadcast({"event": "hazard"})
    assert lines[0].endswith("\n")
    assert lines[0].count("\n") == 1


def test_an_unregistered_client_stops_receiving():
    bus = EventBus()
    write, lines = collector()
    bus.register(write)
    bus.unregister(write)
    assert bus.broadcast({"event": "hazard"}) == 0
    assert lines == []


def test_a_client_that_raises_is_dropped_and_the_others_still_get_it():
    # A rider's socket dying must not cost the others their alert.
    bus = EventBus()

    def dead(_line):
        raise BrokenPipeError

    good_write, good = collector()
    bus.register(dead)
    bus.register(good_write)

    assert bus.broadcast({"event": "hazard"}) == 1
    assert len(good) == 1
    # The dead client is gone, not retried forever.
    assert bus.broadcast({"event": "hazard"}) == 1


def test_unregistering_an_unknown_client_is_not_an_error():
    EventBus().unregister(lambda _line: None)
