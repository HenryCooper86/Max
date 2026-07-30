# ADAS Algorithm Hardening & Ride Evaluation — Design

## Summary

The evidence track made shadow rides trustworthy; this track fixes the
pipeline fragilities that would pollute them, and builds the tool that turns
the first real ride into tuning-grade data.

Three fragilities are provable and fixable without road footage. Ego motion
measures displacement per frame *pair* with no time base, so one dropped frame
doubles apparent motion through the single most load-bearing suppression gate.
One detector flicker deletes a suppression run counter and re-arms the
three-frame stability gate, blinding the pipeline for ~600 ms at 10 fps.
Greedy per-track association can swap identities between overlapping
same-class vehicles, fabricating exactly the `dh/dt` spike the tracker's
gap-wipe exists to prevent.

Two suspected fragilities turn out to be documentation problems: `ttc.py`'s
`h / (dh/dt)` is the standard `tau = Z/v` time-to-contact estimate under
pinhole and constant-velocity assumptions — the docstring underselling it as
"seconds until the box fills the frame" is what needed fixing. And the
corridor's missing perspective/lean model is real but cannot be designed
honestly without footage; it stays a documented tunable.

The rides deliverable: a corpus protocol section in the README naming the
scenarios worth deliberately capturing, and `tools/evaluate.py`, which scores
a ride's live shadow log against its labels and emits the M1-gate numbers —
false alerts/hour, false criticals, missed hazards — stamped with the tuning
fingerprint the evidence track put in every log.

Two `Tuning` fields are added (`min_flow_px_per_s`, `run_grace_frames`), so
the fingerprint changes. That is intended and is the point of the fingerprint:
rides recorded before and after this track are distinguishable evidence.

## Scope

### Goals

- The moving/stopped gate is a rate (px/s), not a per-frame-pair count: frame
  drops no longer inflate apparent motion.
- One detector flicker no longer re-arms the suppression stability gate.
- Association is order-independent and swap-resistant, stdlib-only.
- TTC and ego-motion documentation states what the math actually does and
  which assumptions break it.
- A labelled ride can be scored into M1-gate numbers with one command.
- The README tells a rider exactly which scenarios to capture and how.

### Non-goals

- Radial/vertical ego flow, perspective or lean-compensated corridor,
  detection-quality/range claims — all data-dependent; deferred until the
  corpus exists, each with a written note at its site.
- Threshold retuning. The two new `Tuning` fields change *semantics*
  (time-basing, flicker grace); every numeric behavior at nominal frame rate
  is otherwise preserved.
- Re-running the pipeline over ride segments under a different `Tuning` (the
  sweep workflow). `evaluate.py` v1 scores the live shadow log only; sweeping
  needs a labelled corpus to be worth building against.
- True Hungarian assignment (scipy is not on the board; globally-ordered
  greedy is the stdlib-appropriate step).
- Arming alert audio, and anything agent-side (the alert severity-preemption
  question from the reliability review remains a separate, agent-side item).

## Time-based ego motion

`rdk/vision/adas/ego_motion.py`:

- `estimate(prev_y, curr_y, width, height, grid=8, dt_ms: int | None = None,
  min_flow_px_per_s: float = DEFAULT.min_flow_px_per_s)`.
- With a positive `dt_ms`: `magnitude_px_per_s = displacement_px * 1000 / dt_ms`
  (displacement in WORK_WIDTH pixels, as today) and
  `moving = magnitude_px_per_s >= min_flow_px_per_s`. `speed_scale` reports
  px/s on this path.
- `dt_ms=None` **or** `dt_ms <= 0` (duplicate/garbled timestamps): the legacy
  per-frame-pair path, byte-identical to today, thresholded by
  `MIN_FLOW_MAGNITUDE` — which becomes an alias of
  `DEFAULT.min_flow_px_per_s / 10.0` with a comment naming the nominal-rate
  equivalence (6.0 px/s ÷ 10 fps = 0.6 px/frame, today's value exactly).
- `Tuning` gains `min_flow_px_per_s: float = 6.0` — the moving/stopped gate
  enters the fingerprint, closing the largest hole the evidence track's
  non-coverage note documented.
- `adas/runtime.py` keeps `prev_t_ms` alongside `previous_nv12` and passes
  `dt_ms=frame.t_ms - prev_t_ms` and the tuning threshold. A gap larger than
  `max_gap_ms` wipes the tracker anyway; no dt clamp, documented at the call
  site.
- Docstring corrections: the estimator runs per camera on that camera's frames
  (not "the front camera"); horizontal-only search is stated as a limitation
  with radial flow named as data-dependent future work.

## Flicker-tolerant suppression

`rdk/vision/adas/suppress.py`:

- `Tuning` gains `run_grace_frames: int = 1`; module alias
  `RUN_GRACE_FRAMES = DEFAULT.run_grace_frames`; `Suppressor.__init__` gains
  `run_grace_frames: int = RUN_GRACE_FRAMES`.
- Mechanics: alongside `_runs`, a `_missed: dict[key, int]`. In `admit()`, a
  key absent from the frame's candidates: if `_missed[key] < run_grace_frames`,
  increment `_missed` and keep the run; otherwise delete both (today's
  behavior). A key present: reset `_missed[key] = 0` and increment the run as
  today.
- Stage 3's doctrine survives in bounded form: the grace only bridges detector
  flicker while the track itself persists — track death still ends everything
  via Stage 2, and `run_grace_frames=0` restores today's exact semantics.
- The docstring's "the run must be consecutive" comment is updated to state
  the bounded grace and why (one flicker at 10 fps previously cost ~600 ms of
  re-armed blindness).

## Swap-resistant association

`rdk/vision/perception/tracker.py`, `update()` matching only (aging, wipe,
trim, track creation all unchanged):

- Build every candidate triple `(track, detection, iou)` with matching class
  and `iou > iou_threshold`.
- Sort by `(-iou, track.track_id, detection_index)` — IoU descending, with
  deterministic tie-breaks.
- Assign in order; each track and each detection is consumed at most once.
  Unassigned tracks age (`misses += 1`); unassigned detections found new
  tracks, as today.
- Properties the tests pin: input detection order cannot change the
  assignment; two same-class boxes crossing paths keep their identities
  (the higher-IoU continuation wins globally, not first-in-list).

## Documentation truth

- `rdk/vision/adas/ttc.py` module docstring: `h/(dh/dt)` **is** `tau = Z/v` —
  physical time-to-contact under a pinhole camera and constant closing
  velocity; it degrades when those assumptions do (ego rotation, cut-ins,
  acceleration) and measures time to the *camera plane*, not bumper-to-bumper
  distance. The "fills the frame" phrasing goes.
- `rdk/vision/adas/threat.py` corridor comment: the fixed centered band has no
  perspective or lean model; a distant next-lane vehicle can sit inside it and
  an in-lane vehicle can leave it mid-lean. Deferred pending footage, named as
  such.

## The rides deliverable

### Protocol section in `rdk/README.md`

"Recording a tuning corpus — the ride protocol", placed beside the existing
M0 recording section: shadow mode on (`MAX_ADAS_SHADOW=1`), ride normally,
and deliberately include (front camera unless noted): a pull-up-behind at a
stop — the defining ego-gate case, expected to produce **zero** rear alerts
while stopped; a steady follow above tailgate height for >10 s; being
overtaken and overtaking; a pedestrian crossing ahead at low speed. Then copy
the corpus off the board and label with the existing `tools/label.py`,
windowing each genuine hazard. One paragraph states what a good first corpus
looks like (≥30 min total, several stops, at least one of each scenario).

### `tools/evaluate.py`

`python3 -m tools.evaluate <ride-dir> [--tolerance-ms 1000] [--json PATH]`

- Inputs: the ride's `shadow-<camera>.jsonl` files (alerts + tuning headers),
  `labels.json` (via `corpus/labels.py`'s `read_labels`), and the segment
  metadata sidecars (for the ride's first-frame `wall_ms` and total duration).
- Clock: label offsets are ms from ride start; an alert's ride-relative time
  is `record.wall_ms - ride_start_wall_ms`. A match is same threat, same
  camera, and alert time within the label window ± tolerance.
- Scores per camera and per threat: true positives, false alerts (alert
  matching no window), missed hazards (window matching no alert); totals:
  ride hours, false alerts/hour, false criticals count.
- Gate verdict printed explicitly against the M1 criteria: false alerts/hour
  < 1 and zero false criticals → the measured half of the gate; missed
  hazards reported as counts (the no-regression criterion needs a second
  corpus to compare against, and the output says so).
- Every report carries the tuning fingerprint(s) from the shadow header(s).

## Error and edge handling

| Condition | Behaviour |
| --- | --- |
| `dt_ms` None or ≤ 0 | Legacy per-frame ego path, bit-identical to today |
| Frame gap > `max_gap_ms` | Tracker wipe as today; ego just sees a large dt (small px/s — conservative toward "stopped") |
| `run_grace_frames=0` | Today's exact suppression semantics |
| Track dies during a grace window | Stage 2 (track maturity) ends the candidacy; grace cannot outlive the track |
| `evaluate` on a ride with no labels | Exit code 1 with the labelling commands, no scores invented |
| Empty shadow log | Valid result: 0 alerts over measured hours, gate verdict computed |
| Multiple tuning headers (mid-ride restart) | Reported per fingerprint; records grouped by the header preceding them |
| Alert with `segment=""` (pre-roll sentinel) | Scored normally — matching is time-based, segment not needed |
| Missing metadata sidecars | Exit with a message naming the expected files; duration cannot be guessed |

## Verification

### Automated — board pytest

- Ego: same displacement at doubled `dt_ms` halves px/s and flips the verdict
  at the boundary; `dt_ms=None` and `dt_ms=0` bit-match today's outputs on a
  fixture pair; `MIN_FLOW_MAGNITUDE` alias equals `min_flow_px_per_s / 10`.
- Suppression: present–absent–present fires without re-arming (grace=1);
  absent twice re-arms; `run_grace_frames=0` matches a pre-change
  golden sequence; grace state cannot survive track death (Stage 2 test).
- Association: crossing same-class boxes keep identities; shuffled detection
  order yields identical assignments; tie-break determinism pinned.
- Freeze test extended: the two new `Tuning` fields' defaults pinned;
  fingerprint changes vs the evidence track's value (a test asserts the OLD
  fingerprint constant no longer matches — semantics changed, disclosure
  works).
- `evaluate`: synthetic fixture rides exercising every scoring path — hit,
  miss, false alert, false critical, empty log, no labels, multi-header,
  tolerance boundary — and the gate verdict in both directions.
- Full board suite ≥ current baseline; `npm run check` green (docs only on
  the TS side).

### Manual — on the board / on a ride

1. Bench mini-ride: shadow on, a few minutes, then `tools/evaluate.py` on the
   unlabelled ride → exits with the labelling instructions (the honest path).
2. The real acceptance is the first labelled ride: protocol followed,
   `tools/label.py` windows added, `evaluate.py` produces the ride's M1
   numbers with fingerprints. This requires a human on a bike and is the
   track's exit into the tuning phase, not a pre-merge gate.

## Acceptance criteria

- All three structural fixes in with their discriminating tests; behavior at
  nominal frame rate otherwise preserved (golden tests prove it).
- `evaluate.py` scores synthetic fixtures correctly and refuses to invent
  numbers on missing inputs.
- README protocol section present; TTC/ego/corridor docs truthful.
- Board suite green at or above baseline; repo gate green.
- New fingerprint in effect and disclosed (freeze + fingerprint-change tests).
