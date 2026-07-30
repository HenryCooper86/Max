import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.suppress import Suppressor
from perception.types import Candidate


def cand(threat_id="forward_collision", severity="critical", track_id=1, t_ms=0, ttc=1.5):
    return Candidate(
        threat_id=threat_id,
        severity=severity,
        camera="front",
        track_id=track_id,
        t_ms=t_ms,
        ttc_s=ttc,
    )


def mature(track_id=1, frames=10):
    return {track_id: frames}


def admit_until_fired(s, threat_id="forward_collision", severity="critical", start=0, track_id=1):
    """Push frames until the suppressor emits, returning the time it fired."""
    t = start
    for _ in range(10):
        out = s.admit(
            [cand(threat_id=threat_id, severity=severity, track_id=track_id, t_ms=t)],
            mature(track_id),
            t_ms=t,
        )
        if out:
            return t
        t += 100
    raise AssertionError("never fired")


def test_a_mature_stable_candidate_is_admitted():
    s = Suppressor()
    for t in (0, 100):
        s.admit([cand(t_ms=t)], mature(), t_ms=t)
    assert s.admit([cand(t_ms=200)], mature(), t_ms=200) == [cand(t_ms=200)]


def test_an_immature_track_is_held_back():
    """Detector flicker must not reach the rider."""
    s = Suppressor()
    assert s.admit([cand()], {1: 1}, t_ms=0) == []


def test_one_noisy_ttc_sample_does_not_fire():
    s = Suppressor(min_ttc_frames=3)
    assert s.admit([cand(t_ms=0)], mature(), t_ms=0) == []
    assert s.admit([cand(t_ms=100)], mature(), t_ms=100) == []


def test_the_ttc_run_resets_when_the_threat_stops_qualifying():
    s = Suppressor(min_ttc_frames=3, run_grace_frames=0)
    s.admit([cand(t_ms=0)], mature(), t_ms=0)
    s.admit([cand(t_ms=100)], mature(), t_ms=100)
    s.admit([], mature(), t_ms=200)  # the candidate went away
    assert s.admit([cand(t_ms=300)], mature(), t_ms=300) == []


def test_the_same_threat_is_not_repeated_within_its_cooldown():
    s = Suppressor()
    fired = admit_until_fired(s)
    later = fired + 3_000
    assert s.admit([cand(t_ms=later)], mature(), t_ms=later) == []


def test_the_same_threat_may_fire_again_after_the_cooldown():
    s = Suppressor(threat_cooldown_s=8.0)
    fired = admit_until_fired(s)
    t = fired + 9_000
    assert admit_until_fired(s, start=t) >= t


def test_a_second_threat_waits_for_the_global_gap():
    """A rider can act on one thing at a time."""
    s = Suppressor(global_gap_s=4.0)
    fired = admit_until_fired(s)
    t = fired + 1_000
    for _ in range(5):
        assert (
            s.admit([cand(threat_id="pedestrian_ahead", track_id=2, t_ms=t)], mature(2), t_ms=t)
            == []
        )
        t += 100


def test_a_critical_preempts_a_caution_cooldown():
    s = Suppressor()
    admit_until_fired(s, threat_id="tailgating", severity="caution", track_id=5)
    t = 2_000
    out = []
    for _ in range(5):
        out = s.admit(
            [cand(threat_id="forward_collision", severity="critical", track_id=6, t_ms=t)],
            mature(6),
            t_ms=t,
        )
        if out:
            break
        t += 100
    assert out and out[0].threat_id == "forward_collision"


def test_a_caution_never_preempts_a_critical():
    s = Suppressor()
    admit_until_fired(s, threat_id="forward_collision", severity="critical", track_id=6)
    t = 2_000
    for _ in range(5):
        assert (
            s.admit(
                [cand(threat_id="tailgating", severity="caution", track_id=7, t_ms=t)],
                mature(7),
                t_ms=t,
            )
            == []
        )
        t += 100


def test_one_flicker_frame_does_not_rearm_the_run():
    s = Suppressor()  # grace defaults to 1
    # Two qualifying frames, one flicker (absent), then present again: the run
    # resumes at 3 and fires — the flicker cost one frame, not a restart.
    assert s.admit([cand(t_ms=0)], mature(), t_ms=0) == []
    assert s.admit([cand(t_ms=100)], mature(), t_ms=100) == []
    assert s.admit([], mature(), t_ms=200) == []          # flicker
    assert s.admit([cand(t_ms=300)], mature(), t_ms=300) != []


def test_two_absent_frames_still_rearm():
    s = Suppressor()
    assert s.admit([cand(t_ms=0)], mature(), t_ms=0) == []
    assert s.admit([cand(t_ms=100)], mature(), t_ms=100) == []
    assert s.admit([], mature(), t_ms=200) == []
    assert s.admit([], mature(), t_ms=300) == []          # grace exhausted
    # Run restarted: two more frames still are not enough...
    assert s.admit([cand(t_ms=400)], mature(), t_ms=400) == []
    assert s.admit([cand(t_ms=500)], mature(), t_ms=500) == []
    # ...the third fires.
    assert s.admit([cand(t_ms=600)], mature(), t_ms=600) != []


def test_zero_grace_is_todays_exact_semantics():
    s = Suppressor(run_grace_frames=0)
    assert s.admit([cand(t_ms=0)], mature(), t_ms=0) == []
    assert s.admit([cand(t_ms=100)], mature(), t_ms=100) == []
    assert s.admit([], mature(), t_ms=200) == []
    # Old behavior: the absence deleted the run; three fresh frames needed.
    assert s.admit([cand(t_ms=300)], mature(), t_ms=300) == []
    assert s.admit([cand(t_ms=400)], mature(), t_ms=400) == []
    assert s.admit([cand(t_ms=500)], mature(), t_ms=500) != []


def test_grace_cannot_outlive_the_track():
    s = Suppressor()
    assert s.admit([cand(t_ms=0)], mature(), t_ms=0) == []
    assert s.admit([cand(t_ms=100)], mature(), t_ms=100) == []
    assert s.admit([], mature(), t_ms=200) == []          # graced
    # Track died: maturity gate (Stage 2) blocks regardless of the kept run.
    assert s.admit([cand(t_ms=300)], {}, t_ms=300) == []
