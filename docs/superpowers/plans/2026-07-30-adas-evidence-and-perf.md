# ADAS Evidence & Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shadow-ride corpus trustworthy (version-stamped records, recorder-authoritative alert→segment mapping) and buy back measured thermal/CPU headroom (JPEG cache rate-limit, bounded track history, BPU copy removal), with the alert catalog aligned to `shared/adas.ts` under a drift test.

**Architecture:** One new `Tuning` dataclass becomes the single home of every alert-affecting constant, threaded through the pure modules as defaulted parameters (bit-identical behavior at defaults). The recorder — the only component that knows where segments really start — publishes a thread-safe `SegmentClock` the runtime queries at alert time, replacing parallel arithmetic. Perf fixes are local: a stale-tolerant JPEG cache path, a sliding-window trim in the tracker, one `np.array`→`np.asarray`.

**Tech Stack:** Python 3.10 stdlib (vision sidecar; tests run **on the board** via pytest over SSH), TypeScript only as a read-only string source for the catalog task.

**Spec:** `docs/superpowers/specs/2026-07-30-adas-evidence-and-perf-design.md`

## Global Constraints

- **Vision pytest runs on the board, not the dev Mac.** Cycle: `scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/` then `ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/<file> -q'`. Board IP is network-dependent (`10.42.0.11` as of 2026-07-30); rediscover with `arp -a` → `nc -G 2 -z <ip> 22` → confirm `ssh root@<ip> 'ls /usr/hobot'`. Do not restart board services during implementation tasks.
- **Behavior at defaults must be bit-identical** until someone deliberately changes a `Tuning` value: the freeze test in Task 1 pins today's constants; no threshold value may change in this track.
- No new dependencies. Python stdlib only; `numpy` already on the board.
- Log convention `[tag] message` via `print(..., flush=True)`.
- `shared/adas.ts` is canonical for catalog strings; `catalog.py` conforms — never the reverse.
- Commit after every task; work on branch `feat/adas-evidence-and-perf`.
- Full board suite is currently **312 passed**; it must never drop below that.

---

### Task 1: The Tuning dataclass and fingerprint

**Files:**

- Create: `rdk/vision/adas/tuning.py`
- Test: `rdk/vision/tests/test_tuning.py` (create)

**Interfaces:**

- Produces: `Tuning` (frozen dataclass, 17 fields below), `DEFAULT: Tuning`, `fingerprint(tuning: Tuning = DEFAULT) -> str` (12 hex chars). Every later task imports from `adas.tuning`.

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_tuning.py` (standard preamble used by every test file in this directory):

```python
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from adas.tuning import DEFAULT, Tuning, fingerprint


def test_defaults_freeze_todays_constants():
    """This test is the guarantee that introducing the seam changed nothing.
    Every value here is copied from the module constants this dataclass
    replaced. Changing any of them is a deliberate retune, not a refactor."""
    assert DEFAULT.ttc_forward_collision_s == 2.0
    assert DEFAULT.ttc_pedestrian_ahead_s == 2.5
    assert DEFAULT.ttc_rear_approach_s == 3.0
    assert DEFAULT.closing_rate_min == 0.08
    assert DEFAULT.tailgate_height_frac == 0.45
    assert DEFAULT.tailgate_dwell_s == 4.0
    assert DEFAULT.corridor_width_frac == 0.5
    assert DEFAULT.smoothing_tau_ms == 200.0
    assert DEFAULT.ttc_window_ms == 300
    assert DEFAULT.min_track_frames == 3
    assert DEFAULT.min_ttc_frames == 3
    assert DEFAULT.threat_cooldown_s == 8.0
    assert DEFAULT.global_gap_s == 4.0
    assert DEFAULT.iou_threshold == 0.3
    assert DEFAULT.max_misses == 3
    assert DEFAULT.max_gap_ms == 500
    assert DEFAULT.track_window_ms == 6_000


def test_fingerprint_is_stable_and_sensitive():
    assert fingerprint() == fingerprint(Tuning())
    assert len(fingerprint()) == 12
    changed = replace(DEFAULT, ttc_forward_collision_s=2.1)
    assert fingerprint(changed) != fingerprint()


def test_window_must_exceed_tailgate_dwell():
    with pytest.raises(ValueError):
        Tuning(track_window_ms=4_000)  # equal to dwell*1000 → invalid
    with pytest.raises(ValueError):
        Tuning(tailgate_dwell_s=7.0)  # dwell pushed past the default window
```

- [ ] **Step 2: Deploy and run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tuning.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'adas.tuning'`.

- [ ] **Step 3: Create `rdk/vision/adas/tuning.py`**

```python
"""Every alert-affecting constant, in one frozen dataclass with a fingerprint.

Two shadow logs are comparable iff their fingerprints match. Before this
module, the constants lived spread across threat.py, ttc.py, suppress.py and
the Tracker defaults, and a ride recorded before a threshold change was
indistinguishable from one recorded after — the exact comparison the M1 gate
needs. The dataclass is also the injection seam threat.py's docstring always
promised: a sweep passes a Tuning, it does not edit source.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass


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
    # suppress.py
    min_track_frames: int = 3
    min_ttc_frames: int = 3
    threat_cooldown_s: float = 8.0
    global_gap_s: float = 4.0
    # perception/tracker.py
    iou_threshold: float = 0.3
    max_misses: int = 3
    max_gap_ms: int = 500
    #: Sliding window on Track.samples. Must exceed tailgate_dwell_s — the
    #: longest look-back any rule makes — because the window caps observable
    #: dwell, and a cap at or below the threshold means tailgating can never
    #: fire. The 300 ms TTC window is trivially inside. EMA at tau=200 ms
    #: weights anything older than 1 s below one percent, so trimming here
    #: changes smoothed heights by less than measurement noise.
    track_window_ms: int = 6_000

    def __post_init__(self) -> None:
        if self.track_window_ms <= self.tailgate_dwell_s * 1000:
            raise ValueError(
                "track_window_ms must exceed tailgate_dwell_s * 1000: the "
                "window caps observable dwell, and a cap at or below the "
                "threshold can never fire tailgating"
            )


DEFAULT = Tuning()


def fingerprint(tuning: Tuning = DEFAULT) -> str:
    """12 hex chars identifying a constant set. Stable across processes."""
    payload = json.dumps(asdict(tuning), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
```

- [ ] **Step 4: Deploy and run on the board to verify they pass**

Same commands as Step 2. Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/tuning.py rdk/vision/tests/test_tuning.py
git commit -m "feat(adas): one frozen dataclass for every alert-affecting constant"
```

---

### Task 2: Thread Tuning through the pure modules (threat, ttc)

**Files:**

- Modify: `rdk/vision/adas/threat.py`, `rdk/vision/adas/ttc.py`
- Test: `rdk/vision/tests/test_threat.py`, `rdk/vision/tests/test_ttc.py` (extend)

**Interfaces:**

- Consumes: `Tuning`, `DEFAULT` from Task 1.
- Produces: `evaluate(tracks, ego, t_ms, camera, tuning: Tuning = DEFAULT)`; `in_corridor(track, tuning: Tuning = DEFAULT)`; `smoothed_heights(track, tau_ms: float = DEFAULT.smoothing_tau_ms)`; `height_rate(track, window_ms: int = DEFAULT.ttc_window_ms, tau_ms: float = DEFAULT.smoothing_tau_ms)`; `time_to_contact(track, window_ms: int = DEFAULT.ttc_window_ms, tau_ms: float = DEFAULT.smoothing_tau_ms)`. Module-level constant names in `threat.py`/`ttc.py` remain as aliases of the `DEFAULT` fields so existing imports keep working.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_threat.py` (reuse that file's existing track/ego construction helpers — it builds `Track`s with `BoxSample` lists; mirror the nearest existing test's fixture style):

```python
from dataclasses import replace as _replace

from adas.tuning import DEFAULT


def test_evaluate_accepts_an_injected_tuning():
    # A corridor so narrow nothing qualifies: same tracks, zero candidates.
    # Uses whichever existing helper builds a centred approaching vehicle
    # track (see this file's forward-collision tests) — the point is only
    # that the tuning parameter is honoured.
    tracks, ego, t_ms = _make_forward_collision_scene()  # existing helper/fixture pattern
    assert evaluate(tracks, ego, t_ms, "front") != []
    narrow = _replace(DEFAULT, corridor_width_frac=0.0)
    assert evaluate(tracks, ego, t_ms, "front", tuning=narrow) == []
```

(If `test_threat.py` has no single reusable scene helper, inline the same track construction its existing forward-collision test uses — copy those exact lines rather than inventing a new fixture.)

Add to `rdk/vision/tests/test_ttc.py`:

```python
from adas.tuning import DEFAULT


def test_defaults_come_from_tuning():
    import inspect

    from adas.ttc import height_rate, smoothed_heights, time_to_contact

    assert inspect.signature(smoothed_heights).parameters["tau_ms"].default == DEFAULT.smoothing_tau_ms
    assert inspect.signature(height_rate).parameters["window_ms"].default == DEFAULT.ttc_window_ms
    assert inspect.signature(time_to_contact).parameters["window_ms"].default == DEFAULT.ttc_window_ms
```

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_threat.py tests/test_ttc.py -q'
```

Expected: the new tests FAIL (`evaluate` has no `tuning` parameter; ttc defaults are literals — the signature test may pass by numeric equality for `SMOOTHING_TAU_MS`; if a signature test passes trivially, note it and keep it as a pin).

- [ ] **Step 3: Implement**

`ttc.py`: add `from .tuning import DEFAULT` and change the three signatures:

```python
def smoothed_heights(track: Track, tau_ms: float = DEFAULT.smoothing_tau_ms) -> list[tuple[int, float]]:
def height_rate(track: Track, window_ms: int = DEFAULT.ttc_window_ms, tau_ms: float = DEFAULT.smoothing_tau_ms) -> float | None:
def time_to_contact(track: Track, window_ms: int = DEFAULT.ttc_window_ms, tau_ms: float = DEFAULT.smoothing_tau_ms) -> float | None:
```

`height_rate` passes `tau_ms` into `smoothed_heights(track, tau_ms)`; `time_to_contact` passes both down (`height_rate(track, window_ms, tau_ms)`, and its final height read uses `smoothed_heights(track, tau_ms)[-1][1]`). Keep `SMOOTHING_TAU_MS = DEFAULT.smoothing_tau_ms` as an alias.

`threat.py`: replace the module constants with aliases and thread the parameter:

```python
from .tuning import DEFAULT, Tuning

TTC_FORWARD_COLLISION = DEFAULT.ttc_forward_collision_s
TTC_PEDESTRIAN_AHEAD = DEFAULT.ttc_pedestrian_ahead_s
TTC_REAR_APPROACH = DEFAULT.ttc_rear_approach_s
CLOSING_RATE_MIN = DEFAULT.closing_rate_min
TAILGATE_HEIGHT_FRAC = DEFAULT.tailgate_height_frac
TAILGATE_DWELL_S = DEFAULT.tailgate_dwell_s
CORRIDOR_WIDTH_FRAC = DEFAULT.corridor_width_frac
```

`in_corridor(track: Track, tuning: Tuning = DEFAULT) -> bool` uses `tuning.corridor_width_frac` (delete the old `width_frac` parameter; fix any test that passed it positionally to construct a `Tuning` via `dataclasses.replace(DEFAULT, corridor_width_frac=...)` instead — report every such change). `evaluate(tracks, ego, t_ms, camera, tuning: Tuning = DEFAULT)` uses `tuning.*` for every threshold and passes `window_ms=tuning.ttc_window_ms, tau_ms=tuning.smoothing_tau_ms` to `time_to_contact`/`height_rate`. `_dwell_s` keeps its `(track, min_height)` signature — callers pass `tuning.tailgate_height_frac`; the dwell comparison uses `tuning.tailgate_dwell_s`. The module docstring's "every constant here is a STARTING VALUE" paragraph moves the pointer: constants now live in `tuning.py`.

- [ ] **Step 4: Run the full pure-module tests on the board**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_threat.py tests/test_ttc.py tests/test_suppress.py -q'
```

Expected: all pass, including every pre-existing test (defaults are bit-identical).

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/threat.py rdk/vision/adas/ttc.py rdk/vision/tests/test_threat.py rdk/vision/tests/test_ttc.py
git commit -m "feat(adas): threat and ttc read their thresholds from an injectable Tuning"
```

---

### Task 3: Runtime constructs everything from Tuning

**Files:**

- Modify: `rdk/vision/adas/runtime.py`, `rdk/vision/ride.py`
- Test: `rdk/vision/tests/test_runtime.py` (extend)

**Interfaces:**

- Consumes: `Tuning`, `DEFAULT`, `fingerprint` (Task 1); `evaluate(..., tuning=...)` (Task 2).
- Produces: `RuntimeConfig` gains `tuning: Tuning = DEFAULT` (Task 6 adds `segment_clock`; Task 9's tracker window also flows from here). `run_camera` builds `Tracker(iou_threshold=config.tuning.iou_threshold, max_misses=config.tuning.max_misses, max_gap_ms=config.tuning.max_gap_ms)` and `Suppressor(min_track_frames=config.tuning.min_track_frames, min_ttc_frames=config.tuning.min_ttc_frames, threat_cooldown_s=config.tuning.threat_cooldown_s, global_gap_s=config.tuning.global_gap_s)`, and calls `evaluate(tracks, ego, frame.t_ms, config.camera, tuning=config.tuning)`.

- [ ] **Step 1: Write the failing test**

Add to `rdk/vision/tests/test_runtime.py` (mirror its existing `RuntimeConfig`/fake-source construction — it drives `run_camera` with `config.detect` fakes and a `ShadowLog` on tmp_path):

```python
from dataclasses import replace

from adas.tuning import DEFAULT


def test_runtime_builds_suppressor_from_tuning(tmp_path):
    # min_ttc_frames raised to an unreachable 99: the same scene that fires
    # an alert under DEFAULT must fire none.
    strict = replace(DEFAULT, min_ttc_frames=99)
    # ... construct the same config/source/shadow the file's existing
    # fires-an-alert test uses (copy those lines), but with tuning=strict ...
    assert fired == 0
```

(Copy the existing alert-firing test's setup verbatim and change only the tuning; assert its original version still fires under DEFAULT — that pair proves the wiring.)

- [ ] **Step 2: Run on the board to verify it fails**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_runtime.py -q'
```

Expected: FAIL — `RuntimeConfig` has no `tuning` field.

- [ ] **Step 3: Implement**

`runtime.py`: `RuntimeConfig` gains `tuning: Tuning = DEFAULT` (import from `.tuning`). In `run_camera`, replace `Tracker()` and `Suppressor()` with the tuning-driven constructions from the Interfaces block, and pass `tuning=config.tuning` to `evaluate`. `ride.py`: pass `tuning=DEFAULT` explicitly in its `RuntimeConfig(...)` construction (self-documenting call site; the value is unchanged).

- [ ] **Step 4: Run on the board to verify green**

Same command. Expected: all `test_runtime.py` tests pass.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/runtime.py rdk/vision/ride.py rdk/vision/tests/test_runtime.py
git commit -m "feat(adas): the runtime assembles tracker, suppressor and rules from one Tuning"
```

---

### Task 4: Version-stamped shadow logs

**Files:**

- Modify: `rdk/vision/adas/shadow.py`, `rdk/vision/adas/runtime.py`, `rdk/vision/service.py` (the `start_adas` ShadowLog construction)
- Test: `rdk/vision/tests/test_shadow.py` (extend)

**Interfaces:**

- Consumes: `Tuning`, `DEFAULT`, `fingerprint` (Task 1).
- Produces: `ShadowLog(path, tuning: Tuning | None = None)` — writes one header line on open when `tuning` is given; `ShadowRecord.tuning: str = ""` (new last field); `read_shadow(path)` skips headers; `read_tuning(path) -> list[dict]` returns them. `run_camera` stamps `tuning=fingerprint(config.tuning)` on every record; `service.start_adas` passes the config's tuning into `ShadowLog`.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_shadow.py` (it already round-trips `ShadowRecord`s through a tmp_path log — reuse its record-construction helper):

```python
from adas.tuning import DEFAULT, fingerprint
from adas.shadow import ShadowLog, read_shadow, read_tuning


def test_header_written_once_per_open_and_skipped_by_read(tmp_path):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path, tuning=DEFAULT) as log:
        log.append(_record())  # the file's existing record helper
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    assert '"shadow_header"' in lines[0]
    assert read_shadow(path)[0].threat_id == _record().threat_id
    headers = read_tuning(path)
    assert headers[0]["fingerprint"] == fingerprint(DEFAULT)
    assert headers[0]["tuning"]["ttc_forward_collision_s"] == 2.0


def test_restart_appends_a_second_header(tmp_path):
    path = tmp_path / "shadow.jsonl"
    with ShadowLog(path, tuning=DEFAULT):
        pass
    with ShadowLog(path, tuning=DEFAULT):
        pass
    assert len(read_tuning(path)) == 2


def test_old_headerless_logs_still_read(tmp_path):
    path = tmp_path / "old.jsonl"
    with ShadowLog(path) as log:  # no tuning → no header, like every old log
        log.append(_record())
    assert len(read_shadow(path)) == 1
    assert read_tuning(path) == []
    assert read_shadow(path)[0].tuning == ""  # default for the new field
```

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_shadow.py -q'
```

Expected: FAIL — `ShadowLog` takes no `tuning`; `read_tuning` undefined.

- [ ] **Step 3: Implement in `shadow.py`**

```python
from .tuning import Tuning, fingerprint as tuning_fingerprint
```

`ShadowRecord` gains, after `latency_ms`:

```python
    #: 12-hex fingerprint of the Tuning that produced this record. "" on
    #: records written before fingerprints existed.
    tuning: str = ""
```

`ShadowLog.__init__(self, path, tuning: Tuning | None = None)`: after opening the file, when `tuning is not None`:

```python
        if tuning is not None:
            from dataclasses import asdict as _asdict

            header = {
                "shadow_header": 1,
                "fingerprint": tuning_fingerprint(tuning),
                "tuning": _asdict(tuning),
            }
            # A restart mid-ride appends a second header. That is a feature:
            # the log then records exactly which constants govern which records.
            self._fh.write(json.dumps(header, ensure_ascii=False) + "\n")
            self._fh.flush()
```

`read_shadow`: skip header lines —

```python
    records = []
    for line in text.split("\n"):
        data = json.loads(line)
        if "shadow_header" in data:
            continue
        records.append(ShadowRecord(**data))
    return records
```

New:

```python
def read_tuning(path: Path | str) -> list[dict]:
    """The header lines, in order. Empty for pre-fingerprint logs."""
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        return []
    return [json.loads(line) for line in text.split("\n") if '"shadow_header"' in line]
```

`runtime.py`: at the top of `run_camera`, `record_fingerprint = fingerprint(config.tuning)` (import from `.tuning`); every `ShadowRecord(...)` gains `tuning=record_fingerprint`. `service.py`'s `start_adas`: `ShadowLog(Path(shadow_path), tuning=config.tuning)`.

- [ ] **Step 4: Run the affected files on the board**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_shadow.py tests/test_runtime.py tests/test_service_hazard.py -q'
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/shadow.py rdk/vision/adas/runtime.py rdk/vision/service.py rdk/vision/tests/test_shadow.py
git commit -m "feat(adas): shadow logs carry their tuning, whole and fingerprinted"
```

---

### Task 5: SegmentClock, published by the recorder

**Files:**

- Modify: `rdk/vision/recorder/segmenter.py`, `rdk/vision/recorder/session.py`
- Test: `rdk/vision/tests/test_segmenter.py`, `rdk/vision/tests/test_session.py` (extend)

**Interfaces:**

- Consumes: nothing new.
- Produces: `SegmentClock` in `recorder/segmenter.py` — `update(segment_name: str, started_wall_ms: int) -> None`, `current() -> tuple[str, int] | None` (None before the first roll), thread-safe. `RideRecorder.__init__` gains `clocks: dict[str, SegmentClock] | None = None`; `_open_segment` calls `clocks[camera].update(<relative segment path>, int(time.time() * 1000))` after every roll. The segment name passed to the clock is the path **relative to the ride directory** of the file the writer actually creates (e.g. `front/seg-000001.mjpeg`) — exactly what `tools/clip.py` joins against `--segments`.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_segmenter.py`:

```python
import threading

from recorder.segmenter import SegmentClock


def test_clock_is_none_before_any_roll():
    assert SegmentClock().current() is None


def test_clock_returns_the_latest_update():
    clock = SegmentClock()
    clock.update("front/seg-000000.mjpeg", 1_000)
    clock.update("front/seg-000001.mjpeg", 61_500)
    assert clock.current() == ("front/seg-000001.mjpeg", 61_500)


def test_clock_survives_concurrent_readers():
    clock = SegmentClock()
    stop = threading.Event()

    def hammer():
        i = 0
        while not stop.is_set():
            clock.update(f"front/seg-{i:06d}.mjpeg", i)
            i += 1

    writer = threading.Thread(target=hammer, daemon=True)
    writer.start()
    for _ in range(10_000):
        current = clock.current()
        assert current is None or current[0].endswith(".mjpeg")
    stop.set()
    writer.join(timeout=2.0)
```

Add to `rdk/vision/tests/test_session.py` (reuse its existing fake-camera/recorder fixtures — it already drives `RideRecorder` ticks with a controlled clock):

```python
from recorder.segmenter import SegmentClock


def test_recorder_publishes_each_roll_to_the_clock(tmp_path):
    clock = SegmentClock()
    # Construct RideRecorder exactly as this file's existing tick test does,
    # adding clocks={"front": clock}; start it and tick once.
    ...
    name, started_wall_ms = clock.current()
    # The clock names a file the recorder actually created:
    assert (ride_dir / name).exists()
    assert started_wall_ms > 0
```

(The `...` is the file's existing construction/tick lines, copied — the two assertions after it are the deliverable. The exists() assertion is what pins the exact-relative-path contract, whatever suffix the writer uses.)

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_segmenter.py tests/test_session.py -q'
```

Expected: FAIL — `SegmentClock` does not exist.

- [ ] **Step 3: Implement**

`segmenter.py` (add `import threading` and `import time` is NOT needed here — wall stamping happens at the call site):

```python
class SegmentClock:
    """The recorder's live answer to "which segment is being written right now,
    and when did it start?" — one writer (the recorder), many readers (the
    ADAS runtime at alert time). The recorder is the only component that knows
    real segment boundaries: Segmenter.roll rebases on late rolls, so anything
    computing boundaries arithmetically drifts from the files on disk."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._current: tuple[str, int] | None = None

    def update(self, segment_name: str, started_wall_ms: int) -> None:
        with self._lock:
            self._current = (segment_name, started_wall_ms)

    def current(self) -> tuple[str, int] | None:
        with self._lock:
            return self._current
```

`session.py`: `RideRecorder.__init__` gains `clocks: dict[str, SegmentClock] | None = None`, stored as `self._clocks`. In `_open_segment(camera, now_s)`, after the roll and after the writer's target path for the segment is known, publish it (derive `relative` from the writer's real file path — `<camera>/<segment_name(index)><suffix>` with whatever suffix the writer appends; read the surrounding code and use the same expression it uses to build the filename, do not hardcode a second copy of the suffix logic if it can be referenced):

```python
        if self._clocks is not None and camera in self._clocks:
            self._clocks[camera].update(relative, int(time.time() * 1000))
```

(`import time` at the top of `session.py` if not present.)

- [ ] **Step 4: Run on the board to verify green**

Same command. Expected: all pass, including every pre-existing segmenter/session test.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/recorder/segmenter.py rdk/vision/recorder/session.py rdk/vision/tests/test_segmenter.py rdk/vision/tests/test_session.py
git commit -m "feat(vision): the recorder publishes real segment starts on a SegmentClock"
```

---

### Task 6: The runtime maps alerts through the clock

**Files:**

- Modify: `rdk/vision/adas/runtime.py`, `rdk/vision/ride.py`
- Test: `rdk/vision/tests/test_runtime.py` (extend), `rdk/vision/tests/test_ride.py` (extend if it asserts config wiring)

**Interfaces:**

- Consumes: `SegmentClock` (Task 5), `RuntimeConfig.tuning` (Task 3).
- Produces: `RuntimeConfig` gains `segment_clock: SegmentClock | None = None` and **loses** `segment_pattern` and `segment_seconds`. The alert block stamps `wall_ms = int(time.time() * 1000)` once and derives `segment`/`segment_offset_ms` from `config.segment_clock.current()`; `None` → `segment=""`, `segment_offset_ms=-1`, one warning line `[adas] <camera>: alert before any segment roll; segment unknown`.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_runtime.py`:

```python
from recorder.segmenter import SegmentClock


def test_alert_cites_the_recorders_segment_not_arithmetic(tmp_path):
    clock = SegmentClock()
    # Simulate a LATE second roll: ideal boundary at 60s, real roll at 61.5s.
    # An alert at wall-time "62s" must land in segment 1 at ~500ms offset —
    # the old frame-time arithmetic would have said offset 2000ms.
    clock.update("front/seg-000001.mjpeg", 61_500)
    # Drive run_camera exactly as this file's fires-an-alert test does,
    # with config.segment_clock=clock (copy that setup).
    ...
    record = read_shadow(shadow_path)[0]
    assert record.segment == "front/seg-000001.mjpeg"
    assert 0 <= record.segment_offset_ms < 5_000  # wall_now - 61_500, small and positive


def test_alert_before_first_roll_still_logs(tmp_path, capsys):
    # Same alert-firing setup, segment_clock=SegmentClock() (never updated).
    ...
    record = read_shadow(shadow_path)[0]
    assert record.segment == ""
    assert record.segment_offset_ms == -1
    assert "segment unknown" in capsys.readouterr().out
```

(For the first test's offset bound: the runtime stamps real wall time, so the test updates the clock with `int(time.time() * 1000) - 500` instead of the literal `61_500` — write it that way; the named constant in the comment explains the scenario.)

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_runtime.py -q'
```

Expected: FAIL — `RuntimeConfig` has no `segment_clock`.

- [ ] **Step 3: Implement**

`runtime.py`: add `segment_clock: SegmentClock | None = None` to `RuntimeConfig` (import `from recorder.segmenter import SegmentClock`); delete `segment_pattern` and `segment_seconds`. Replace the alert block's mapping:

```python
        for alert in admitted:
            track = by_id.get(alert.track_id)
            wall_ms = int(time.time() * 1000)
            current = config.segment_clock.current() if config.segment_clock else None
            if current is None:
                print(
                    f"[adas] {config.camera}: alert before any segment roll; segment unknown",
                    flush=True,
                )
                segment, segment_offset_ms = "", -1
            else:
                segment, started_wall_ms = current
                segment_offset_ms = wall_ms - started_wall_ms
            shadow.append(
                ShadowRecord(
                    ...  # unchanged fields
                    wall_ms=wall_ms,
                    segment=segment,
                    segment_offset_ms=segment_offset_ms,
                    ...
                )
            )
```

(The `...` are the existing fields, unchanged — only `wall_ms`, `segment`, `segment_offset_ms` change their derivation; `wall_ms` is stamped once and reused, where today it is computed inline in the record.)

`ride.py`: delete the `SEGMENT_PATTERN` constant and the `segment_pattern=`/`segment_seconds=` arguments; build one `SegmentClock` per open camera, pass the dict to `RideRecorder(clocks=...)` and each camera's clock to its `RuntimeConfig(segment_clock=clocks[name])`. Fix any `test_ride.py` assertions on the removed fields the same way (report them).

- [ ] **Step 4: Run on the board to verify green**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_runtime.py tests/test_ride.py tests/test_service_hazard.py -q'
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/runtime.py rdk/vision/ride.py rdk/vision/tests/test_runtime.py rdk/vision/tests/test_ride.py
git commit -m "fix(adas): alerts cite the recorder's real segments, not parallel arithmetic"
```

---

### Task 7: Replay summaries carry the fingerprint

**Files:**

- Modify: `rdk/vision/tools/replay.py`
- Test: `rdk/vision/tests/test_replay.py` (extend)

**Interfaces:**

- Consumes: `fingerprint` (Task 1).
- Produces: `summary.json` gains `"tuning_fingerprint": "<12hex>"` next to the existing `tuning_status` prose.

- [ ] **Step 1: Write the failing test**

Add to `rdk/vision/tests/test_replay.py`, next to its existing `tuning_status` assertion (the file already builds a summary through the replay path):

```python
from adas.tuning import fingerprint


def test_summary_carries_the_tuning_fingerprint(...):  # same fixture args as the tuning_status test
    ...
    assert summary["tuning_fingerprint"] == fingerprint()
```

(Copy the neighbouring `tuning_status` test's setup; only the assertion differs.)

- [ ] **Step 2: Run on the board to verify it fails**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_replay.py -q'
```

Expected: FAIL — `KeyError: 'tuning_fingerprint'`.

- [ ] **Step 3: Implement**

`replay.py`: `from adas.tuning import fingerprint` and add to the summary dict, directly above `tuning_status`:

```python
        "tuning_fingerprint": fingerprint(),
```

- [ ] **Step 4: Verify green on the board, commit**

Same command → PASS, then:

```bash
git add rdk/vision/tools/replay.py rdk/vision/tests/test_replay.py
git commit -m "feat(adas): replay summaries name the constants they ran under"
```

---

### Task 8: Rate-limited JPEG cache

**Files:**

- Modify: `rdk/vision/mipi_camera.py` (FrameBuffer + `MipiCamera.jpeg`), `rdk/vision/camera.py` (`_grab`, recording loop, photo), `rdk/vision/bench_server.py` (preview + `/frame`)
- Test: `rdk/vision/tests/test_mipi_camera.py` (extend)

**Interfaces:**

- Consumes: `FrameBuffer`'s existing injectable `clock` (added by the reliability track).
- Produces: `FrameBuffer.jpeg(max_age_ms: float | None = None)`; `MipiCamera.jpeg(max_age_ms: float | None = None)` passthrough; `CameraPair._grab(camera, max_age_ms: float | None = None)` passthrough. New module constant `JPEG_MAX_AGE_MS = 100.0` in `mipi_camera.py`. Callers: recording loop and bench preview/`/frame` pass `JPEG_MAX_AGE_MS`; `capture_photo` passes nothing (exact semantics).

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_mipi_camera.py` (its FrameBuffer tests already inject `encode` and `clock`):

```python
def test_stale_jpeg_served_within_max_age():
    encodes = []
    times = iter([0.0, 0.0, 0.05, 0.05])  # put, encode-stamp, put, read
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: next(times),
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    buffer.put(b"\x01" * 24, t_ms=42)  # invalidates the exact cache
    # 50 ms later, still inside the window: the stale encode is served.
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    assert len(encodes) == 1


def test_stale_jpeg_expires_past_max_age():
    encodes = []
    times = iter([0.0, 0.0, 0.5, 0.5, 0.5])
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: next(times),
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    buffer.put(b"\x01" * 24, t_ms=42)
    # 500 ms later: past the window, a fresh encode happens.
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    assert len(encodes) == 2


def test_default_keeps_exact_frame_semantics():
    encodes = []
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: 0.0,
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    buffer.jpeg()
    buffer.put(b"\x01" * 24, t_ms=42)
    buffer.jpeg()  # no max_age_ms: must re-encode despite zero elapsed time
    assert len(encodes) == 2
```

(If the clock-call count in the first two tests doesn't line up with the implementation's actual `self._clock()` call sites, replace the `iter` with a mutable `now = [0.0]` / `clock=lambda: now[0]` pattern and advance `now[0]` explicitly between calls — the assertions are the contract, not the call count.)

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py -q'
```

Expected: FAIL — `jpeg()` takes no `max_age_ms`.

- [ ] **Step 3: Implement in `mipi_camera.py`**

Module constant near the top:

```python
#: How stale a served JPEG may be when the caller opts in. At 24 fps capture
#: a 100 ms-old frame is within one 10 fps recording period; sharing one
#: encode across recorder + preview cuts ~30 encodes/s to at most 10 — a
#: measured slice of the 94 °C shadow-ride plateau.
JPEG_MAX_AGE_MS = 100.0
```

`FrameBuffer.__init__` adds `self._last_jpeg: bytes | None = None` and `self._last_jpeg_at: float | None = None`. `jpeg()` becomes:

```python
    def jpeg(self, max_age_ms: float | None = None) -> bytes | None:
        with self._lock:
            if self._jpeg is not None:
                return self._jpeg  # current frame's encode — exact, as always
            if (
                max_age_ms is not None
                and self._last_jpeg is not None
                and self._last_jpeg_at is not None
                and (self._clock() - self._last_jpeg_at) * 1000.0 <= max_age_ms
            ):
                # A newer frame exists but the last encode is younger than the
                # caller's staleness budget. Serving it is what turns thirty
                # encodes a second into ten.
                return self._last_jpeg
            frame = self._frame
        if frame is None:
            return None

        # Encode outside the lock: a 3 MB frame takes long enough that holding
        # it would stall the subscriber thread and drop frames.  (unchanged)
        data = self._encode(frame.nv12, frame.width, frame.height)
        with self._lock:
            if self._frame is frame:
                self._jpeg = data
            if data is not None:
                self._last_jpeg = data
                self._last_jpeg_at = self._clock()
        return data
```

`MipiCamera.jpeg(self, max_age_ms: float | None = None)` → `return self.buffer.jpeg(max_age_ms)`.

`camera.py`: `_grab(self, camera, max_age_ms: float | None = None)` passes through to `camera.jpeg(max_age_ms)`; the recording write loop's `_grab(...)` calls pass `max_age_ms=JPEG_MAX_AGE_MS` (import the constant from `mipi_camera`); `capture_photo` and `start_recording`'s probe `_grab` calls stay bare (a probe wants the truth about _now_).

`bench_server.py`: the `_preview` loop's and `/frame` handler's `jpeg()`/`_grab()` calls pass `max_age_ms=JPEG_MAX_AGE_MS` (import from `mipi_camera`).

- [ ] **Step 4: Run on the board to verify green**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py tests/test_camera_policy.py tests/test_preview.py tests/test_bench_frame.py -q'
```

Expected: all pass (pre-existing cache tests keep passing — the `None` path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/mipi_camera.py rdk/vision/camera.py rdk/vision/bench_server.py rdk/vision/tests/test_mipi_camera.py
git commit -m "perf(vision): share one JPEG encode across consumers within a 100 ms budget"
```

---

### Task 9: Bounded track history

**Files:**

- Modify: `rdk/vision/perception/tracker.py`, `rdk/vision/adas/runtime.py` (one constructor argument)
- Test: `rdk/vision/tests/test_tracker.py`, `rdk/vision/tests/test_threat.py` (extend)

**Interfaces:**

- Consumes: `Tuning.track_window_ms` (Task 1), the runtime's tuning-driven `Tracker(...)` construction (Task 3).
- Produces: `Tracker.__init__` gains `window_ms: int = 6_000`; `update()` trims every track's `samples` to `[s for s in samples if t_ms - s.t_ms <= window_ms]` after appending. Runtime passes `window_ms=config.tuning.track_window_ms`.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_tracker.py` (mirror its Detection-construction helpers):

```python
def test_samples_are_bounded_by_the_window():
    tracker = Tracker(window_ms=6_000)
    for i in range(200):  # 20 s of frames at 10 fps
        tracker.update([_det(0.4, 0.4, 0.6, 0.6)], t_ms=i * 100)  # the file's det helper
    (track,) = tracker.update([_det(0.4, 0.4, 0.6, 0.6)], t_ms=20_000)
    assert all(20_000 - s.t_ms <= 6_000 for s in track.samples)
    assert len(track.samples) <= 62  # 6 s at 10 fps, plus the two boundary frames
```

Add to `rdk/vision/tests/test_threat.py`:

```python
def test_tailgating_dwell_still_fires_inside_the_window():
    # A rear vehicle at tailgate height for 4.5 s of samples, all inside the
    # 6 s window: dwell must still be measurable and the rule must fire.
    # Build the track the way this file's existing tailgating test does, but
    # cap its sample history to the last 6 s before calling evaluate.
    ...
    assert any(c.threat_id == "tailgating" for c in candidates)
```

(Copy the existing tailgating test's construction; the new content is trimming the sample list to a 6 s span first, proving the window never starves the dwell rule.)

- [ ] **Step 2: Run on the board to verify the tracker test fails**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tracker.py tests/test_threat.py -q'
```

Expected: the bound test FAILS (`Tracker` has no `window_ms`; samples grow to 200).

- [ ] **Step 3: Implement**

`tracker.py`: `__init__` gains `window_ms: int = 6_000` (stored `self.window_ms`); at the end of `update`, before the return, trim every surviving track:

```python
        cutoff = t_ms - self.window_ms
        for track in self._tracks:
            if track.samples and track.samples[0].t_ms < cutoff:
                # Trim from the front: the window caps both per-track memory
                # and the O(history) walks smoothed_heights makes three times
                # per track per frame. tuning.track_window_ms guarantees the
                # window exceeds the tailgate dwell, the longest look-back.
                track.samples[:] = [s for s in track.samples if s.t_ms >= cutoff]
```

`runtime.py`: the Task 3 `Tracker(...)` construction gains `window_ms=config.tuning.track_window_ms`.

- [ ] **Step 4: Run on the board to verify green**

Same command. Expected: all pass, including the pre-existing tracker suite.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/perception/tracker.py rdk/vision/adas/runtime.py rdk/vision/tests/test_tracker.py rdk/vision/tests/test_threat.py
git commit -m "perf(adas): a sliding window bounds track history and the walks over it"
```

---

### Task 10: BPU output aliasing

**Files:**

- Modify: `rdk/vision/perception/detector.py:114`
- Test: existing `rdk/vision/tests/test_detector.py` + `tests/test_postprocess.py` (no new tests — the change is observationally identical)

- [ ] **Step 1: Make the change**

```python
        tensors = [np.asarray(o.buffer) for o in outputs]
```

(was `np.array(...)` — `asarray` aliases instead of copying ~9.4 MB of float32 heads per inference. The arrays are read-only within the same `infer` call: `decode` and `nms` only read, and `letterbox_nv12` allocates fresh buffers, so aliasing the vendor buffer is safe for the lifetime it is used. Put that sentence in a comment above the line.)

- [ ] **Step 2: Run the perception suite on the board**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_detector.py tests/test_postprocess.py -q'
```

Expected: all pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add rdk/vision/perception/detector.py
git commit -m "perf(vision): alias the BPU output heads instead of copying 9.4 MB per inference"
```

---

### Task 11: Catalog alignment and the drift test

**Files:**

- Modify: `rdk/vision/adas/catalog.py`
- Test: `rdk/vision/tests/test_catalog_drift.py` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks. `shared/adas.ts` is the canonical string source (read-only — do not edit the TS file; `forward_collision` and `rear_approach` already match, only the two M2 entries drifted).

- [ ] **Step 1: Write the failing test**

`rdk/vision/tests/test_catalog_drift.py` (modelled on `test_labels.py`'s TS-parsing + skip pattern):

```python
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from adas.catalog import CATALOG

REPO_ROOT = Path(__file__).resolve().parents[3]


def _ts_entries() -> dict[str, dict[str, str]]:
    catalog_path = REPO_ROOT / "shared" / "adas.ts"
    if not catalog_path.exists():
        pytest.skip("shared/adas.ts not present (running outside a full checkout)")
    source = catalog_path.read_text(encoding="utf-8")
    entries: dict[str, dict[str, str]] = {}
    for block in re.finditer(r"\{\s*threat:\s*\"([a-z_]+)\"(.*?)\}", source, re.S):
        threat, body = block.group(1), block.group(2)
        fields = dict(re.findall(r"(\w+):\s*\"([^\"]*)\"", body))
        entries[threat] = fields
    return entries


def test_catalog_matches_the_typescript_strings_exactly():
    ts = _ts_entries()
    for threat, entry in CATALOG.items():
        assert threat in ts, f"{threat} missing from shared/adas.ts"
        for field in ("direction", "label", "message", "advice"):
            assert entry[field] == ts[threat][field], (
                f"{threat}.{field} drifted:\n"
                f"  catalog.py : {entry[field]}\n"
                f"  adas.ts    : {ts[threat][field]}"
            )
```

- [ ] **Step 2: Run it where the TS file exists to verify it fails**

The board normally has no `shared/adas.ts`, so for the un-skipped run sync it beside the vision tree at the position `parents[3]/shared/adas.ts` resolves to:

```bash
# parents[3] of /opt/max/rdk/vision/tests/test_catalog_drift.py is /opt/max — sync there:
ssh root@10.42.0.11 'mkdir -p /opt/max/shared'
scp shared/adas.ts root@10.42.0.11:/opt/max/shared/adas.ts
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_catalog_drift.py -q'
```

Expected: FAIL on `pedestrian_ahead.message` (and `advice`), then `tailgating` — the drift this task closes. (Note `parents[3]` from `/opt/max/rdk/vision/tests/...` is `/opt/max`, mirroring how `test_labels.py` resolves the repo root on the dev machine; the `scp` above puts the file exactly there.)

- [ ] **Step 3: Align `catalog.py`**

Update the two drifted entries to the canonical TS strings, and rewrite the stale docstring:

```python
"""Spoken strings for the four v1 threats.

Mirrors — exactly — the matching entries in shared/adas.ts, which is the
canonical catalog (it is what clients display and the relay validates).
tests/test_catalog_drift.py enforces the match wherever the full checkout is
present. The WAV filenames key off these ids; changing a string here means
re-rendering the board's alert clips with tools/render_alerts.py.
"""
```

```python
    "pedestrian_ahead": {
        "direction": "front",
        "label": "前方行人",
        "message": "前方有行人横穿，立即减速！",
        "advice": "收油轻刹，准备停车。",
    },
```

```python
    "tailgating": {
        "direction": "rear",
        "label": "后车跟车过近",
        "message": "后车跟车过近，注意不要急刹。",
        "advice": "平稳行驶，适当让出车距。",
    },
```

(`forward_collision` and `rear_approach` stay as they are — verified matching.)

- [ ] **Step 4: Verify green (un-skipped) on the board, then clean up the synced TS file**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_catalog_drift.py tests/test_service_hazard.py -q'
ssh root@10.42.0.11 'rm -rf /opt/max/shared'   # restore the board's normal shape; the test skips again
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_catalog_drift.py -q'
```

Expected: pass un-skipped, then `1 skipped` after cleanup.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/catalog.py rdk/vision/tests/test_catalog_drift.py
git commit -m "fix(adas): catalog strings conform to shared/adas.ts, with a drift test"
```

---

### Task 12: Full gates

**Files:** none new.

- [ ] **Step 1: Full board suite**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: ≥ 312 + all new tests, 0 failures (one skip: the drift test without the TS file).

- [ ] **Step 2: Repo gate**

Run: `npm run check`
Expected: green (this track touches no TS behavior; prettier on the spec/plan markdown is the likely fallout — fix-forward, formatting only).

- [ ] **Step 3: Commit any gate fallout**

```bash
git add -A && git commit -m "chore(adas): satisfy the repo gate"
```

(Skip if clean.)

---

### Task 13: Board acceptance — the clip is the deliverable

**Files:** none — deployment + measurement. Update `rdk/README.md`'s findings table with the measured thermal number at the end.

Deploy-ordering note: this track changes only vision-side code; sync `/opt/max/rdk/vision` and `systemctl restart max-vision` (the agent is untouched).

- [ ] **Step 1: Deploy and restart the sidecar with shadow mode on**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'grep -q "^MAX_ADAS_SHADOW=1" /etc/max/agent.env || sed -i "s/^MAX_ADAS_SHADOW=.*/MAX_ADAS_SHADOW=1/" /etc/max/agent.env; systemctl restart max-vision; sleep 10; systemctl is-active max-vision'
```

Expected: `active`; journal shows a ride starting.

- [ ] **Step 2: Produce at least one alert and verify the evidence chain**

Wave a hand or an object toward the camera slowly (person-class approach), or hold a phone showing the M1 `bus.jpg` zoom clip in front of the lens. Then:

```bash
ssh root@10.42.0.11 'RIDE=$(ls -td /var/lib/max/corpus/ride-* | head -1); \
  cat "$RIDE"/shadow-front.jsonl | head -3; ls "$RIDE"/front | head -3'
```

Expected: a header line with `"shadow_header": 1` and a fingerprint; records carrying `"tuning": "<12hex>"` and `"segment": "front/seg-....mjpeg"` matching a real file in the ride directory.

- [ ] **Step 3: Extract the clip and verify it shows the triggering scene**

```bash
ssh root@10.42.0.11 'RIDE=$(ls -td /var/lib/max/corpus/ride-* | head -1); \
  cd /opt/max/rdk/vision && python3 tools/clip.py "$RIDE"/shadow-front.jsonl --index 0 --segments "$RIDE" --out /tmp/alert.mp4 && ls -la /tmp/alert.mp4'
scp root@10.42.0.11:/tmp/alert.mp4 /tmp/alert.mp4
```

Open `/tmp/alert.mp4` and confirm the approach that triggered the alert is visible in the clip window. This is the acceptance test the whole mapping change exists for.

- [ ] **Step 4: Thermal/encode measurement**

With the ride still running and ONE preview client open (`curl -s -m 60 http://10.42.0.11:8081/preview/front > /dev/null &` from the Mac), sample for 10 minutes:

```bash
ssh root@10.42.0.11 'for i in $(seq 1 20); do cat /sys/class/thermal/thermal_zone*/temp | tr "\n" " "; date "+%H:%M:%S"; sleep 30; done'
```

Record the plateau. Baseline from `rdk/README.md`: ~94 °C single-camera shadow ride at bench ambient. Add a row to the README findings table with the measured value and date, whatever it is (target ≥5 °C drop; the number is the deliverable). Stop the ride afterwards if the user's bench setup expects shadow off: restore `MAX_ADAS_SHADOW=0` and restart, reporting what was left running.

- [ ] **Step 5: Commit the README row**

```bash
git add rdk/README.md
git commit -m "docs(rdk): record the shadow-ride thermal plateau after the encode-sharing fix"
```

---

## Self-review notes

- **Spec coverage:** Tuning module (T1), injectable pure modules (T2), runtime assembly (T3), version-stamped logs incl. service wiring (T4), SegmentClock + recorder publishing (T5), runtime mapping + ride wiring + deletions (T6), replay fingerprint (T7), JPEG cache + all three call-site classes (T8), track bounding + dwell interplay (T9), detector aliasing (T10), catalog alignment + drift test incl. the one un-skipped board run (T11), gates (T12), on-hardware evidence-chain + thermal row (T13). Every spec Goal and error-handling row maps to a task.
- **Type consistency:** `Tuning` field names in T2/T3/T9 match T1's dataclass; `SegmentClock.update/current` signatures match between T5 and T6; `jpeg(max_age_ms)`/`_grab(camera, max_age_ms)` consistent across T8's three files; `fingerprint()` used identically in T4/T7.
- **Bounded flexibility points (not placeholders):** T2/T3/T6/T7/T9 tests explicitly copy named neighbouring tests' setup lines from the files they extend — the assertions, which are the deliverable, are given in full; T5's relative-path suffix defers to the writer's real filename expression with an `exists()` assertion pinning it.
