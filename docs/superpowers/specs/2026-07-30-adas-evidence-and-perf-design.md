# ADAS Evidence & Performance — Design

## Summary

Shadow mode exists to produce the evidence that will one day arm alert audio,
and today that evidence has two structural defects. A shadow record does not
say which thresholds produced it, so two rides logged either side of a tuning
change are silently incomparable — the exact comparison the M1 gate requires.
And the record's `segment`/`segment_offset_ms` come from arithmetic on rebased
frame time while the recorder cuts segments on its own monotonic clock (which
deliberately rebases on late rolls), so `tools/clip.py` can extract the wrong
footage for the very alert a human is trying to judge. Evidence that cites the
wrong video is worse than no evidence.

Alongside those, two measured performance sinks on a board that plateaus at
94 °C during a shadow ride: the `FrameBuffer` JPEG cache never hits under real
load (`put()` invalidates at ~24 fps while an encode costs ~60 ms, so recorder
plus preview pay ~30 full 1080p encodes/s), and `Track.samples` grows without
bound while `smoothed_heights` re-walks the entire history three times per
track per frame.

This track fixes the evidence pipeline and buys the headroom back. It
deliberately does **not** touch the detection algorithms themselves — tuning
those requires exactly the trustworthy corpus this track creates.

## Scope

### Goals

- Every shadow record names the tuning constants that produced it, and every
  shadow log carries the full constant set it ran under.
- An alert's `segment` + `segment_offset_ms` resolve to the footage the
  detector actually saw, regardless of startup skew or late segment rolls.
- Threshold sweeps no longer require editing source — the constants are
  injectable, honouring `threat.py`'s own docstring promise.
- JPEG encode load during a ride drops from ~30/s to ≤10/s shared across
  consumers.
- Per-track memory and the TTC/dwell walk are bounded by a sliding window.
- The BPU output copy (~9.4 MB per inference) is eliminated.
- `catalog.py` matches `shared/adas.ts` exactly, and a test keeps it matched.

### Non-goals

- Algorithm changes: ego-motion axis coverage, tracker association order,
  corridor perspective/lean modelling, TTC physicality. All need corpus data
  to validate; they are the track after this one.
- Unifying `tools/replay.py`'s duplicated driver with `adas/runtime.py`.
- The H.264 encoder path, corpus labelling tooling, or arming alert audio.
- Re-rendering the on-board alert WAVs (stale after the catalog alignment;
  audio is locked by `MAX_ADAS_AUDIO=0`, so nothing wrong reaches ears — the
  one-command re-render happens whenever `DOUBAO_TTS_*` credentials are next
  at hand).
- Fixing clip extraction's pre-window clamp at a segment boundary
  (pre-existing, documented limitation).

## The tuning module — one place constants live

New module `rdk/vision/adas/tuning.py`:

```python
@dataclass(frozen=True)
class Tuning:
    # threat.py
    ttc_forward_collision_s: float = 2.0
    ttc_pedestrian_ahead_s: float = 2.5
    ttc_rear_approach_s: float = 3.0
    closing_rate_min: float = 0.08
    tailgate_height_frac: float = 0.45
    tailgate_dwell_s: float = 4.0
    corridor_width_frac: float = 0.5
    # ttc.py
    smoothing_tau_ms: float = 200.0
    ttc_window_ms: int = 300
    # suppress.py (the Suppressor constructor's existing parameters)
    min_track_frames: int = 3
    min_ttc_frames: int = 3
    global_gap_s: float = 4.0
    per_track_gap_s: float = 10.0
    max_alerts_per_minute: int = 6
    # tracker
    iou_threshold: float = 0.3
    max_misses: int = 3
    max_gap_ms: int = 500
    # new — see "Bounded track history"
    track_window_ms: int = 6_000

DEFAULT = Tuning()

def fingerprint(tuning: Tuning = DEFAULT) -> str:
    """First 12 hex chars of sha256 over the canonical JSON of asdict(tuning)."""
```

(The suppressor field names above follow whatever `Suppressor.__init__`
actually calls them — the plan copies the real names; the dataclass is the
single source, the constructor keeps its signature.)

`threat.py`'s module-level constants become the `DEFAULT` values; `evaluate`,
`in_corridor` and `_dwell_s` take `tuning: Tuning = DEFAULT`. `ttc.py`'s
`smoothed_heights`/`height_rate`/`time_to_contact` keep their parameter seams
but their defaults come from `DEFAULT`. `adas/runtime.py` constructs
`Tracker` and `Suppressor` from a `Tuning` on `RuntimeConfig` (default
`DEFAULT`) and passes it to `evaluate`. Behaviour with defaults is
bit-identical to today — this is a seam, not a retune.

## Version-stamped shadow evidence

- `ShadowLog.__init__` gains `tuning: Tuning | None = None`. When given, it
  writes one header line on open:
  `{"shadow_header": 1, "fingerprint": "<12hex>", "tuning": {…full asdict…}}`.
  A restart mid-ride appends a second header, which is a feature: the log then
  records exactly which constants govern which records.
- `ShadowRecord` gains `tuning: str = ""` — the 12-char fingerprint. The
  default keeps `read_shadow` compatible with pre-existing logs.
- `read_shadow` skips header lines. New `read_tuning(path)` returns the list
  of header dicts for offline analysis.
- `tools/replay.py`'s `summary.json` carries `"tuning_fingerprint"` alongside
  the existing `tuning_status` prose, from the same `fingerprint()` call.

Two shadow logs are now comparable iff their fingerprints match, and the full
constant set travels with the evidence.

## Recorder-authoritative alert→segment mapping

New small class in `rdk/vision/recorder/segmenter.py` (it is the segment
authority already):

```python
class SegmentClock:
    """The recorder's live answer to "which segment is being written right
    now, and when did it start?" — thread-safe, one writer, many readers."""
    def update(self, segment_name: str, started_wall_ms: int) -> None: ...
    def current(self) -> tuple[str, int] | None: ...  # None before first roll
```

- The ride recorder calls `update(...)` at every actual roll, stamping wall
  time then. `ride.py` owns one `SegmentClock` per camera and passes it into
  the ADAS runtime via `RuntimeConfig`.
- At alert time, `run_camera` stamps `wall_ms = int(time.time() * 1000)`
  **once** and derives `segment, started = clock.current()`;
  `segment_offset_ms = wall_ms - started`. The rebased-frame-time arithmetic
  and `RuntimeConfig.segment_pattern` (the default that matches nothing) are
  deleted; `RuntimeConfig.segment_seconds` goes with them.
- `clock.current() is None` (alert before the first roll completes, or a
  runtime wired without a recorder clock in a test): the record is still
  written, with `segment = ""` and `segment_offset_ms = -1`, and one warning
  line is printed. An alert is never dropped over bookkeeping.
- `tools/replay.py`'s file-fed driver names its input file directly, as it
  already does; it needs no clock.

Correct by construction against both failure modes: startup skew (the clock
starts when the recorder actually starts, not when the first ADAS frame
arrives) and late-roll drift (the clock is updated with the real roll time the
`Segmenter` rebased to). Precision: `wall_ms` is stamped within ~100 ms of the
frame, irrelevant against `clip.py`'s ±5 s/±3 s window.

## Rate-limited JPEG cache

`FrameBuffer.jpeg()` gains `max_age_ms: float | None = None` and the buffer
stamps `_jpeg_at` (monotonic) when an encode completes:

- `max_age_ms=None` — today's exact semantics: cached only if the JPEG belongs
  to the current frame. `capture_photo` stays on this path.
- `max_age_ms=100` — return the cached JPEG when it is younger than 100 ms
  even if a newer frame has arrived. The recording loop, `/preview/*`, and
  `/frame/*` (via `MipiCamera.jpeg(...)` / `CameraPair._grab(...)` gaining the
  same pass-through parameter) opt in.

At 24 fps capture, a ≤100 ms-stale frame is within one 10 fps recording
period; consumers collapse from ~30 independent encodes/s to at most 10 shared.
The encode-outside-the-lock pattern is untouched — only the cache-hit
predicate changes.

## Bounded track history

`Tracker.update` trims each track after appending:
`track.samples` keeps only samples with `t_ms - sample.t_ms <=
tuning.track_window_ms` (6 000 ms). The derivation is documented where the
constant lives: the longest look-back any rule makes is `tailgate_dwell_s`
(4 s), plus margin; the 300 ms TTC window is trivially inside; an EMA at
tau=200 ms weights anything older than 1 s below one percent, so trimming
changes `smoothed_heights` by less than measurement noise. A ten-minute tail
falls from ~6 000 samples walked three times per frame to ≤ ~145.

Consequence made explicit in the tailgating rule's test: observable dwell is
capped at the window, so `track_window_ms` must exceed `tailgate_dwell_s` —
the `Tuning` dataclass enforces it in `__post_init__` with a `ValueError`.

## BPU output copy

`perception/detector.py`: the three `np.array(o.buffer)` head copies become
`np.asarray(o.buffer)`. The arrays are consumed read-only within the same
inference call (letterbox allocates fresh buffers; postprocess only reads), so
aliasing the vendor buffer is safe for the lifetime it is used. ~9.4 MB of
memcpy per inference removed (~190 MB/s at two cameras × 10 fps).

## Catalog alignment — `shared/adas.ts` is canonical

`catalog.py`'s `message`/`advice` strings for `pedestrian_ahead` and
`tailgating` have drifted from `shared/adas.ts`. The TS catalog is canonical
(it is what clients display and the server validates); `catalog.py` conforms:
every `direction`/`label`/`message`/`advice` is updated to match the TS entry
for the four v1 threats, and the stale module docstring (which still claims
the two ids are missing TS-side) is rewritten.

A new board-safe test mirrors `test_labels.py`'s pattern: it parses
`shared/adas.ts` (skipping when the file is absent, i.e. when the vision tree
is deployed alone to the board) and asserts every `catalog.py` entry matches
the TS entry field-for-field. Drift becomes a red test on the dev machine
instead of a hand-maintained promise.

The board's pre-rendered WAVs are stale after this; see Non-goals.

## Error handling

| Condition | Behaviour |
| --- | --- |
| Alert before the first segment roll | Record written with `segment=""`, `offset=-1`, one warning line |
| Old headerless shadow log read | `read_shadow` returns records as today; `read_tuning` returns `[]` |
| Restart mid-ride | Second header line appended; records after it carry the (possibly new) fingerprint |
| `track_window_ms <= tailgate_dwell_s * 1000` | `Tuning.__post_init__` raises `ValueError` at construction |
| Encoder fails under `max_age_ms` | Same as today: `jpeg()` returns None, no stale value served past its window |

## Verification

### Automated — board pytest

- `tuning`: fingerprint stability (same values → same hex; one field changed →
  different), `__post_init__` guard, defaults bit-match the old module
  constants (a test freezes today's values).
- `shadow`: header round-trip (`read_tuning`), `read_shadow` skips headers and
  reads old headerless logs, records carry the fingerprint.
- `SegmentClock`: threaded update/read; runtime mapping against a simulated
  late roll (roll at t=61.5 s → alert at t=62 s cites segment 1 offset
  ~500 ms, where the old arithmetic said offset 2 000 ms); the `None` path.
- Tracker trim: samples bounded; dwell of exactly `tailgate_dwell_s` still
  fires tailgating inside the window; EMA parity test (trimmed vs untrimmed
  history within 1% on a synthetic approach).
- FrameBuffer: `max_age_ms` hit/miss with an injected clock; `None` keeps
  exact-frame semantics; photo path unchanged.
- Catalog drift test: asserts `catalog.py` matches `shared/adas.ts`
  field-for-field, skipping when the TS file is absent. Because pytest runs on
  the board and only `rdk/vision` is normally synced there, the plan's board
  test task also syncs `shared/adas.ts` beside the vision tree once, so the
  test runs un-skipped at least once per change; thereafter it guards any
  environment where the full checkout and pytest coexist.
- Replay: summary carries `tuning_fingerprint`.

### Manual — on the board

1. A short bench shadow ride with `MAX_ADAS_SHADOW=1`; drive a synthetic
   approach (the `bus.jpg` zoompan from M1) or wave at the camera; for each
   logged alert, run `tools/clip.py` and confirm the extracted clip shows the
   triggering scene (the M1-era bug this fixes made it show the wrong moment).
2. Read the shadow log: header present, fingerprint on every record, segment
   names matching the ride directory's actual files.
3. Encode-rate/thermal spot check: during recording + one preview client,
   CPU temperature after 10 minutes compared against the ~94 °C baseline from
   `rdk/README.md`; expect a measurable drop (target: ≥5 °C, but record
   whatever is measured — the number itself is the deliverable).

## Acceptance criteria

- A shadow alert's clip provably shows the alerting scene on hardware.
- Shadow logs are self-describing: full constants + per-record fingerprint.
- Board pytest suite green (existing 312 + new); `npm run check` green.
- Measured encode-rate reduction during ride+preview, and the thermal reading
  recorded in the README's findings table.
- `catalog.py` matches `shared/adas.ts` with a test enforcing it.
