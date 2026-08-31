import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.tracker import Tracker, _iou
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


def test_samples_are_bounded_by_the_window():
    tracker = Tracker(window_ms=6_000)
    for i in range(200):  # 20 s of frames at 10 fps
        tracker.update([box(0.4, 0.4, 0.6, 0.6)], t_ms=i * 100)
    (track,) = tracker.update([box(0.4, 0.4, 0.6, 0.6)], t_ms=20_000)
    assert all(20_000 - s.t_ms <= 6_000 for s in track.samples)
    assert len(track.samples) <= 62  # 6 s at 10 fps, plus the two boundary frames


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


def test_global_matching_beats_track_order_stealing():
    """Per-track greedy let an early track steal a later track's better match.

    Track 1 is processed first. det_x scores higher against track 1 (0.36)
    than det_y does (0.333), so old per-track greedy hands det_x to track 1 —
    even though det_x is really track 2's stronger match (0.417) and det_y is
    track 1's only real candidate. Track 2 then ages out unmatched and det_y
    spawns a spurious third track: an identity swap that fabricates the
    dh/dt spike max_gap_ms exists to prevent, arriving by a different route.
    Global IoU ordering assigns det_x to track 2 and det_y to track 1
    instead.
    """
    tracker = Tracker()
    (t1,) = tracker.update([box(0.10, 0.4, 0.30, 0.6)], t_ms=0)
    tracks = tracker.update(
        [box(0.10, 0.4, 0.30, 0.6), box(0.40, 0.4, 0.60, 0.6)], t_ms=100
    )
    assert len(tracks) == 2
    t2 = next(t for t in tracks if t.track_id != t1.track_id)

    # det_x straddles the gap between the two tracks, weighted toward track
    # 2; det_y sits only against track 1's inner edge.
    det_x = box(0.12, 0.4, 0.60, 0.6)
    det_y = box(0.20, 0.4, 0.40, 0.6)

    iou_t1_x = _iou(t1.last, det_x)
    iou_t2_x = _iou(t2.last, det_x)
    iou_t1_y = _iou(t1.last, det_y)
    iou_t2_y = _iou(t2.last, det_y)
    assert iou_t2_x > iou_t1_x > tracker.iou_threshold
    assert iou_t1_y > tracker.iou_threshold > iou_t2_y

    result = tracker.update([det_x, det_y], t_ms=200)
    by_id = {t.track_id: t for t in result}
    assert len(result) == 2  # no spurious third track
    assert by_id[t2.track_id].last.x1 == det_x.x1  # X went to its best owner
    assert by_id[t2.track_id].last.x2 == det_x.x2
    assert by_id[t1.track_id].last.x1 == det_y.x1
    assert by_id[t1.track_id].last.x2 == det_y.x2


def test_detection_order_cannot_change_the_assignment():
    def run(order):
        tracker = Tracker()
        tracker.update(
            [box(0.10, 0.4, 0.30, 0.6), box(0.50, 0.4, 0.70, 0.6)], t_ms=0
        )
        tracks = tracker.update(order, t_ms=100)
        return sorted((t.track_id, round(t.last.x1, 3)) for t in tracks)

    a = box(0.12, 0.4, 0.32, 0.6)
    b = box(0.52, 0.4, 0.72, 0.6)
    assert run([a, b]) == run([b, a])
