import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.tracker import Tracker
from perception.types import Detection


def box(x1, y1, x2, y2, cls="car", score=0.9):
    return Detection(cls=cls, score=score, x1=x1, y1=y1, x2=x2, y2=y2)


def test_a_new_detection_starts_a_track():
    tracker = Tracker()
    tracks = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)
    assert len(tracks) == 1
    assert tracks[0].frames == 1


def test_an_overlapping_detection_keeps_the_same_id():
    tracker = Tracker()
    first = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)[0].track_id
    tracks = tracker.update([box(0.41, 0.41, 0.51, 0.51)], t_ms=100)
    assert tracks[0].track_id == first
    assert tracks[0].frames == 2


def test_a_distant_detection_starts_a_second_track():
    tracker = Tracker()
    tracker.update([box(0.1, 0.1, 0.2, 0.2)], t_ms=0)
    tracks = tracker.update([box(0.1, 0.1, 0.2, 0.2), box(0.7, 0.7, 0.8, 0.8)], t_ms=100)
    assert len({t.track_id for t in tracks}) == 2


def test_a_track_survives_a_brief_miss():
    tracker = Tracker(max_misses=3)
    first = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)[0].track_id
    tracker.update([], t_ms=100)
    tracks = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=200)
    assert tracks[0].track_id == first


def test_a_track_dies_after_too_many_misses():
    tracker = Tracker(max_misses=2)
    tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)
    tracker.update([], t_ms=100)
    tracker.update([], t_ms=200)
    tracker.update([], t_ms=300)
    assert tracker.update([], t_ms=400) == []


def test_a_long_timestamp_gap_ends_the_track():
    """A 500 ms hole means we lost the video, not that the car teleported.

    Carrying the track across it would produce a huge single-step dh/dt and a
    fabricated time-to-contact.
    """
    tracker = Tracker(max_gap_ms=500)
    tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)
    tracks = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=900)
    assert tracks[0].frames == 1  # a fresh track, not a continued one


def test_classes_do_not_swap_identity():
    """A person stepping where a car was must not inherit the car's history.

    That history is what TTC is computed from, so an identity swap would hand
    the pedestrian the car's closing rate.
    """
    tracker = Tracker()
    car_id = tracker.update([box(0.4, 0.4, 0.5, 0.5, cls="car")], t_ms=0)[0].track_id
    tracks = tracker.update([box(0.4, 0.4, 0.5, 0.5, cls="person")], t_ms=100)
    assert [t.cls for t in tracks] == ["person"]
    assert tracks[0].track_id != car_id
    assert tracks[0].frames == 1  # fresh history, not the car's


def test_only_currently_visible_tracks_are_returned():
    """A track that missed this frame stays alive but is not handed downstream.

    It survives so a detection next frame can rejoin it with its history — that
    is what max_misses is for — but reporting it would invite the threat engine
    to extrapolate a time-to-contact for something nobody can see.
    """
    tracker = Tracker(max_misses=3)
    first = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=0)[0].track_id
    assert tracker.update([], t_ms=100) == []
    rejoined = tracker.update([box(0.4, 0.4, 0.5, 0.5)], t_ms=200)
    assert rejoined[0].track_id == first
    assert rejoined[0].frames == 2  # history preserved across the miss
