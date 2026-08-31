# ADAS M0 (Collect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ride-recording corpus that ADAS M1 tunes against — continuous segmented video with per-frame metadata, a clip library, and a hazard-window labelling tool.

**Architecture:** A ctypes binding pins the MIPI port explicitly (replacing the auto-detect that crashes `cam-service`), a recording session drives whichever cameras open into hardware-encoded H.264 segments with a JSONL metadata sidecar, and a pure corpus layer indexes clips and validates hazard labels. Everything except the camera binding and the encoder is pure and testable off-board.

**Tech Stack:** Python 3.10 (board ships it), ctypes against `/usr/hobot/lib/libcam.so`, `hobot_vio.libsrcampy` for the hardware encoder, pytest.

**Spec:** `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md` (milestone M0)

## Global Constraints

- **Never use `libsrcampy.open_cam(port, -1, …)` auto-detect.** It searches `vcon@0` (i2c bus 6, no connector), reports a phantom `ov5647`, and NULL-dereferences `cam-service`. Pin the port via `hbn_camera_create` with `bus_select`.
- **Cameras are independently optional.** Front-only and rear-only are valid. A camera that fails to open degrades the recording, never aborts it.
- Only **IMX219** works on this board (`0x10`). OV5647 fails at video-flow start. Front camera is **VCON 2**; rear is **VCON 3** and currently unreachable.
- `systemctl restart cam-service` resets a wedged pipeline — no reboot needed between bench runs.
- Board paths: model zoo `/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/`, headers `/usr/include/hb_camera_data_config.h`, camera lib `/usr/hobot/lib/libcam.so`.
- pytest is dev-only; the sidecar itself must import nothing outside the stdlib plus `hobot_vio`.
- Python tests run from `rdk/vision/`: `python3 -m pytest tests/ -q`.
- Recording must survive power loss: segments close and flush on a fixed interval, never buffering a whole ride.

---

## File Structure

**Created**

| Path                               | Responsibility                                                |
| ---------------------------------- | ------------------------------------------------------------- |
| `rdk/vision/camera_binding.py`     | ctypes structs + `hbn_camera_create`; explicit port selection |
| `rdk/vision/recorder/__init__.py`  | package marker                                                |
| `rdk/vision/recorder/metadata.py`  | per-frame metadata records + JSONL sidecar writer             |
| `rdk/vision/recorder/segmenter.py` | pure: when to roll a segment, segment naming                  |
| `rdk/vision/recorder/session.py`   | ride session: drives cameras → encoder → segments             |
| `rdk/vision/corpus/__init__.py`    | package marker                                                |
| `rdk/vision/corpus/library.py`     | pure: scan/index a corpus directory                           |
| `rdk/vision/corpus/labels.py`      | pure: hazard-window labels, validation, merge                 |
| `rdk/vision/tools/__init__.py`     | package marker                                                |
| `rdk/vision/tools/record_ride.py`  | CLI, runs on the board                                        |
| `rdk/vision/tools/label.py`        | CLI, runs on a laptop                                         |
| `rdk/vision/tests/test_*.py`       | pytest suites, all camera-free                                |

**Modified**

| Path                   | Change                                                 |
| ---------------------- | ------------------------------------------------------ |
| `rdk/vision/camera.py` | use `camera_binding` instead of `open_cam` auto-detect |
| `rdk/README.md`        | M0 recording + labelling instructions                  |

**Storage layout** produced by a ride:

```text
<corpus>/ride-20260725-141900/
  ride.json                     # session manifest
  front/seg-000000.h264         # 60 s segments
  front/seg-000000.jsonl        # per-frame metadata
  front/seg-000001.h264 …
  rear/  …                      # absent if the rear camera never opened
  labels.json                   # written later by tools/label.py
```

---

## Task 1: ctypes camera binding

Replaces the crashing auto-detect. This gates every other task — nothing records until a camera opens.

**Files:**

- Create: `rdk/vision/camera_binding.py`
- Test: `rdk/vision/tests/test_camera_binding.py`

**Interfaces:**

- Produces:
  - `class CameraConfig(ctypes.Structure)` mirroring `camera_config_t`
  - `IMX219 = SensorSpec(name="imx219", addr=0x10)`, `OV5647 = SensorSpec(name="ov5647", addr=0x36)`
  - `build_config(sensor: SensorSpec, vcon: int, width: int, height: int, fps: int) -> CameraConfig`
  - `open_camera(config: CameraConfig) -> int` (returns a camera handle; raises `CameraError` on failure)
  - `class CameraError(RuntimeError)`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_camera_binding.py`:

```python
import ctypes
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera_binding import IMX219, OV5647, CameraConfig, build_config


def test_struct_field_order_matches_the_vendor_header():
    # Order is load-bearing: ctypes lays the struct out positionally, so a
    # reordered field silently corrupts every value after it.
    names = [f[0] for f in CameraConfig._fields_]
    assert names[:6] == ["name", "addr", "isp_addr", "eeprom_addr", "serial_addr", "sensor_mode"]
    assert "bus_select" in names
    assert "gpio_enable_bit" in names
    assert names[-1] == "end_flag"


def test_bus_select_precedes_fps_and_geometry():
    names = [f[0] for f in CameraConfig._fields_]
    assert names.index("bus_select") < names.index("fps") < names.index("width") < names.index("height")


def test_build_config_pins_the_port():
    cfg = build_config(IMX219, vcon=2, width=1920, height=1080, fps=30)
    assert cfg.bus_select == 2
    assert cfg.addr == 0x10
    assert cfg.name == b"imx219"
    assert cfg.width == 1920
    assert cfg.height == 1080
    assert cfg.fps == 30


def test_build_config_leaves_mipi_cfg_null_for_auto():
    cfg = build_config(IMX219, vcon=2, width=1920, height=1080, fps=30)
    assert not cfg.mipi_cfg  # NULL => vendor stack derives MIPI config itself


def test_sensor_specs_match_measured_hardware():
    assert (IMX219.name, IMX219.addr) == ("imx219", 0x10)
    assert (OV5647.name, OV5647.addr) == ("ov5647", 0x36)


def test_rejects_a_vcon_outside_the_board_range():
    with pytest.raises(ValueError):
        build_config(IMX219, vcon=9, width=1920, height=1080, fps=30)


def test_name_is_truncated_not_overflowed():
    long_sensor = type(IMX219)(name="x" * 200, addr=0x10)
    cfg = build_config(long_sensor, vcon=2, width=1920, height=1080, fps=30)
    assert len(cfg.name) < 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_camera_binding.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'camera_binding'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/camera_binding.py`:

```python
"""Explicit MIPI port selection for RDK X5 cameras.

The stock ``libsrcampy.open_cam(port, -1, ...)`` auto-detect is unusable on this
board: it always searches ``vcon@0`` (i2c bus 6), which has no connector, reports
a phantom ov5647 there, and ``cam-service`` NULL-dereferences initialising a
sensor that does not exist — taking the whole pipeline down.

So we bypass it and call ``hbn_camera_create`` ourselves with ``bus_select`` set
to the VCON index, mirroring what the vendor's own ``mipi_cam`` node does.
Struct layout is copied from /usr/include/hb_camera_data_config.h.
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass

CAMERA_MODULE_NAME_LEN = 108
LIBCAM_PATH = "/usr/hobot/lib/libcam.so"

#: VCON indices that physically exist on this board.
VALID_VCON = (0, 1, 2, 3)


class CameraError(RuntimeError):
    """Raised when the vendor stack refuses to create or attach a camera."""


@dataclass(frozen=True)
class SensorSpec:
    name: str
    addr: int


#: Measured on hardware: IMX219 streams, OV5647 fails at video-flow start.
IMX219 = SensorSpec(name="imx219", addr=0x10)
OV5647 = SensorSpec(name="ov5647", addr=0x36)


class CameraConfig(ctypes.Structure):
    """Mirrors ``camera_config_t``. Field ORDER is load-bearing — ctypes lays the
    struct out positionally, so a reordered field corrupts everything after it."""

    _fields_ = [
        ("name", ctypes.c_char * CAMERA_MODULE_NAME_LEN),
        ("addr", ctypes.c_uint32),
        ("isp_addr", ctypes.c_uint32),
        ("eeprom_addr", ctypes.c_uint32),
        ("serial_addr", ctypes.c_uint32),
        ("sensor_mode", ctypes.c_uint32),
        ("sensor_clk", ctypes.c_uint32),
        ("gpio_enable_bit", ctypes.c_uint32),
        ("gpio_level_bit", ctypes.c_uint32),
        ("bus_select", ctypes.c_uint32),
        ("bus_timeout", ctypes.c_uint32),
        ("fps", ctypes.c_uint32),
        ("width", ctypes.c_uint32),
        ("height", ctypes.c_uint32),
        ("format", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("extra_mode", ctypes.c_uint32),
        ("config_index", ctypes.c_uint32),
        ("ts_compensate", ctypes.c_int32),
        ("mipi_cfg", ctypes.c_void_p),
        ("calib_lname", ctypes.c_char * CAMERA_MODULE_NAME_LEN),
        ("sensor_param", ctypes.c_char_p),
        ("iparam_mode", ctypes.c_uint32),
        ("end_flag", ctypes.c_uint32),
    ]


def build_config(sensor: SensorSpec, vcon: int, width: int, height: int, fps: int) -> CameraConfig:
    """Build a config pinned to one VCON. ``mipi_cfg`` stays NULL so the vendor
    stack derives the MIPI timing itself — that part it gets right."""
    if vcon not in VALID_VCON:
        raise ValueError(f"vcon must be one of {VALID_VCON}, got {vcon}")

    cfg = CameraConfig()
    cfg.name = sensor.name.encode("ascii")[: CAMERA_MODULE_NAME_LEN - 1]
    cfg.addr = sensor.addr
    cfg.bus_select = vcon
    cfg.width = width
    cfg.height = height
    cfg.fps = fps
    cfg.mipi_cfg = None
    return cfg


def open_camera(config: CameraConfig) -> int:
    """Create a camera handle for the pinned port. Raises CameraError on failure
    rather than returning a sentinel, so a caller cannot use a dead handle."""
    lib = ctypes.CDLL(LIBCAM_PATH)
    lib.hbn_camera_create.argtypes = [ctypes.POINTER(CameraConfig), ctypes.POINTER(ctypes.c_uint64)]
    lib.hbn_camera_create.restype = ctypes.c_int32

    handle = ctypes.c_uint64(0)
    ret = lib.hbn_camera_create(ctypes.byref(config), ctypes.byref(handle))
    if ret != 0:
        raise CameraError(
            f"hbn_camera_create failed (ret={ret}) for {config.name.decode()} on vcon {config.bus_select}"
        )
    return handle.value
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_camera_binding.py -q`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify on the board**

```bash
ssh root@<board>
systemctl restart cam-service && sleep 3
cd /opt/max/rdk/vision && python3 -c "
from camera_binding import IMX219, build_config, open_camera
cfg = build_config(IMX219, vcon=2, width=1920, height=1080, fps=30)
print('handle:', open_camera(cfg))
"
```

Expected: a non-zero handle and **no** `cam-service` crash. Confirm with
`systemctl is-active cam-service` — it must still say `active`. If it says
`failed`, the port pinning did not take and the auto-detect ran; stop and
re-check `bus_select` before continuing.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/camera_binding.py rdk/vision/tests/test_camera_binding.py
git commit -m "feat(rdk): pin the MIPI port via hbn_camera_create instead of auto-detect"
```

---

## Task 2: Per-frame metadata

**Files:**

- Create: `rdk/vision/recorder/__init__.py`, `rdk/vision/recorder/metadata.py`
- Test: `rdk/vision/tests/test_metadata.py`

**Interfaces:**

- Produces:
  - `@dataclass FrameMeta(frame_index: int, mono_ns: int, wall_ms: int, camera: str)`
  - `class MetadataWriter(path)` with `append(meta: FrameMeta) -> None`, `close() -> None`, context-manager support
  - `read_metadata(path) -> list[FrameMeta]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_metadata.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recorder.metadata import FrameMeta, MetadataWriter, read_metadata


def test_append_writes_one_json_object_per_line(tmp_path):
    path = tmp_path / "seg.jsonl"
    with MetadataWriter(path) as w:
        w.append(FrameMeta(frame_index=0, mono_ns=1_000, wall_ms=1700, camera="front"))
        w.append(FrameMeta(frame_index=1, mono_ns=101_000, wall_ms=1800, camera="front"))
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["frame_index"] == 0
    assert json.loads(lines[1])["mono_ns"] == 101_000


def test_round_trips_through_read_metadata(tmp_path):
    path = tmp_path / "seg.jsonl"
    original = [
        FrameMeta(frame_index=i, mono_ns=i * 100_000, wall_ms=1700 + i, camera="rear") for i in range(5)
    ]
    with MetadataWriter(path) as w:
        for meta in original:
            w.append(meta)
    assert read_metadata(path) == original


def test_flushes_each_record_so_power_loss_keeps_what_was_written(tmp_path):
    # Recording must survive power loss: a buffered writer would lose the ride.
    path = tmp_path / "seg.jsonl"
    w = MetadataWriter(path)
    w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1700, camera="front"))
    assert path.read_text(encoding="utf-8").count("\n") == 1
    w.close()


def test_read_metadata_skips_a_torn_final_line(tmp_path):
    # Exactly what an abrupt power cut leaves behind.
    path = tmp_path / "seg.jsonl"
    path.write_text('{"frame_index":0,"mono_ns":0,"wall_ms":1,"camera":"front"}\n{"frame_ind', encoding="utf-8")
    metas = read_metadata(path)
    assert len(metas) == 1
    assert metas[0].frame_index == 0


def test_read_metadata_on_missing_file_is_empty(tmp_path):
    assert read_metadata(tmp_path / "nope.jsonl") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_metadata.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'recorder'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/recorder/__init__.py` (empty file).

Create `rdk/vision/recorder/metadata.py`:

```python
"""Per-frame metadata sidecar.

One JSONL file per video segment. Every record is flushed as it is written:
a ride ends when the bike's power does, and a buffered writer would lose the
tail of exactly the clip we most wanted.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class FrameMeta:
    frame_index: int
    #: Monotonic capture time. Used for inter-frame deltas; immune to clock steps.
    mono_ns: int
    #: Wall-clock milliseconds. Used to align a clip with a ride log.
    wall_ms: int
    camera: str


class MetadataWriter:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("w", encoding="utf-8")

    def append(self, meta: FrameMeta) -> None:
        self._fh.write(json.dumps(asdict(meta), ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> "MetadataWriter":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def read_metadata(path: Path | str) -> list[FrameMeta]:
    """Read a sidecar. A torn final line — the signature of a power cut — is
    dropped rather than raised, so one bad ride does not poison the corpus."""
    file_path = Path(path)
    if not file_path.exists():
        return []
    out: list[FrameMeta] = []
    for line in file_path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(FrameMeta(**json.loads(line)))
        except (json.JSONDecodeError, TypeError):
            continue
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_metadata.py -q`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/recorder tests/test_metadata.py
git commit -m "feat(rdk): add per-frame recording metadata with power-loss-safe writes"
```

---

## Task 3: Segmenter

**Files:**

- Create: `rdk/vision/recorder/segmenter.py`
- Test: `rdk/vision/tests/test_segmenter.py`

**Interfaces:**

- Produces:
  - `SEGMENT_SECONDS = 60`
  - `segment_name(index: int) -> str` → `"seg-000000"`
  - `ride_id(now: datetime) -> str` → `"ride-20260725-141900"`
  - `class Segmenter(segment_seconds: float = SEGMENT_SECONDS)` with `should_roll(now_s: float) -> bool`, `roll(now_s: float) -> int`, `index` property

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_segmenter.py`:

```python
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recorder.segmenter import SEGMENT_SECONDS, Segmenter, ride_id, segment_name


def test_segment_length_bounds_power_loss_damage():
    assert SEGMENT_SECONDS == 60


def test_segment_names_sort_lexicographically():
    names = [segment_name(i) for i in (0, 1, 10, 100)]
    assert names == ["seg-000000", "seg-000001", "seg-000010", "seg-000100"]
    assert names == sorted(names)


def test_ride_id_is_sortable_and_timestamped():
    assert ride_id(datetime(2026, 7, 25, 14, 19, 0)) == "ride-20260725-141900"


def test_does_not_roll_before_the_interval_elapses():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    assert seg.should_roll(now_s=1059.9) is False


def test_rolls_once_the_interval_elapses():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    assert seg.should_roll(now_s=1060.0) is True


def test_roll_advances_the_index():
    seg = Segmenter()
    assert seg.roll(now_s=0.0) == 0
    assert seg.roll(now_s=60.0) == 1
    assert seg.index == 1


def test_roll_rebases_the_clock_so_segments_are_evenly_spaced():
    seg = Segmenter(segment_seconds=60)
    seg.roll(now_s=1000.0)
    seg.roll(now_s=1065.0)  # 5 s late
    # Next roll is measured from 1065, not from 1060 — no compounding drift and
    # no immediate double-roll.
    assert seg.should_roll(now_s=1120.0) is False
    assert seg.should_roll(now_s=1125.0) is True


def test_should_roll_is_false_before_the_first_roll():
    assert Segmenter().should_roll(now_s=99999.0) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_segmenter.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'recorder.segmenter'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/recorder/segmenter.py`:

```python
"""Segment rotation for ride recording.

Rides are cut into fixed-length segments so a power cut costs at most one
segment, and so the corpus is made of files a human can actually review.
"""

from __future__ import annotations

from datetime import datetime

#: Bounds power-loss damage to one minute of footage.
SEGMENT_SECONDS = 60


def segment_name(index: int) -> str:
    """Zero-padded so lexical order matches capture order in any file browser."""
    return f"seg-{index:06d}"


def ride_id(now: datetime) -> str:
    return f"ride-{now:%Y%m%d-%H%M%S}"


class Segmenter:
    def __init__(self, segment_seconds: float = SEGMENT_SECONDS) -> None:
        self.segment_seconds = segment_seconds
        self._index = -1
        self._started_at: float | None = None

    @property
    def index(self) -> int:
        return self._index

    def should_roll(self, now_s: float) -> bool:
        if self._started_at is None:
            return False
        return (now_s - self._started_at) >= self.segment_seconds

    def roll(self, now_s: float) -> int:
        """Start the next segment and return its index. The clock rebases to the
        actual roll time rather than the ideal one, so a late roll does not
        immediately trigger another."""
        self._index += 1
        self._started_at = now_s
        return self._index
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_segmenter.py -q`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/recorder/segmenter.py rdk/vision/tests/test_segmenter.py
git commit -m "feat(rdk): add ride segment rotation"
```

---

## Task 4: Corpus library

**Files:**

- Create: `rdk/vision/corpus/__init__.py`, `rdk/vision/corpus/library.py`
- Test: `rdk/vision/tests/test_library.py`

**Interfaces:**

- Consumes: `read_metadata` from `recorder.metadata`
- Produces:
  - `@dataclass SegmentInfo(camera: str, name: str, video_path: Path, meta_path: Path, frame_count: int)`
  - `@dataclass RideInfo(ride: str, path: Path, cameras: list[str], segments: list[SegmentInfo], labelled: bool)`
  - `write_ride_manifest(ride_dir, ride: str, cameras: list[str], started_wall_ms: int) -> Path`
  - `scan_ride(ride_dir) -> RideInfo`
  - `scan_corpus(root) -> list[RideInfo]` (newest first)

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_library.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.library import scan_corpus, scan_ride, write_ride_manifest
from recorder.metadata import FrameMeta, MetadataWriter


def make_segment(ride_dir: Path, camera: str, index: int, frames: int) -> None:
    name = f"seg-{index:06d}"
    cam_dir = ride_dir / camera
    cam_dir.mkdir(parents=True, exist_ok=True)
    (cam_dir / f"{name}.h264").write_bytes(b"\x00\x00\x00\x01fake")
    with MetadataWriter(cam_dir / f"{name}.jsonl") as w:
        for i in range(frames):
            w.append(FrameMeta(frame_index=i, mono_ns=i * 100_000_000, wall_ms=1700 + i, camera=camera))


@pytest.fixture()
def ride(tmp_path):
    ride_dir = tmp_path / "ride-20260725-141900"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-141900", cameras=["front"], started_wall_ms=1700)
    make_segment(ride_dir, "front", 0, frames=10)
    make_segment(ride_dir, "front", 1, frames=7)
    return ride_dir


def test_manifest_records_the_cameras_that_actually_ran(ride):
    payload = json.loads((ride / "ride.json").read_text())
    assert payload["cameras"] == ["front"]
    assert payload["ride"] == "ride-20260725-141900"


def test_scan_finds_every_segment_in_capture_order(ride):
    info = scan_ride(ride)
    assert [s.name for s in info.segments] == ["seg-000000", "seg-000001"]


def test_scan_counts_frames_from_the_metadata_sidecar(ride):
    info = scan_ride(ride)
    assert [s.frame_count for s in info.segments] == [10, 7]


def test_scan_reports_a_front_only_ride_without_complaint(ride):
    # Rear camera is unreachable on this board; front-only must be a first-class
    # corpus entry, not an error.
    info = scan_ride(ride)
    assert info.cameras == ["front"]


def test_scan_handles_a_two_camera_ride(tmp_path):
    ride_dir = tmp_path / "ride-20260725-150000"
    ride_dir.mkdir()
    write_ride_manifest(ride_dir, ride="ride-20260725-150000", cameras=["front", "rear"], started_wall_ms=1)
    make_segment(ride_dir, "front", 0, frames=3)
    make_segment(ride_dir, "rear", 0, frames=3)
    info = scan_ride(ride_dir)
    assert sorted(info.cameras) == ["front", "rear"]
    assert len(info.segments) == 2


def test_segment_without_a_sidecar_reports_zero_frames(ride):
    (ride / "front" / "seg-000002.h264").write_bytes(b"\x00")
    info = scan_ride(ride)
    orphan = [s for s in info.segments if s.name == "seg-000002"][0]
    assert orphan.frame_count == 0


def test_labelled_flag_tracks_the_labels_file(ride):
    assert scan_ride(ride).labelled is False
    (ride / "labels.json").write_text("{}", encoding="utf-8")
    assert scan_ride(ride).labelled is True


def test_scan_corpus_is_newest_first(tmp_path):
    for stamp in ("ride-20260725-100000", "ride-20260725-120000", "ride-20260725-110000"):
        d = tmp_path / stamp
        d.mkdir()
        write_ride_manifest(d, ride=stamp, cameras=["front"], started_wall_ms=1)
    rides = [r.ride for r in scan_corpus(tmp_path)]
    assert rides == sorted(rides, reverse=True)


def test_scan_corpus_ignores_directories_without_a_manifest(tmp_path):
    (tmp_path / "not-a-ride").mkdir()
    assert scan_corpus(tmp_path) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_library.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'corpus'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/corpus/__init__.py` (empty file).

Create `rdk/vision/corpus/library.py`:

```python
"""Read-only index over a recorded ride corpus.

Pure: it reads what the recorder wrote and never mutates a ride. M1's replay
harness walks the corpus through this module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from recorder.metadata import read_metadata

MANIFEST_NAME = "ride.json"
LABELS_NAME = "labels.json"


@dataclass(frozen=True)
class SegmentInfo:
    camera: str
    name: str
    video_path: Path
    meta_path: Path
    frame_count: int


@dataclass(frozen=True)
class RideInfo:
    ride: str
    path: Path
    cameras: list[str]
    segments: list[SegmentInfo]
    labelled: bool


def write_ride_manifest(ride_dir: Path | str, ride: str, cameras: list[str], started_wall_ms: int) -> Path:
    """`cameras` records which cameras actually opened, not which were asked for
    — a front-only ride is a first-class corpus entry on this hardware."""
    directory = Path(ride_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / MANIFEST_NAME
    path.write_text(
        json.dumps({"ride": ride, "cameras": cameras, "started_wall_ms": started_wall_ms}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def scan_ride(ride_dir: Path | str) -> RideInfo:
    directory = Path(ride_dir)
    manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    cameras = list(manifest.get("cameras", []))

    segments: list[SegmentInfo] = []
    for camera in cameras:
        cam_dir = directory / camera
        if not cam_dir.is_dir():
            continue
        for video in sorted(cam_dir.glob("seg-*.h264")):
            meta_path = video.with_suffix(".jsonl")
            segments.append(
                SegmentInfo(
                    camera=camera,
                    name=video.stem,
                    video_path=video,
                    meta_path=meta_path,
                    frame_count=len(read_metadata(meta_path)),
                )
            )

    return RideInfo(
        ride=manifest.get("ride", directory.name),
        path=directory,
        cameras=cameras,
        segments=segments,
        labelled=(directory / LABELS_NAME).exists(),
    )


def scan_corpus(root: Path | str) -> list[RideInfo]:
    """Newest first — the ride you just recorded is the one you want to label."""
    rides: list[RideInfo] = []
    for directory in sorted(Path(root).iterdir(), reverse=True):
        if not directory.is_dir() or not (directory / MANIFEST_NAME).exists():
            continue
        rides.append(scan_ride(directory))
    return rides
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_library.py -q`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/corpus rdk/vision/tests/test_library.py
git commit -m "feat(rdk): add the ride corpus index"
```

---

## Task 5: Hazard labels

**Files:**

- Create: `rdk/vision/corpus/labels.py`
- Test: `rdk/vision/tests/test_labels.py`

**Interfaces:**

- Produces:
  - `V1_THREATS = ("forward_collision", "pedestrian_ahead", "rear_approach", "tailgating")`
  - `@dataclass HazardWindow(threat: str, camera: str, start_ms: int, end_ms: int, note: str = "")`
  - `validate_window(window) -> None` (raises `LabelError`)
  - `class LabelError(ValueError)`
  - `merge_windows(windows) -> list[HazardWindow]`
  - `write_labels(ride_dir, windows) -> Path`, `read_labels(ride_dir) -> list[HazardWindow]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_labels.py`:

```python
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.labels import (
    V1_THREATS,
    HazardWindow,
    LabelError,
    merge_windows,
    read_labels,
    validate_window,
    write_labels,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_threat_ids_match_the_typescript_catalog():
    # Anti-drift: shared/adas.ts is the single source of truth for threat ids.
    # If someone renames one there, this fails instead of silently producing a
    # corpus M1 cannot interpret.
    source = (REPO_ROOT / "shared" / "adas.ts").read_text(encoding="utf-8")
    block = re.search(r"export const ADAS_THREATS[^=]*=\s*\[(.*?)\]", source, re.S)
    assert block, "could not find ADAS_THREATS in shared/adas.ts"
    catalog = set(re.findall(r'"([a-z_]+)"', block.group(1)))
    assert set(V1_THREATS) <= catalog


def test_v1_covers_exactly_the_four_spec_threats():
    assert set(V1_THREATS) == {"forward_collision", "pedestrian_ahead", "rear_approach", "tailgating"}


def test_validate_accepts_a_well_formed_window():
    validate_window(HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000))


def test_validate_rejects_an_unknown_threat():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="teleporting_cow", camera="front", start_ms=0, end_ms=10))


def test_validate_rejects_a_non_positive_duration():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="rear", start_ms=500, end_ms=500))
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="rear", start_ms=900, end_ms=100))


def test_validate_rejects_an_unknown_camera():
    with pytest.raises(LabelError):
        validate_window(HazardWindow(threat="tailgating", camera="left", start_ms=0, end_ms=10))


def test_merge_combines_overlapping_windows_of_the_same_threat():
    merged = merge_windows(
        [
            HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000),
            HazardWindow(threat="rear_approach", camera="rear", start_ms=2500, end_ms=4000),
        ]
    )
    assert len(merged) == 1
    assert (merged[0].start_ms, merged[0].end_ms) == (1000, 4000)


def test_merge_keeps_different_threats_apart():
    merged = merge_windows(
        [
            HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000),
            HazardWindow(threat="tailgating", camera="rear", start_ms=1500, end_ms=2000),
        ]
    )
    assert len(merged) == 2


def test_merge_keeps_the_same_threat_on_different_cameras_apart():
    merged = merge_windows(
        [
            HazardWindow(threat="pedestrian_ahead", camera="front", start_ms=0, end_ms=100),
            HazardWindow(threat="pedestrian_ahead", camera="rear", start_ms=50, end_ms=150),
        ]
    )
    assert len(merged) == 2


def test_merge_leaves_a_gap_alone():
    merged = merge_windows(
        [
            HazardWindow(threat="tailgating", camera="rear", start_ms=0, end_ms=1000),
            HazardWindow(threat="tailgating", camera="rear", start_ms=2000, end_ms=3000),
        ]
    )
    assert len(merged) == 2


def test_labels_round_trip(tmp_path):
    windows = [
        HazardWindow(threat="forward_collision", camera="front", start_ms=10, end_ms=20, note="braking van"),
    ]
    write_labels(tmp_path, windows)
    assert read_labels(tmp_path) == windows


def test_read_labels_on_unlabelled_ride_is_empty(tmp_path):
    assert read_labels(tmp_path) == []


def test_write_labels_rejects_an_invalid_window_before_writing(tmp_path):
    with pytest.raises(LabelError):
        write_labels(tmp_path, [HazardWindow(threat="nope", camera="front", start_ms=0, end_ms=1)])
    assert not (tmp_path / "labels.json").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_labels.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'corpus.labels'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/corpus/labels.py`:

```python
"""Hazard-window labels — the ground truth M1 measures against.

Deliberately coarse: a labeller marks the time range in which a genuine hazard
existed, per threat, per camera. Precise boxes are not needed to answer the only
question that matters — did we fire at the right moments, and how often did we
fire when nothing was there.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

LABELS_NAME = "labels.json"

#: Must remain a subset of ADAS_THREATS in shared/adas.ts — enforced by test.
V1_THREATS = ("forward_collision", "pedestrian_ahead", "rear_approach", "tailgating")

VALID_CAMERAS = ("front", "rear")


class LabelError(ValueError):
    """Raised for a window that would corrupt the corpus."""


@dataclass(frozen=True)
class HazardWindow:
    threat: str
    camera: str
    start_ms: int
    end_ms: int
    note: str = ""


def validate_window(window: HazardWindow) -> None:
    if window.threat not in V1_THREATS:
        raise LabelError(f"unknown threat {window.threat!r}; expected one of {V1_THREATS}")
    if window.camera not in VALID_CAMERAS:
        raise LabelError(f"unknown camera {window.camera!r}; expected one of {VALID_CAMERAS}")
    if window.end_ms <= window.start_ms:
        raise LabelError(f"window must have positive duration, got {window.start_ms}..{window.end_ms}")


def merge_windows(windows: list[HazardWindow]) -> list[HazardWindow]:
    """Merge overlapping windows sharing a threat AND camera. Two labellers
    marking the same event, or one person marking it twice, must not count as two
    hazards when M1 scores recall."""
    by_key: dict[tuple[str, str], list[HazardWindow]] = {}
    for window in windows:
        by_key.setdefault((window.threat, window.camera), []).append(window)

    merged: list[HazardWindow] = []
    for (threat, camera), group in by_key.items():
        for window in sorted(group, key=lambda w: w.start_ms):
            if merged and merged[-1].threat == threat and merged[-1].camera == camera and window.start_ms <= merged[-1].end_ms:
                previous = merged.pop()
                merged.append(
                    HazardWindow(
                        threat=threat,
                        camera=camera,
                        start_ms=previous.start_ms,
                        end_ms=max(previous.end_ms, window.end_ms),
                        note=previous.note or window.note,
                    )
                )
            else:
                merged.append(window)
    return sorted(merged, key=lambda w: (w.camera, w.threat, w.start_ms))


def write_labels(ride_dir: Path | str, windows: list[HazardWindow]) -> Path:
    """Validates everything before writing anything — a half-written labels file
    is worse than none."""
    for window in windows:
        validate_window(window)
    directory = Path(ride_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / LABELS_NAME
    payload = {"windows": [asdict(w) for w in merge_windows(windows)]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def read_labels(ride_dir: Path | str) -> list[HazardWindow]:
    path = Path(ride_dir) / LABELS_NAME
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [HazardWindow(**w) for w in payload.get("windows", [])]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_labels.py -q`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/corpus/labels.py rdk/vision/tests/test_labels.py
git commit -m "feat(rdk): add hazard-window labels with catalog drift protection"
```

---

## Task 6: Recording session and board CLI

The only hardware-dependent task. Camera and encoder are injected, so the
session logic is testable with fakes.

**Files:**

- Create: `rdk/vision/recorder/session.py`, `rdk/vision/tools/__init__.py`, `rdk/vision/tools/record_ride.py`
- Modify: `rdk/vision/camera.py`
- Test: `rdk/vision/tests/test_session.py`

**Interfaces:**

- Consumes: `Segmenter`, `segment_name`, `ride_id`, `MetadataWriter`, `FrameMeta`, `write_ride_manifest`, `build_config`, `open_camera`, `IMX219`
- Produces:
  - `@dataclass CameraSlot(name: str, vcon: int)`
  - `class RideRecorder(root, slots, open_fn, encode_fn, clock)` with `start(now_wall_ms) -> str`, `tick(now_s, now_wall_ms) -> int`, `stop() -> None`, `active_cameras` property

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_session.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.library import scan_ride
from recorder.session import CameraSlot, RideRecorder


class FakeCamera:
    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def read(self):
        if not self.works:
            raise RuntimeError("sensor gone")
        self.frames += 1
        return b"\x00\x00\x00\x01frame"


def make_recorder(tmp_path, front_ok=True, rear_ok=True):
    cams = {"front": FakeCamera(front_ok), "rear": FakeCamera(rear_ok)}

    def open_fn(slot: CameraSlot):
        cam = cams[slot.name]
        if not cam.works:
            raise RuntimeError(f"{slot.name} failed to open")
        return cam

    def encode_fn(cam, out_path: Path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("ab") as fh:
            fh.write(cam.read())

    return RideRecorder(
        root=tmp_path,
        slots=[CameraSlot("front", 2), CameraSlot("rear", 3)],
        open_fn=open_fn,
        encode_fn=encode_fn,
    )


def test_start_records_only_the_cameras_that_opened(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    rec.start(now_wall_ms=1700)
    assert rec.active_cameras == ["front"]
    rec.stop()


def test_a_dead_camera_does_not_abort_the_ride(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    assert info.cameras == ["front"]
    assert info.segments


def test_both_cameras_record_when_both_open(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.stop()
    assert sorted(scan_ride(Path(tmp_path) / ride).cameras) == ["front", "rear"]


def test_raises_when_no_camera_opens_at_all(tmp_path):
    rec = make_recorder(tmp_path, front_ok=False, rear_ok=False)
    with pytest.raises(RuntimeError):
        rec.start(now_wall_ms=1700)


def test_tick_writes_one_metadata_record_per_camera(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=0.1, now_wall_ms=1800)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    assert [s.frame_count for s in info.segments] == [2, 2]


def test_frame_index_increases_within_a_segment(tmp_path):
    from recorder.metadata import read_metadata

    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    for i in range(3):
        rec.tick(now_s=i * 0.1, now_wall_ms=1700 + i * 100)
    rec.stop()
    metas = read_metadata(Path(tmp_path) / ride / "front" / "seg-000000.jsonl")
    assert [m.frame_index for m in metas] == [0, 1, 2]


def test_rolls_to_a_new_segment_after_the_interval(tmp_path):
    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=61.0, now_wall_ms=62700)
    rec.stop()
    names = [s.name for s in scan_ride(Path(tmp_path) / ride).segments]
    assert names == ["seg-000000", "seg-000001"]


def test_frame_index_resets_each_segment(tmp_path):
    from recorder.metadata import read_metadata

    rec = make_recorder(tmp_path, rear_ok=False)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec.tick(now_s=61.0, now_wall_ms=62700)
    rec.stop()
    metas = read_metadata(Path(tmp_path) / ride / "front" / "seg-000001.jsonl")
    assert [m.frame_index for m in metas] == [0]


def test_a_camera_failing_mid_ride_drops_only_that_camera(tmp_path):
    rec = make_recorder(tmp_path)
    ride = rec.start(now_wall_ms=1700)
    rec.tick(now_s=0.0, now_wall_ms=1700)
    rec._cameras["rear"].works = False  # sensor dies mid-ride
    rec.tick(now_s=0.1, now_wall_ms=1800)
    rec.stop()
    info = scan_ride(Path(tmp_path) / ride)
    front = [s for s in info.segments if s.camera == "front"][0]
    rear = [s for s in info.segments if s.camera == "rear"][0]
    assert front.frame_count == 2
    assert rear.frame_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_session.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'recorder.session'`

- [ ] **Step 3: Write the session**

Create `rdk/vision/recorder/session.py`:

```python
"""Ride recording session.

Cameras are independently optional by design: on this board only one MIPI port
currently streams, and a front-only corpus is still a useful corpus. A camera
that fails to open — or dies mid-ride — is dropped from the ride, never fatal to
it. Only a ride with no cameras at all is an error.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from corpus.library import write_ride_manifest
from recorder.metadata import FrameMeta, MetadataWriter
from recorder.segmenter import Segmenter, ride_id, segment_name


@dataclass(frozen=True)
class CameraSlot:
    name: str
    vcon: int


class RideRecorder:
    def __init__(
        self,
        root: Path | str,
        slots: list[CameraSlot],
        open_fn: Callable[[CameraSlot], object],
        encode_fn: Callable[[object, Path], None],
    ) -> None:
        self.root = Path(root)
        self.slots = slots
        self._open_fn = open_fn
        self._encode_fn = encode_fn
        self._cameras: dict[str, object] = {}
        self._segmenters: dict[str, Segmenter] = {}
        self._writers: dict[str, MetadataWriter] = {}
        self._frame_index: dict[str, int] = {}
        self._ride_dir: Path | None = None
        self._ride: str | None = None

    @property
    def active_cameras(self) -> list[str]:
        return list(self._cameras.keys())

    def start(self, now_wall_ms: int) -> str:
        for slot in self.slots:
            try:
                self._cameras[slot.name] = self._open_fn(slot)
            except Exception as error:  # noqa: BLE001 - one dead camera is not fatal
                print(f"[recorder] {slot.name} unavailable: {error}")

        if not self._cameras:
            raise RuntimeError("no camera opened; nothing to record")

        self._ride = ride_id(datetime.now())
        self._ride_dir = self.root / self._ride
        write_ride_manifest(
            self._ride_dir, ride=self._ride, cameras=self.active_cameras, started_wall_ms=now_wall_ms
        )
        for name in self._cameras:
            self._segmenters[name] = Segmenter()
        return self._ride

    def _open_segment(self, camera: str, now_s: float) -> None:
        index = self._segmenters[camera].roll(now_s)
        assert self._ride_dir is not None
        base = self._ride_dir / camera / segment_name(index)
        old = self._writers.pop(camera, None)
        if old is not None:
            old.close()
        self._writers[camera] = MetadataWriter(base.with_suffix(".jsonl"))
        self._frame_index[camera] = 0

    def tick(self, now_s: float, now_wall_ms: int) -> int:
        """Capture one frame per live camera. Returns how many were written, so a
        caller can notice the ride going silent."""
        assert self._ride_dir is not None, "start() first"
        written = 0
        for camera, handle in list(self._cameras.items()):
            segmenter = self._segmenters[camera]
            if segmenter.index < 0 or segmenter.should_roll(now_s):
                self._open_segment(camera, now_s)

            base = self._ride_dir / camera / segment_name(segmenter.index)
            try:
                self._encode_fn(handle, base.with_suffix(".h264"))
            except Exception as error:  # noqa: BLE001 - drop this camera, keep the ride
                print(f"[recorder] {camera} stopped: {error}")
                self._cameras.pop(camera, None)
                writer = self._writers.pop(camera, None)
                if writer is not None:
                    writer.close()
                continue

            index = self._frame_index[camera]
            self._writers[camera].append(
                FrameMeta(
                    frame_index=index,
                    mono_ns=int(now_s * 1_000_000_000),
                    wall_ms=now_wall_ms,
                    camera=camera,
                )
            )
            self._frame_index[camera] = index + 1
            written += 1
        return written

    def stop(self) -> None:
        for writer in self._writers.values():
            writer.close()
        self._writers.clear()
        self._cameras.clear()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_session.py -q`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the board CLI**

Create `rdk/vision/tools/__init__.py` (empty file).

Create `rdk/vision/tools/record_ride.py`:

```python
"""Record a ride. Runs on the board.

    python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10

Front camera is VCON 2 and rear is VCON 3 (VCON 0/1 have no connector on this
board). The rear camera is expected to fail today; that is not an error.
"""

from __future__ import annotations

import argparse
import signal
import time
from pathlib import Path

from camera_binding import IMX219, build_config, open_camera
from hobot_vio import libsrcampy
from recorder.session import CameraSlot, RideRecorder

WIDTH = 1920
HEIGHT = 1080


def _open(slot: CameraSlot):
    config = build_config(IMX219, vcon=slot.vcon, width=WIDTH, height=HEIGHT, fps=30)
    open_camera(config)
    camera = libsrcampy.Camera()
    encoder = libsrcampy.Encoder()
    encoder.encode(0, 1, WIDTH, HEIGHT)  # 1 = H.264
    return (camera, encoder)


def _encode(handle, out_path: Path) -> None:
    camera, encoder = handle
    frame = camera.get_img(2)
    if frame is None:
        raise RuntimeError("no frame")
    encoder.encode_file(frame)
    chunk = encoder.get_img()
    if chunk:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("ab") as fh:
            fh.write(chunk)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/var/lib/max/corpus")
    parser.add_argument("--fps", type=float, default=10.0)
    args = parser.parse_args()

    recorder = RideRecorder(
        root=args.root,
        slots=[CameraSlot("front", 2), CameraSlot("rear", 3)],
        open_fn=_open,
        encode_fn=_encode,
    )
    ride = recorder.start(now_wall_ms=int(time.time() * 1000))
    print(f"[recorder] recording {ride} from {recorder.active_cameras}")

    running = True

    def stop(*_args) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    period = 1.0 / args.fps
    started = time.monotonic()
    try:
        while running:
            now = time.monotonic()
            if recorder.tick(now - started, int(time.time() * 1000)) == 0:
                print("[recorder] all cameras gone; stopping")
                break
            time.sleep(max(0.0, period - (time.monotonic() - now)))
    finally:
        recorder.stop()
        print(f"[recorder] finished {ride}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Point `camera.py` at the new binding**

In `rdk/vision/camera.py`, replace the body of `CameraPair.open` with:

```python
    def open(self) -> None:
        from hobot_vio import libsrcampy  # noqa: PLC0415 - board-only import

        from camera_binding import IMX219, build_config, open_camera

        # Never use open_cam auto-detect: it searches an empty port, reports a
        # phantom ov5647, and crashes cam-service. Pin each VCON explicitly.
        for attr, vcon in (("front", int(self.front_port)), ("rear", int(self.rear_port))):
            try:
                open_camera(build_config(IMX219, vcon=vcon, width=WIDTH, height=HEIGHT, fps=30))
                setattr(self, attr, libsrcampy.Camera())
            except Exception as error:  # noqa: BLE001 - one camera is enough
                print(f"[vision] {attr} camera unavailable on vcon {vcon}: {error}")
        self.opened = self.front is not None or self.rear is not None
```

- [ ] **Step 7: Run the whole Python suite**

Run: `cd rdk/vision && python3 -m pytest tests/ -q`
Expected: PASS — all suites, including the existing `test_rpc.py`,
`test_gallery.py`, `test_camera_policy.py`.

- [ ] **Step 8: Verify on the board**

```bash
systemctl restart cam-service && sleep 3
cd /opt/max/rdk/vision
timeout 130 python3 -m tools.record_ride --root /tmp/corpus --fps 10
ls -R /tmp/corpus | head -20
```

Expected: `[recorder] recording ride-… from ['front']`, a rear-camera
"unavailable" line (expected today), two segments after ~2 minutes, each with a
`.h264` and a `.jsonl`, and `systemctl is-active cam-service` still `active`.

- [ ] **Step 9: Commit**

```bash
git add rdk/vision/recorder/session.py rdk/vision/tools rdk/vision/camera.py rdk/vision/tests/test_session.py
git commit -m "feat(rdk): record rides with independently optional cameras"
```

---

## Task 7: Labelling CLI and docs

**Files:**

- Create: `rdk/vision/tools/label.py`
- Modify: `rdk/README.md`
- Test: `rdk/vision/tests/test_label_cli.py`

**Interfaces:**

- Consumes: `HazardWindow`, `read_labels`, `write_labels`, `LabelError`, `scan_corpus`, `scan_ride`
- Produces: `parse_window_arg(text: str) -> HazardWindow`, `add_window(ride_dir, window) -> list[HazardWindow]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_label_cli.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from corpus.labels import HazardWindow, LabelError, read_labels
from tools.label import add_window, parse_window_arg


def test_parses_the_documented_argument_form():
    window = parse_window_arg("rear_approach:rear:1000:3000")
    assert window == HazardWindow(threat="rear_approach", camera="rear", start_ms=1000, end_ms=3000)


def test_parses_an_optional_note():
    window = parse_window_arg("tailgating:rear:0:5000:van sat on me")
    assert window.note == "van sat on me"


def test_rejects_a_malformed_argument():
    with pytest.raises(LabelError):
        parse_window_arg("rear_approach:rear:1000")


def test_rejects_non_numeric_bounds():
    with pytest.raises(LabelError):
        parse_window_arg("rear_approach:rear:start:end")


def test_add_window_appends_and_persists(tmp_path):
    add_window(tmp_path, parse_window_arg("tailgating:rear:0:1000"))
    add_window(tmp_path, parse_window_arg("pedestrian_ahead:front:2000:3000"))
    assert len(read_labels(tmp_path)) == 2


def test_add_window_merges_an_overlapping_repeat(tmp_path):
    add_window(tmp_path, parse_window_arg("tailgating:rear:0:1000"))
    add_window(tmp_path, parse_window_arg("tailgating:rear:500:2000"))
    windows = read_labels(tmp_path)
    assert len(windows) == 1
    assert (windows[0].start_ms, windows[0].end_ms) == (0, 2000)


def test_add_window_rejects_an_invalid_threat(tmp_path):
    with pytest.raises(LabelError):
        add_window(tmp_path, HazardWindow(threat="nope", camera="front", start_ms=0, end_ms=1))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_label_cli.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.label'`

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/tools/label.py`:

```python
"""Label hazard windows on a recorded ride. Runs on a laptop, not the board.

    python3 -m tools.label list  --root ./corpus
    python3 -m tools.label show  --ride ./corpus/ride-20260725-141900
    python3 -m tools.label add   --ride ./corpus/ride-20260725-141900 \
        rear_approach:rear:12000:15000:"car closed fast"

Windows are millisecond offsets from the start of the ride, matching the
`wall_ms` in each segment's metadata sidecar.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from corpus.labels import HazardWindow, LabelError, read_labels, write_labels
from corpus.library import scan_corpus, scan_ride


def parse_window_arg(text: str) -> HazardWindow:
    """`threat:camera:start_ms:end_ms[:note]`"""
    parts = text.split(":", 4)
    if len(parts) < 4:
        raise LabelError(f"expected threat:camera:start_ms:end_ms[:note], got {text!r}")
    threat, camera, start, end = parts[0], parts[1], parts[2], parts[3]
    try:
        start_ms, end_ms = int(start), int(end)
    except ValueError as error:
        raise LabelError(f"start and end must be integer milliseconds: {text!r}") from error
    return HazardWindow(
        threat=threat, camera=camera, start_ms=start_ms, end_ms=end_ms, note=parts[4] if len(parts) > 4 else ""
    )


def add_window(ride_dir: Path | str, window: HazardWindow) -> list[HazardWindow]:
    """Append and re-persist. write_labels validates and merges, so a repeated
    label of the same event does not inflate the hazard count."""
    windows = read_labels(ride_dir) + [window]
    write_labels(ride_dir, windows)
    return read_labels(ride_dir)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list")
    listing.add_argument("--root", required=True)

    show = sub.add_parser("show")
    show.add_argument("--ride", required=True)

    adder = sub.add_parser("add")
    adder.add_argument("--ride", required=True)
    adder.add_argument("windows", nargs="+")

    args = parser.parse_args()

    if args.command == "list":
        for ride in scan_corpus(args.root):
            mark = "labelled" if ride.labelled else "unlabelled"
            frames = sum(s.frame_count for s in ride.segments)
            print(f"{ride.ride}  {','.join(ride.cameras):12}  {len(ride.segments):3} segs  {frames:6} frames  {mark}")
        return

    if args.command == "show":
        info = scan_ride(args.ride)
        print(f"{info.ride}  cameras={','.join(info.cameras)}  segments={len(info.segments)}")
        for window in read_labels(args.ride):
            note = f"  # {window.note}" if window.note else ""
            print(f"  {window.threat:20} {window.camera:6} {window.start_ms:>8}..{window.end_ms:<8}{note}")
        return

    for raw in args.windows:
        add_window(args.ride, parse_window_arg(raw))
    print(f"{len(read_labels(args.ride))} window(s) on {args.ride}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/ -q`
Expected: PASS — every suite.

- [ ] **Step 5: Document M0 in the board README**

Append to `rdk/README.md`:

````markdown
## ADAS M0 — recording a corpus

Record on the board (Ctrl-C or SIGTERM to stop):

```bash
systemctl restart cam-service && sleep 3
cd /opt/max/rdk/vision
python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10
```

Segments are 60 s of H.264 plus a `.jsonl` metadata sidecar, so a power cut
costs at most one minute. A camera that will not open is logged and skipped —
front-only rides are expected on current hardware.

Copy the corpus off the board, then label hazard windows on a laptop:

```bash
python3 -m tools.label list --root ./corpus
python3 -m tools.label add --ride ./corpus/ride-20260725-141900 \
  rear_approach:rear:12000:15000:"car closed fast"
python3 -m tools.label show --ride ./corpus/ride-20260725-141900
```

Offsets are milliseconds from the ride start, matching `wall_ms` in the
sidecars. Only the four M1 threats are accepted: `forward_collision`,
`pedestrian_ahead`, `rear_approach`, `tailgating`.

Storage: roughly 1.8 GB per hour per camera at 10 fps / 1080p.
````

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/tools/label.py rdk/vision/tests/test_label_cli.py rdk/README.md
git commit -m "feat(rdk): add the hazard-window labelling CLI and M0 docs"
```

---

## Plan self-review

**Spec coverage.** M0's spec text asks for continuous paired recording with
per-frame metadata, a clip library, and hazard-window labelling via
`tools/label.py`. Task 6 covers recording and metadata, Task 4 the library, Tasks
5 and 7 the labels and tool. The spec's "cameras independently optional" is
carried by Tasks 4, 6, and their tests. The prerequisite the spec calls out —
`camera.py` cannot use auto-detect — is Task 1.

**Two deliberate deviations, flagged rather than hidden.**

1. **Storage format is H.264 at 10 fps, not raw frames.** Raw NV12 would be
   ~112 GB/hour, which no ride survives. 10 fps matches the rate M1 will infer
   at, so the corpus is exactly what the replay harness consumes. M1 decodes with
   ffmpeg or OpenCV on a laptop, not on the board.
2. **The encoder call in `tools/record_ride.py` (`_encode`) is the one piece
   written against an API I could not exercise**, since only `libsrcampy.Encoder`
   on real hardware can confirm the `encode`/`encode_file`/`get_img` sequence.
   It is deliberately isolated to a single injected function: the session logic
   that surrounds it is fully tested with fakes, so if the encoder call needs
   adjusting on the bench, nothing else moves. Task 6 Step 8 is where that gets
   confirmed.

**Type consistency.** `HazardWindow`, `FrameMeta`, `SegmentInfo`, `RideInfo`,
`CameraSlot`, `Segmenter`, and `CameraConfig` are each defined once and
referenced with identical field names throughout. `write_labels` /`read_labels`
and `write_ride_manifest`/`scan_ride` keep matching signatures across Tasks 4–7.
`LABELS_NAME` is defined in both `library.py` and `labels.py`; that is
intentional so `library.py` need not import the label module, and both tests
assert the same `labels.json` filename.

**Sequencing.** Task 1 gates everything that touches hardware. Tasks 2–5 are pure
and can be done in any order. Task 6 consumes 1–4; Task 7 consumes 4–5.
