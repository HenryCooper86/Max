import sys
from dataclasses import replace as _replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.threat import CLOSING_RATE_MIN, evaluate, in_corridor
from adas.tuning import DEFAULT
from perception.types import BoxSample, EgoState, Track

MOVING = EgoState(moving=True, speed_scale=1.0)
STOPPED = EgoState(moving=False, speed_scale=0.0)


def closing_track(cls="car", start_h=0.10, growth=0.01, n=8, cx=0.5, t0=0, step=100):
    """A track whose box grows steadily — i.e. something getting closer."""
    samples = []
    for i in range(n):
        h = start_h + growth * i
        samples.append(
            BoxSample(
                t_ms=t0 + i * step, x1=cx - 0.1, y1=0.5 - h / 2, x2=cx + 0.1, y2=0.5 + h / 2
            )
        )
    return Track(track_id=1, cls=cls, samples=samples)


def steady_track(cls="car", h=0.50, n=45, cx=0.5, step=100):
    samples = [
        BoxSample(t_ms=i * step, x1=cx - 0.1, y1=0.5 - h / 2, x2=cx + 0.1, y2=0.5 + h / 2)
        for i in range(n)
    ]
    return Track(track_id=2, cls=cls, samples=samples)


def ids(candidates):
    return sorted(c.threat_id for c in candidates)


def test_a_fast_closing_car_ahead_is_a_forward_collision():
    track = closing_track(growth=0.03)
    assert "forward_collision" in ids(evaluate([track], MOVING, t_ms=700, camera="front"))


def test_a_closing_pedestrian_ahead_is_its_own_threat():
    track = closing_track(cls="person", growth=0.02)
    assert "pedestrian_ahead" in ids(evaluate([track], MOVING, t_ms=700, camera="front"))


def test_nothing_fires_while_the_bike_is_stopped():
    """The single highest-value gate.

    A car pulling up behind you at a light is visually identical to a rear
    approach; only ego motion separates them.
    """
    track = closing_track(growth=0.03)
    assert evaluate([track], STOPPED, t_ms=700, camera="front") == []


def test_a_car_outside_the_corridor_does_not_fire():
    # Lane-splitting in China puts adjacent traffic routinely close.
    track = closing_track(growth=0.03, cx=0.05)
    assert evaluate([track], MOVING, t_ms=700, camera="front") == []


def test_in_corridor_is_measured_at_the_centre_of_the_box():
    assert in_corridor(closing_track(cx=0.5))
    assert in_corridor(closing_track(cx=0.74))
    assert not in_corridor(closing_track(cx=0.76))


def test_a_receding_car_never_fires():
    track = closing_track(start_h=0.4, growth=-0.02)
    assert evaluate([track], MOVING, t_ms=700, camera="front") == []


def test_the_rear_camera_produces_rear_threats_not_front_ones():
    track = closing_track(growth=0.03)
    result = ids(evaluate([track], MOVING, t_ms=700, camera="rear"))
    assert "rear_approach" in result
    assert "forward_collision" not in result


def test_a_close_but_not_closing_vehicle_behind_is_tailgating():
    """Distance alone must not fire the critical alert.

    Every normally-following car would trigger it, which is exactly how a rider
    learns to ignore the system.
    """
    result = ids(evaluate([steady_track()], MOVING, t_ms=4_400, camera="rear"))
    assert result == ["tailgating"]


def test_tailgating_needs_the_full_dwell():
    short = steady_track(n=20)  # 2 s, under the 4 s dwell
    assert evaluate([short], MOVING, t_ms=1_900, camera="rear") == []


def test_a_small_steady_box_behind_is_not_tailgating():
    assert evaluate([steady_track(h=0.2)], MOVING, t_ms=4_400, camera="rear") == []


def test_closing_rate_separates_rear_approach_from_tailgating():
    """The same big box behind you is two different threats.

    Both tracks below end up filling well over TAILGATE_HEIGHT_FRAC. What
    separates them is whether the box is growing: one car is closing, the other
    is just following. Using distance alone would fire the critical alert at
    every normally-following vehicle, which is how a rider learns to ignore the
    system.
    """
    # Closing fast enough that contact is under the 3 s rear threshold.
    approaching = closing_track(start_h=0.25, growth=0.03, n=10)
    approaching_ids = ids(evaluate([approaching], MOVING, t_ms=900, camera="rear"))
    assert approaching_ids == ["rear_approach"]

    # Same size, holding station.
    following_ids = ids(evaluate([steady_track(h=0.52)], MOVING, t_ms=4_400, camera="rear"))
    assert following_ids == ["tailgating"]


def test_a_slowly_closing_vehicle_behind_is_still_only_tailgating():
    """Below CLOSING_RATE_MIN, creeping closer is not an approach.

    Traffic breathes; a car gaining a few centimetres a second is normal
    following, and the critical alert must stay for something actually
    arriving.
    """
    crawl = 0.005  # 0.05 per second, well under CLOSING_RATE_MIN
    samples = steady_track(h=0.50, n=45).samples
    creeping = Track(
        track_id=3,
        cls="car",
        samples=[
            BoxSample(
                t_ms=s.t_ms,
                x1=s.x1,
                y1=0.5 - (0.50 + crawl * i) / 2,
                x2=s.x2,
                y2=0.5 + (0.50 + crawl * i) / 2,
            )
            for i, s in enumerate(samples[:10])
        ],
    )
    assert "rear_approach" not in ids(evaluate([creeping], MOVING, t_ms=900, camera="rear"))


def test_severity_is_critical_for_collisions_and_caution_for_tailgating():
    forward = evaluate([closing_track(growth=0.03)], MOVING, t_ms=700, camera="front")
    assert forward[0].severity == "critical"
    tail = evaluate([steady_track()], MOVING, t_ms=4_400, camera="rear")
    assert tail[0].severity == "caution"


def test_a_candidate_carries_its_track_and_measured_ttc():
    result = evaluate([closing_track(growth=0.03)], MOVING, t_ms=700, camera="front")
    assert result[0].track_id == 1
    assert result[0].ttc_s is not None and result[0].ttc_s > 0


def test_tailgating_dwell_still_fires_inside_the_window():
    """A window of 6 s comfortably exceeds the 4 s tailgate dwell.

    Build the track the way the tailgating test above does, but cap its
    sample history to the last 6 s (the same cutoff Tracker.update applies)
    before calling evaluate. The 4.5 s of dwell-worthy samples all fall
    inside that window, so trimming to it must never starve the dwell rule.
    """
    track = steady_track(n=46)  # 4.5 s of samples, all at tailgate height
    cutoff = track.last.t_ms - DEFAULT.track_window_ms
    track.samples[:] = [s for s in track.samples if s.t_ms >= cutoff]
    candidates = evaluate([track], MOVING, t_ms=track.last.t_ms, camera="rear")
    assert any(c.threat_id == "tailgating" for c in candidates)


def test_evaluate_accepts_an_injected_tuning():
    # Off-centre but still within the default corridor (half-width 0.25); a
    # narrower corridor excludes it. Same tracks, zero candidates once the
    # tuning shrinks the corridor out from under it.
    track = closing_track(growth=0.03, cx=0.6)
    assert evaluate([track], MOVING, t_ms=700, camera="front") != []
    narrow = _replace(DEFAULT, corridor_width_frac=0.1)
    assert evaluate([track], MOVING, t_ms=700, camera="front", tuning=narrow) == []
