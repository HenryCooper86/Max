# ADAS Algorithm Hardening & Ride Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three synthetically-provable ADAS pipeline fragilities (time-blind ego gating, flicker-triggered suppression re-arming, order-dependent association), correct the TTC/corridor documentation, and ship `tools/evaluate.py` + a ride protocol so the first labelled ride produces M1-gate numbers.

**Architecture:** Each fix is a bounded change to one module with its semantics disclosed through the `Tuning` fingerprint (two new fields — the fingerprint _changing_ is by design and test-pinned). `evaluate.py` scores the live shadow log against `corpus/labels.py` windows using wall-clock alignment from the recorder's metadata sidecars — no pipeline re-run, no invented numbers on missing inputs.

**Tech Stack:** Python 3.10 stdlib + numpy (already on board). Tests run **on the board** via pytest over SSH. No TS changes (README/docs only elsewhere).

**Spec:** `docs/superpowers/specs/2026-07-30-adas-algorithm-hardening-design.md`

## Global Constraints

- **Board test cycle:** `scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/` then `ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/<file> -q'`. IP is network-dependent (`10.42.0.11` as of 2026-07-30): rediscover with `arp -a` → `nc -G 2 -z <ip> 22` → `ssh root@<ip> 'ls /usr/hobot'`. All SSH foreground. Never touch `/opt/max/shared` (live max-agent dependency). Do not restart board services except where a task explicitly says so.
- **Board suite baseline: 338 passed, 0 skipped** — never drops below.
- **Semantics changes are exactly the two spec'd ones** (time-based ego, one-frame suppression grace); everything else must be bit-identical at nominal rate, with golden tests proving it. `dt_ms=None`/`≤0` and `run_grace_frames=0` reproduce today's behavior exactly.
- The fingerprint MUST change (old value `9b33ddc9a92d` from the 2026-07-30 bench ride header) and a test pins that it did.
- No new dependencies; no scipy. Log convention `[tag] message`, `print(..., flush=True)`.
- Commit after every task; branch `feat/adas-algorithm-hardening`.

---

### Task 1: The two new Tuning fields, and the fingerprint-change pin

**Files:**

- Modify: `rdk/vision/adas/tuning.py`
- Test: `rdk/vision/tests/test_tuning.py` (extend)

**Interfaces:**

- Produces: `Tuning.min_flow_px_per_s: float = 6.0` (grouped under a new `# adas/ego_motion.py` comment) and `Tuning.run_grace_frames: int = 1` (in the `# suppress.py` group). Tasks 2 and 3 consume them.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_tuning.py`:

```python
def test_new_fields_freeze_their_defaults():
    # min_flow_px_per_s: 6.0 px/s == the old 0.6 px/frame at the nominal
    # 10 fps — same gate at nominal rate, now time-based.
    assert DEFAULT.min_flow_px_per_s == 6.0
    # One flicker frame of grace; 0 restores the old consecutive-only rule.
    assert DEFAULT.run_grace_frames == 1


def test_fingerprint_changed_from_the_evidence_track():
    """The two new fields deliberately change pipeline semantics, and the
    fingerprint exists to disclose exactly that. 9b33ddc9a92d is the
    evidence-track fingerprint captured in the 2026-07-30 bench ride's shadow
    header. If this ever fails because they match again, the disclosure
    mechanism itself is broken."""
    assert fingerprint() != "9b33ddc9a92d"
```

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tuning.py -q'
```

Expected: FAIL — `Tuning` has no `min_flow_px_per_s` (AttributeError); the fingerprint test passes only once the fields exist, so it FAILS via the first assert's error too.

- [ ] **Step 3: Implement**

In `rdk/vision/adas/tuning.py`, add to the dataclass (between the `# ttc.py` and `# suppress.py` groups):

```python
    # adas/ego_motion.py
    #: Moving/stopped gate, in WORK_WIDTH pixels per second. 6.0 px/s equals
    #: the pre-time-basing 0.6 px per frame at the nominal 10 fps, so behavior
    #: at nominal rate is unchanged; a dropped frame no longer doubles
    #: apparent motion. This is the single most load-bearing suppression
    #: constant, previously outside the fingerprint.
    min_flow_px_per_s: float = 6.0
```

and to the `# suppress.py` group:

```python
    #: Consecutive-run grace: a candidate absent for up to this many frames
    #: keeps its stability-run credit. One detector flicker at 10 fps used to
    #: re-arm the 3-frame gate and blind the pipeline ~600 ms. 0 restores the
    #: strict consecutive rule.
    run_grace_frames: int = 1
```

Update the module docstring's non-coverage sentence: the ego-motion flow gate is now covered; detector conf/NMS and model identity remain outside.

- [ ] **Step 4: Verify green on the board, and the full suite**

Same commands, then `ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`.
Expected: test_tuning green; full suite **338 passed** (no other test reads the fingerprint value or field count).

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/tuning.py rdk/vision/tests/test_tuning.py
git commit -m "feat(adas): the ego gate and flicker grace enter the fingerprint"
```

---

### Task 2: Time-based ego motion

**Files:**

- Modify: `rdk/vision/adas/ego_motion.py`, `rdk/vision/adas/runtime.py`
- Test: `rdk/vision/tests/test_ego_motion.py` (extend)

**Interfaces:**

- Consumes: `DEFAULT.min_flow_px_per_s` (Task 1).
- Produces: `estimate(prev_y, curr_y, width, height, grid=8, dt_ms: int | None = None, min_flow_px_per_s: float = DEFAULT.min_flow_px_per_s) -> EgoState`. `MIN_FLOW_MAGNITUDE = DEFAULT.min_flow_px_per_s / 10.0` (legacy per-frame alias). Runtime passes `dt_ms` and the tuning threshold.

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_ego_motion.py` already builds shifted synthetic luma planes — read its helpers and reuse them (they construct `bytes` planes with a known horizontal shift; the existing moving/stopped tests show the pattern). Add:

```python
from adas.tuning import DEFAULT


def test_doubled_dt_halves_the_rate_and_flips_the_verdict():
    # A shift that reads ~1.0 px/frame: at dt=100ms that is ~10 px/s (moving,
    # threshold 6.0); at dt=250ms it is ~4 px/s (stopped). Same pixels, same
    # displacement — only time differs. Reuse this file's plane-pair helper
    # with a 2 px shift at WORK_WIDTH scale if 1 px is too near the noise
    # floor; the assertion pair is what matters, adjust dt values to bracket
    # the 6.0 px/s threshold for whatever displacement the helper produces.
    prev, curr, width, height = _shifted_pair()  # this file's existing helper pattern
    fast = estimate(prev, curr, width, height, dt_ms=100)
    slow = estimate(prev, curr, width, height, dt_ms=1000)
    assert fast.moving
    assert not slow.moving
    assert fast.speed_scale > slow_speed_floor(slow)  # px/s scale on the dt path


def test_dt_none_and_nonpositive_match_legacy_exactly():
    prev, curr, width, height = _shifted_pair()
    legacy = estimate(prev, curr, width, height)
    for dt in (None, 0, -5):
        again = estimate(prev, curr, width, height, dt_ms=dt)
        assert again.moving == legacy.moving
        assert again.speed_scale == legacy.speed_scale


def test_legacy_alias_is_the_nominal_rate_equivalence():
    from adas.ego_motion import MIN_FLOW_MAGNITUDE

    assert MIN_FLOW_MAGNITUDE == DEFAULT.min_flow_px_per_s / 10.0
```

(`_shifted_pair` / `slow_speed_floor` are stand-ins for whatever the file's real helpers are called — copy the existing tests' construction lines verbatim; the three assertion groups are the deliverable. If the helper's displacement makes 100/1000 ms not bracket 6.0 px/s, pick dt values that do and say so in a comment.)

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ego_motion.py -q'
```

Expected: FAIL — `estimate()` has no `dt_ms` parameter.

- [ ] **Step 3: Implement `ego_motion.py`**

- `from .tuning import DEFAULT` at the imports.
- Replace the `MIN_FLOW_MAGNITUDE = 0.6` constant with:

```python
#: Legacy per-frame-pair gate, kept for the dt_ms=None path and old callers.
#: Defined as the exact nominal-rate equivalence of the time-based gate:
#: 6.0 px/s ÷ 10 fps = 0.6 px/frame — today's value, derived not duplicated.
MIN_FLOW_MAGNITUDE = DEFAULT.min_flow_px_per_s / 10.0
```

- New signature and tail of `estimate` (everything above the final three lines is unchanged):

```python
def estimate(
    prev_y: bytes,
    curr_y: bytes,
    width: int,
    height: int,
    grid: int = 8,
    dt_ms: int | None = None,
    min_flow_px_per_s: float = DEFAULT.min_flow_px_per_s,
) -> EgoState:
    ...
    magnitude = float(displacements.mean()) if displacements.size else 0.0
    if dt_ms is not None and dt_ms > 0:
        # The gate is a rate: the same physical motion reads the same whether
        # a frame was dropped or not. A nonpositive dt (duplicate or garbled
        # timestamps) falls through to the legacy per-frame path below.
        px_per_s = magnitude * 1000.0 / dt_ms
        moving = px_per_s >= min_flow_px_per_s
        return EgoState(moving=moving, speed_scale=px_per_s if moving else 0.0)
    moving = magnitude >= MIN_FLOW_MAGNITUDE
    return EgoState(moving=moving, speed_scale=magnitude if moving else 0.0)
```

- Docstring: replace "the front camera's luma plane" with per-camera semantics (each ADAS thread feeds its own camera's frames), and add the limitation sentence: horizontal-only block matching under-measures radial expansion — the dominant flow for straight-line motion on a forward camera; a radial/vertical upgrade is deferred until real ride footage can validate it.

- [ ] **Step 4: Wire `runtime.py`**

In `run_camera`'s loop, alongside `previous_nv12`:

```python
    previous_nv12: bytes | None = None
    previous_t_ms: int | None = None
    ...
        if previous_nv12 is None:
            ego = EgoState(moving=False, speed_scale=0.0)
        else:
            # No dt clamp: a gap past max_gap_ms wipes the tracker anyway, and
            # a big dt just reads as a small px/s — conservative toward
            # "stopped", which is the safe direction for the ego gate.
            ego = estimate(
                previous_nv12,
                frame.nv12,
                frame.width,
                frame.height,
                dt_ms=(frame.t_ms - previous_t_ms) if previous_t_ms is not None else None,
                min_flow_px_per_s=config.tuning.min_flow_px_per_s,
            )
        previous_nv12 = frame.nv12
        previous_t_ms = frame.t_ms
```

- [ ] **Step 5: Verify green on the board (ego + runtime + full suite)**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ego_motion.py tests/test_runtime.py -q && cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: all green, full suite ≥ 338 + the new tests. Pre-existing ego tests pass unchanged (they call without `dt_ms` → legacy path).

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/adas/ego_motion.py rdk/vision/adas/runtime.py rdk/vision/tests/test_ego_motion.py
git commit -m "feat(adas): the moving gate is a rate, so a dropped frame cannot fake motion"
```

---

### Task 3: Flicker-tolerant suppression

**Files:**

- Modify: `rdk/vision/adas/suppress.py`
- Test: `rdk/vision/tests/test_suppress.py` (extend)

**Interfaces:**

- Consumes: `DEFAULT.run_grace_frames` (Task 1).
- Produces: `RUN_GRACE_FRAMES = DEFAULT.run_grace_frames` module alias; `Suppressor.__init__(..., run_grace_frames: int = RUN_GRACE_FRAMES)`.

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_suppress.py` has `cand()`, `mature()`, and `admit_until_fired()` helpers — reuse them. Add:

```python
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
```

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_suppress.py -q'
```

Expected: the flicker test FAILS (run deleted at t=200, so t=300 is run 1 of 3); the zero-grace test passes already (it IS today's behavior — keep it as the golden pin).

- [ ] **Step 3: Implement**

In `suppress.py`:

```python
RUN_GRACE_FRAMES = DEFAULT.run_grace_frames
```

`__init__` gains `run_grace_frames: int = RUN_GRACE_FRAMES`, stored, plus `self._missed: dict[tuple[str, int], int] = {}`.

Replace the absence-deletion loop in `admit()`:

```python
        seen = {(c.threat_id, c.track_id) for c in candidates}
        for key in list(self._runs):
            if key not in seen:
                # Stage 3, bounded grace: the detector blinked but the track
                # persists (Stage 2 still gates on maturity). One flicker at
                # 10 fps used to re-arm the whole 3-frame gate — ~600 ms of
                # blindness bought by a single dropped detection.
                missed = self._missed.get(key, 0)
                if missed < self.run_grace_frames:
                    self._missed[key] = missed + 1
                else:
                    del self._runs[key]
                    self._missed.pop(key, None)
```

And where a present candidate increments its run, reset its missed count:

```python
            self._runs[key] = self._runs.get(key, 0) + 1
            self._missed.pop(key, None)
```

Update the class docstring's Stage 3 sentence to state the bounded grace.

- [ ] **Step 4: Verify green on the board + full suite**

Same commands + `python3 -m pytest tests/ -q`. Expected: all green, every pre-existing suppress test unchanged and passing (grace only ever _keeps_ runs the old code deleted; strictly-consecutive sequences behave identically).

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/suppress.py rdk/vision/tests/test_suppress.py
git commit -m "feat(adas): one detector flicker no longer re-arms the stability gate"
```

---

### Task 4: Swap-resistant association

**Files:**

- Modify: `rdk/vision/perception/tracker.py`
- Test: `rdk/vision/tests/test_tracker.py` (extend)

**Interfaces:**

- Produces: behavior only — `Tracker.update()`'s matching becomes globally IoU-ordered; signature, aging, wipe, trim, and creation unchanged.

- [ ] **Step 1: Write the failing tests**

Reuse `test_tracker.py`'s detection helper (`_det(...)`-style — copy its exact name/shape). Add:

```python
def test_global_matching_beats_track_order_stealing():
    # Track 1 and track 2, same class. Detection X overlaps track 2 strongly
    # (0.6) and track 1 weakly (0.4); detection Y overlaps only track 1
    # (0.35). Old per-track greedy let track 1 (processed first) steal X,
    # leaving track 2 unmatched and Y spawning a spurious new track. Global
    # IoU ordering assigns X→track2, Y→track1.
    tracker = Tracker()
    (t1,) = tracker.update([_det(0.10, 0.4, 0.30, 0.6)], t_ms=0)
    tracks = tracker.update(
        [_det(0.10, 0.4, 0.30, 0.6), _det(0.40, 0.4, 0.60, 0.6)], t_ms=100
    )
    assert len(tracks) == 2
    t2 = next(t for t in tracks if t.track_id != t1.track_id)
    # Geometry for the discriminating frame: X sits mostly on t2, Y mostly on
    # t1 — compute the boxes so IoU(t2,X) > IoU(t1,X) > iou_threshold and
    # IoU(t1,Y) > iou_threshold > IoU(t2,Y). (Derive exact coordinates from
    # the helper's box convention; assert the IoUs with _iou first so the
    # fixture can't silently stop discriminating.)
    ...
    result = tracker.update([det_x, det_y], t_ms=200)
    by_id = {t.track_id: t for t in result}
    assert len(result) == 2                      # no spurious third track
    assert by_id[t2.track_id].last covers det_x  # X went to its best owner
    assert by_id[t1.track_id].last covers det_y


def test_detection_order_cannot_change_the_assignment():
    def run(order):
        tracker = Tracker()
        tracker.update([_det(0.10, 0.4, 0.30, 0.6), _det(0.50, 0.4, 0.70, 0.6)], t_ms=0)
        tracks = tracker.update(order, t_ms=100)
        return sorted((t.track_id, round(t.last.x1, 3)) for t in tracks)

    a = _det(0.12, 0.4, 0.32, 0.6)
    b = _det(0.52, 0.4, 0.72, 0.6)
    assert run([a, b]) == run([b, a])
```

(The first test's `...` is the coordinate derivation — the implementer computes concrete boxes, asserts the three IoU inequalities explicitly with the module's `_iou` before the final assertions, and replaces the pseudo-assertions `last covers det_x/y` with `last.x1 == det_x.x1`-style equality on the appended sample. The test must FAIL against the old per-track greedy — verify that during RED.)

- [ ] **Step 2: Run on the board to verify RED**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tracker.py -q'
```

Expected: the stealing test FAILS against the current greedy (that is the point — if it passes, the fixture geometry isn't discriminating; fix the boxes before proceeding).

- [ ] **Step 3: Implement**

Replace the matching block in `Tracker.update` (between the gap-wipe and the track-creation loop):

```python
        pairs: list[tuple[float, int, int]] = []
        for t_index, track in enumerate(self._tracks):
            for d_index, det in enumerate(dets):
                if det.cls != track.cls:
                    continue
                score = _iou(track.last, det)
                if score > self.iou_threshold:
                    pairs.append((score, t_index, d_index))
        # Globally best-first, with deterministic tie-breaks. Per-track greedy
        # let an early track steal a later track's better match, and an
        # identity swap fabricates the dh/dt spike max_gap_ms exists to
        # prevent — arriving by a different route.
        pairs.sort(key=lambda p: (-p[0], self._tracks[p[1]].track_id, p[2]))
        used_tracks: set[int] = set()
        used_dets: set[int] = set()
        for score, t_index, d_index in pairs:
            if t_index in used_tracks or d_index in used_dets:
                continue
            used_tracks.add(t_index)
            used_dets.add(d_index)
            track, det = self._tracks[t_index], dets[d_index]
            track.misses = 0
            track.samples.append(
                BoxSample(t_ms=t_ms, x1=det.x1, y1=det.y1, x2=det.x2, y2=det.y2)
            )
        for t_index, track in enumerate(self._tracks):
            if t_index not in used_tracks:
                track.misses += 1
        unmatched = [det for d_index, det in enumerate(dets) if d_index not in used_dets]
```

(The old `unmatched = list(dets)` initialization and the per-track loop go; the existing creation loop consumes the new `unmatched`. The `score > self.iou_threshold` strictness matches the old `best_iou` seeding exactly.)

- [ ] **Step 4: Verify green on the board + full suite**

Same commands + full suite. Expected: all pre-existing tracker tests pass (single-track scenarios are unaffected by global ordering) + the two new ones.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/perception/tracker.py rdk/vision/tests/test_tracker.py
git commit -m "fix(adas): association is globally best-first, so tracks cannot steal identities"
```

---

### Task 5: Documentation truth (TTC + corridor)

**Files:**

- Modify: `rdk/vision/adas/ttc.py` (docstring), `rdk/vision/adas/threat.py` (corridor comment)

- [ ] **Step 1: Rewrite `ttc.py`'s module docstring**

Replace the first paragraph ("tau = h / (dh/dt). One lens, no calibration…") with:

```python
"""Time to contact from box-height expansion.

tau = h / (dh/dt) is the standard visual time-to-contact estimate: under a
pinhole camera, box height scales as 1/Z, so h/(dh/dt) equals Z/v — the
physical seconds until the object reaches the camera plane, assuming constant
closing velocity. No calibration or intrinsics needed; a box that is not
growing is not closing, at any distance.

The estimate degrades exactly where its assumptions do: ego rotation (a turn
sweeps boxes sideways and pollutes dh/dt), cut-ins (the object changes lanes,
violating constant closing), and acceleration. It also measures time to the
camera plane, not bumper-to-bumper distance. The thresholds in tuning.py are
calibrated against this estimator's behavior, not against a rangefinder.
"""
```

(Keep the existing height-vs-width and least-squares paragraphs verbatim — they remain true.)

- [ ] **Step 2: Extend the corridor comment in `threat.py`**

Below `in_corridor`'s existing docstring lines, add:

```python
    Known limitation, deferred pending real ride footage: the band has no
    perspective or lean model. A distant next-lane vehicle can sit inside a
    fixed centered band, and an in-lane vehicle can leave it mid-lean. A
    perspective corridor designed without footage would be guesswork; the
    width stays a Tuning field until rides exist to validate against.
```

- [ ] **Step 3: Verify nothing broke, commit**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ttc.py tests/test_threat.py -q'
git add rdk/vision/adas/ttc.py rdk/vision/adas/threat.py
git commit -m "docs(adas): say what tau already is, and what the corridor is not yet"
```

---

### Task 6: `tools/evaluate.py` — pure scoring

**Files:**

- Create: `rdk/vision/tools/evaluate.py` (scoring half)
- Test: `rdk/vision/tests/test_evaluate.py` (create)

**Interfaces:**

- Consumes: `ShadowRecord` (`adas/shadow.py`), `HazardWindow` (`corpus/labels.py`).
- Produces (Task 7 consumes):

```python
@dataclass(frozen=True)
class ThreatScore:
    threat: str
    camera: str
    hits: int          # windows with >= 1 matching alert
    missed: int        # windows with none
    false_alerts: int  # alerts matching no window

@dataclass(frozen=True)
class RideScore:
    duration_h: float
    per_threat: list[ThreatScore]
    false_alerts_total: int
    false_criticals: int
    false_alerts_per_hour: float
    fingerprints: list[str]
    gate_false_rate_ok: bool       # false_alerts_per_hour < 1.0
    gate_false_criticals_ok: bool  # false_criticals == 0

def score_ride(
    records: list[ShadowRecord],
    windows: list[HazardWindow],
    ride_start_wall_ms: int,
    duration_h: float,
    fingerprints: list[str],
    tolerance_ms: int = 1000,
) -> RideScore
```

Matching rule: an alert matches a window when `record.threat_id == window.threat`, `record.camera == window.camera`, and `window.start_ms - tolerance_ms <= (record.wall_ms - ride_start_wall_ms) <= window.end_ms + tolerance_ms`. Every alert inside a window counts toward that window's hit (a window is "hit" with ≥1); alerts matching no window are false; false criticals are false alerts with `severity == "critical"`.

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_evaluate.py` (standard `sys.path` preamble; a `record(...)` helper building `ShadowRecord`s with sensible defaults — mirror `test_shadow.py`'s helper, overriding `threat_id/severity/camera/wall_ms`):

```python
def _window(threat="rear_approach", camera="rear", start=10_000, end=15_000):
    return HazardWindow(threat=threat, camera=camera, start_ms=start, end_ms=end)


def test_hit_miss_and_false_are_scored():
    windows = [_window(), _window(threat="pedestrian_ahead", camera="front", start=30_000, end=34_000)]
    records = [
        record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_012_000),
        record(threat_id="forward_collision", camera="front", severity="critical", wall_ms=1_050_000),
    ]
    score = score_ride(records, windows, ride_start_wall_ms=1_000_000, duration_h=0.5, fingerprints=["abc"])
    rear = next(t for t in score.per_threat if t.threat == "rear_approach")
    ped = next(t for t in score.per_threat if t.threat == "pedestrian_ahead")
    assert rear.hits == 1 and rear.missed == 0 and rear.false_alerts == 0
    assert ped.hits == 0 and ped.missed == 1
    assert score.false_alerts_total == 1          # the forward_collision alert
    assert score.false_criticals == 1
    assert score.false_alerts_per_hour == 2.0     # 1 false / 0.5 h
    assert not score.gate_false_rate_ok
    assert not score.gate_false_criticals_ok


def test_tolerance_bounds_are_inclusive():
    windows = [_window(start=10_000, end=15_000)]
    at_edge = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_009_000)
    score = score_ride([at_edge], windows, 1_000_000, 1.0, ["abc"], tolerance_ms=1000)
    assert score.per_threat[0].hits == 1          # 9_000 == start - tolerance
    past_edge = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_008_999)
    score = score_ride([past_edge], windows, 1_000_000, 1.0, ["abc"], tolerance_ms=1000)
    assert score.per_threat[0].false_alerts == 1


def test_camera_mismatch_is_not_a_hit():
    windows = [_window(camera="rear")]
    wrong_cam = record(threat_id="rear_approach", camera="front", severity="critical", wall_ms=1_012_000)
    score = score_ride([wrong_cam], windows, 1_000_000, 1.0, ["abc"])
    assert score.false_alerts_total == 1
    assert next(t for t in score.per_threat if t.camera == "rear").missed == 1


def test_empty_log_is_a_valid_result():
    score = score_ride([], [_window()], 1_000_000, 2.0, ["abc"])
    assert score.false_alerts_total == 0
    assert score.gate_false_rate_ok and score.gate_false_criticals_ok
    assert score.per_threat[0].missed == 1


def test_gate_passes_when_clean():
    windows = [_window()]
    hit = record(threat_id="rear_approach", camera="rear", severity="critical", wall_ms=1_012_000)
    score = score_ride([hit], windows, 1_000_000, 2.0, ["abc"])
    assert score.gate_false_rate_ok and score.gate_false_criticals_ok
```

- [ ] **Step 2: Run on the board to verify RED**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_evaluate.py -q'
```

Expected: FAIL — no module `tools.evaluate` / no `score_ride`.

- [ ] **Step 3: Implement the scoring half of `rdk/vision/tools/evaluate.py`**

Module docstring: "Score a ride's live shadow log against its hazard labels — the M1 gate, measured. The log already holds what the deployed pipeline did; no re-run, no reconstruction. Numbers are only ever computed from inputs that exist." Then the two dataclasses and `score_ride` exactly per the Interfaces block. Implementation sketch:

```python
def score_ride(records, windows, ride_start_wall_ms, duration_h, fingerprints, tolerance_ms=1000):
    window_hits = [0] * len(windows)
    false_alerts: list[ShadowRecord] = []
    for rec in records:
        rel = rec.wall_ms - ride_start_wall_ms
        matched = False
        for i, w in enumerate(windows):
            if (
                rec.threat_id == w.threat
                and rec.camera == w.camera
                and w.start_ms - tolerance_ms <= rel <= w.end_ms + tolerance_ms
            ):
                window_hits[i] += 1
                matched = True
                break
        if not matched:
            false_alerts.append(rec)

    keys = sorted({(w.threat, w.camera) for w in windows} | {(r.threat_id, r.camera) for r in false_alerts})
    per_threat = []
    for threat, camera in keys:
        hit = sum(1 for w, n in zip(windows, window_hits) if w.threat == threat and w.camera == camera and n > 0)
        missed = sum(1 for w, n in zip(windows, window_hits) if w.threat == threat and w.camera == camera and n == 0)
        false_n = sum(1 for r in false_alerts if r.threat_id == threat and r.camera == camera)
        per_threat.append(ThreatScore(threat=threat, camera=camera, hits=hit, missed=missed, false_alerts=false_n))

    false_total = len(false_alerts)
    false_criticals = sum(1 for r in false_alerts if r.severity == "critical")
    per_hour = (false_total / duration_h) if duration_h > 0 else float("inf")
    return RideScore(
        duration_h=duration_h,
        per_threat=per_threat,
        false_alerts_total=false_total,
        false_criticals=false_criticals,
        false_alerts_per_hour=per_hour,
        fingerprints=list(fingerprints),
        gate_false_rate_ok=per_hour < 1.0,
        gate_false_criticals_ok=false_criticals == 0,
    )
```

- [ ] **Step 4: Verify green on the board, commit**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_evaluate.py -q'
git add rdk/vision/tools/evaluate.py rdk/vision/tests/test_evaluate.py
git commit -m "feat(adas): score a shadow log into M1-gate numbers"
```

---

### Task 7: `tools/evaluate.py` — ride loading and CLI

**Files:**

- Modify: `rdk/vision/tools/evaluate.py`
- Test: `rdk/vision/tests/test_evaluate.py` (extend)

**Interfaces:**

- Consumes: `score_ride` (Task 6), `read_shadow`/`read_tuning` (`adas/shadow.py`), `read_labels`/`LABELS_NAME` (`corpus/labels.py`), `read_metadata` (`recorder/metadata.py`).
- Produces: `load_ride(ride_dir: Path) -> tuple[list[ShadowRecord], list[str], int, float]` (records, fingerprints, ride_start_wall_ms, duration_h — raising `SystemExit` with actionable messages per the spec's error table), and `main()` with `python3 -m tools.evaluate <ride-dir> [--tolerance-ms 1000] [--json PATH]`.

- [ ] **Step 1: Write the failing tests**

Add to `test_evaluate.py` (fixture ride built in tmp_path: `shadow-front.jsonl` written via `ShadowLog(path, tuning=DEFAULT)` + records; sidecars `front/seg-000000.jsonl` written via `MetadataWriter` with `FrameMeta` rows spanning a known wall range):

```python
def _fixture_ride(tmp_path, with_labels=True, with_sidecars=True, records=()):
    ride = tmp_path / "ride-test"
    (ride / "front").mkdir(parents=True)
    if with_sidecars:
        with MetadataWriter(ride / "front" / "seg-000000.jsonl") as w:
            w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1_000_000, camera="front"))
            w.append(FrameMeta(frame_index=1, mono_ns=10**9, wall_ms=1_360_000, camera="front"))
    with ShadowLog(ride / "shadow-front.jsonl", tuning=DEFAULT) as log:
        for rec in records:
            log.append(rec)
    if with_labels:
        write_labels(ride, [HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=10_000, end_ms=14_000)])
    return ride


def test_load_ride_derives_start_and_duration_from_sidecars(tmp_path):
    ride = _fixture_ride(tmp_path)
    records, fingerprints, start, duration_h = load_ride(ride)
    assert start == 1_000_000
    assert abs(duration_h - 0.1) < 1e-9          # 360 s
    assert fingerprints == [fingerprint(DEFAULT)]


def test_missing_labels_exits_with_instructions(tmp_path, capsys):
    ride = _fixture_ride(tmp_path, with_labels=False)
    with pytest.raises(SystemExit):
        main([str(ride)])
    assert "tools.label" in capsys.readouterr().err


def test_missing_sidecars_exit_naming_the_files(tmp_path, capsys):
    ride = _fixture_ride(tmp_path, with_sidecars=False)
    with pytest.raises(SystemExit):
        main([str(ride)])
    assert "jsonl" in capsys.readouterr().err


def test_cli_scores_and_writes_json(tmp_path, capsys):
    hit = record(threat_id="pedestrian_ahead", camera="front", severity="critical", wall_ms=1_012_000)
    ride = _fixture_ride(tmp_path, records=[hit])
    out = tmp_path / "score.json"
    main([str(ride), "--json", str(out)])
    printed = capsys.readouterr().out
    assert "false alerts/hour" in printed and "fingerprint" in printed
    payload = json.loads(out.read_text())
    assert payload["false_alerts_total"] == 0
    assert payload["gate_false_rate_ok"] is True
```

(`main` takes `argv: list[str] | None = None` for testability — mirror `tools/label.py`'s argparse style.)

- [ ] **Step 2: Run on the board to verify RED**

Same test-file command. Expected: FAIL — `load_ride`/`main` undefined.

- [ ] **Step 3: Implement**

`load_ride`: glob `ride/shadow-*.jsonl` (each → `read_shadow` + `read_tuning`; fingerprints = ordered-unique header fingerprints across files; no shadow files → `SystemExit` naming the expected pattern). Sidecars: `sorted(ride.glob("*/seg-*.jsonl"))`; empty → `SystemExit("no metadata sidecars (<camera>/seg-*.jsonl) — cannot measure ride duration")`; else `wall = [m.wall_ms for p in paths for m in read_metadata(p)]`, `start=min(wall)`, `duration_h=(max(wall)-min(wall))/3_600_000`. Labels: `read_labels(ride)`; empty → `SystemExit` whose message includes the `python3 -m tools.label add --ride ...` command. `main`: argparse (`ride`, `--tolerance-ms`, `--json`), calls `load_ride` + `score_ride`, prints a per-threat table, the totals, `tuning fingerprint(s): ...`, and the gate verdict lines, including: "missed-hazard regression needs a second corpus to compare against — record more rides." `--json` writes `json.dumps(asdict(score), indent=2)`. Errors to stderr (`print(..., file=sys.stderr)` then `raise SystemExit(1)`).

- [ ] **Step 4: Verify green on the board + full suite, commit**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_evaluate.py -q && python3 -m pytest tests/ -q'
git add rdk/vision/tools/evaluate.py rdk/vision/tests/test_evaluate.py
git commit -m "feat(adas): evaluate a labelled ride from the command line"
```

---

### Task 8: The ride protocol in the README

**Files:**

- Modify: `rdk/README.md` (new subsection beside "ADAS M0 — recording a corpus")

- [ ] **Step 1: Write the section**

Add after the M0 recording section:

```markdown
### Recording a tuning corpus — the ride protocol

Shadow mode on (`MAX_ADAS_SHADOW=1` in `/etc/max/agent.env`, restart
`max-vision`), then ride normally — but deliberately include, front camera
unless noted:

1. **A pull-up-behind at a stop.** The ego gate's defining case: a car
   arriving behind you at a light must produce **zero** rear alerts while you
   are stationary. This single scenario validates the moving/stopped gate.
2. **A steady follow** above tailgate height for more than ten seconds
   (rear camera) — the tailgating dwell case.
3. **Being overtaken, and overtaking** — closing-rate discrimination.
4. **A pedestrian crossing ahead at low speed** — the pedestrian TTC case.

A good first corpus is at least 30 minutes of riding with several stops and
one of each scenario. Afterwards, copy the ride off the board and label the
genuine hazards:

​`bash
python3 -m tools.label add --ride ./corpus/ride-... \
  rear_approach:rear:12000:15000:"car closed fast at the light"
python3 -m tools.evaluate ./corpus/ride-...
​`

`evaluate` prints the ride's false-alerts-per-hour, false criticals, and
missed hazards per threat — the measured half of the M1 gate — stamped with
the tuning fingerprint from the ride's own shadow log. Alert audio stays
locked until those numbers meet the gate; see "ADAS M2".
```

(Strip the zero-width escapes on the inner code fence — they exist only to nest it here.)

- [ ] **Step 2: Prettier check + commit**

```bash
npx prettier --check rdk/README.md || npx prettier --write rdk/README.md
git add rdk/README.md
git commit -m "docs(rdk): the ride protocol that makes the first corpus count"
```

---

### Task 9: Full gates

- [ ] **Step 1: Full board suite** — `scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/ && ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`. Expected: ≥ 338 + all new tests, 0 skipped, 0 failed.
- [ ] **Step 2: `npm run check`** — expected green; only markdown/docs fallout possible; fix-forward formatting only.
- [ ] **Step 3: Commit fallout if any** — `git add -A && git commit -m "chore(adas): satisfy the repo gate"` (skip if clean).

---

### Task 10: Board acceptance — the honest no-labels path

**Files:** none (deployment + verification; report only).

- [ ] **Step 1: Deploy and restart the sidecar with shadow on** (allowed in this task):

```bash
scp -q -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'sed -i "s/^MAX_ADAS_SHADOW=.*/MAX_ADAS_SHADOW=1/" /etc/max/agent.env && systemctl restart max-vision && sleep 10 && systemctl is-active max-vision'
```

- [ ] **Step 2: Let a bench mini-ride run ~3 minutes**, then evaluate it un-labelled:

```bash
ssh root@10.42.0.11 'sleep 180; RIDE=$(ls -td /var/lib/max/corpus/ride-* | head -1); \
  cd /opt/max/rdk/vision && python3 -m tools.evaluate "$RIDE"; echo "exit=$?"'
```

Expected: exit=1 with the labelling instructions on stderr — the honest path working end-to-end on real ride data. Also confirm the ride's shadow log header carries the NEW fingerprint (not `9b33ddc9a92d`): `head -1 "$RIDE"/shadow-front.jsonl`.

- [ ] **Step 3: Restore and verify**:

```bash
ssh root@10.42.0.11 'sed -i "s/^MAX_ADAS_SHADOW=.*/MAX_ADAS_SHADOW=0/" /etc/max/agent.env && systemctl restart max-vision && sleep 8 && systemctl is-active max-vision && curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/preview/front'
```

Expected: `active`, `200`.

- [ ] **Step 4: Report** — per-step evidence; note explicitly that the labelled-ride acceptance is the user's first real ride (the track's exit into tuning, not a merge gate).

---

## Self-review notes

- **Spec coverage:** Tuning fields + fingerprint pin (T1), time-based ego incl. runtime wiring and docstrings (T2), flicker grace (T3), association (T4), TTC/corridor docs (T5), scoring (T6), CLI/loading with every error-table row (T7), protocol (T8), gates (T9), board acceptance incl. new-fingerprint-in-real-header check (T10). Every spec Goal, error-table row, and verification bullet maps to a task.
- **Type consistency:** `min_flow_px_per_s`/`run_grace_frames` names match across T1/T2/T3; `score_ride`/`load_ride`/`ThreatScore`/`RideScore` consistent between T6 and T7; `main(argv=None)` matches its tests.
- **Bounded flexibility (not placeholders):** T2's `_shifted_pair` and T4's coordinate derivation defer to the existing test files' real helpers with the assertions fully specified and an explicit RED-discrimination requirement; T6's `record(...)` helper mirrors `test_shadow.py`'s.
