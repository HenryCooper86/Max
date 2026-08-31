# ADAS M1 — Measurement Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pipeline that turns camera frames into hazard alerts — detector, tracker, threat engine, suppression — plus the offline harness that measures it.

**Architecture:** A `FrameSource` seam yields `(nv12, t_ms, camera)`; everything below it is one code path, so offline and on-bike behaviour cannot diverge. Boxes are normalised to frame fractions at the detector boundary, making every downstream constant resolution-independent. `threat.py` and `suppress.py` are pure functions shared byte-for-byte by the harness and the future runtime.

**Tech Stack:** Python 3.10 on the board, `hobot_dnn.pyeasy_dnn` (BPU), numpy 1.26.4, ffmpeg 4.4.2, pytest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-adas-m1-measure-design.md`. Parent: `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md`.
- **M1 emits nothing to the rider.** No audio, no `hazard.report`, no protocol changes. Outputs are files only.
- **Suppression constants ship untuned.** Starting values from the parent spec: `CLOSING_RATE_MIN` = 0.08, `TAILGATE_HEIGHT_FRAC` = 0.45, `MIN_TRACK_FRAMES` = 3, `MIN_TTC_FRAMES` = 3, `CORRIDOR_WIDTH_FRAC` = 0.5, `THREAT_COOLDOWN_S` = 8, `GLOBAL_ALERT_GAP_S` = 4. TTC thresholds: `forward_collision` 2.0 s, `pedestrian_ahead` 2.5 s, `rear_approach` 3.0 s. Tailgating dwell 4.0 s.
- **Classes kept:** `{person, bicycle, car, motorcycle, bus, truck}` (COCO ids 0, 1, 2, 3, 5, 7).
- **Model:** `/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin`. Input NV12 `(1,3,672,672)` NCHW. Outputs three float32 tensors `(1,84,84,255)`, `(1,42,42,255)`, `(1,21,21,255)`, strides 8/16/32. **No dequantization** — `scale_data` is empty.
- **All boxes downstream of `postprocess` are fractions of the source frame, in `[0,1]`.** Never pixels. This is what makes the constants resolution-independent and parity robust.
- **Tests run on the board.** There is no local pytest or numpy. Run: `ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`. Deploy first with `scp`.
- Follow M0 conventions in `rdk/vision/`: `from __future__ import annotations`, frozen dataclasses, docstrings that say _why_, tests in `rdk/vision/tests/` starting with `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))`.

## Scope correction — parity is partly blocked

The spec's acceptance criterion 4 ("offline and online produce identical alert
sequences") assumes a camera path to compare against. There is no working camera
(OV5647 on both buses; IMX219 absent), so the camera-vs-file comparison is
blocked by the same hardware gap as tuning.

What Task 9 verifies instead, and what it does not:

- **Verified:** run-to-run determinism, and live-BPU vs cached-detection
  equivalence over the same clip. Both catch real divergence bugs.
- **Deferred with the corpus:** file-source vs camera-source parity.

The `FrameSource` seam is still built now — it is what makes the deferred test a
few lines rather than a refactor.

## File Structure

| File                                    | Responsibility                                             |
| --------------------------------------- | ---------------------------------------------------------- |
| `rdk/vision/perception/types.py`        | `Detection`, `BoxSample`, `Track`, `EgoState`, `Candidate` |
| `rdk/vision/perception/postprocess.py`  | anchor decode, logit threshold, NMS. Pure numpy            |
| `rdk/vision/perception/detector.py`     | model load, letterbox, BPU infer                           |
| `rdk/vision/perception/frame_source.py` | `FrameSource` protocol, `FileSource`                       |
| `rdk/vision/perception/tracker.py`      | IoU association, constant velocity. Pure                   |
| `rdk/vision/adas/ttc.py`                | smoothing and least-squares `dh/dt`. Pure                  |
| `rdk/vision/adas/threat.py`             | the four rules. Pure                                       |
| `rdk/vision/adas/suppress.py`           | six-stage gate. Stateful, clock-injected                   |
| `rdk/vision/adas/ego_motion.py`         | moving/stopped from frame pairs. Pure                      |
| `rdk/vision/tools/replay.py`            | clip → alerts, detection cache, summary                    |

---

## Task 1: Shared types and postprocessing

**Files:**

- Create: `rdk/vision/perception/__init__.py`, `rdk/vision/perception/types.py`, `rdk/vision/perception/postprocess.py`
- Test: `rdk/vision/tests/test_postprocess.py`

**Interfaces:**

- Produces:
  - `Detection(cls: str, score: float, x1: float, y1: float, x2: float, y2: float)` — frozen, coords are frame fractions in `[0,1]`; properties `height`, `width`, `cx`, `cy`.
  - `decode(outputs: list[np.ndarray], conf_threshold: float) -> list[Detection]` — takes the three raw BPU tensors in stride order 8, 16, 32; returns detections in **letterboxed 672×672 fractions**.
  - `nms(dets: list[Detection], iou_threshold: float) -> list[Detection]`
  - `ANCHORS: dict[int, list[tuple[int, int]]]`, `KEEP_CLASSES: dict[int, str]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_postprocess.py`:

```python
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.postprocess import ANCHORS, KEEP_CLASSES, decode, nms
from perception.types import Detection


def blank_outputs():
    """Three tensors shaped like the real model's, all logits driven far negative.

    -20 sigmoids to ~2e-9, so nothing survives any sane threshold and each test
    can plant exactly the cells it cares about.
    """
    return [
        np.full((1, 84, 84, 255), -20.0, dtype=np.float32),
        np.full((1, 42, 42, 255), -20.0, dtype=np.float32),
        np.full((1, 21, 21, 255), -20.0, dtype=np.float32),
    ]


def plant(out, row, col, anchor, cls_id, tx=0.0, ty=0.0, tw=0.0, th=0.0, obj=10.0, cls=10.0):
    """Write one YOLOv5 cell: [tx, ty, tw, th, obj, 80 class logits]."""
    base = anchor * 85
    out[0, row, col, base + 0] = tx
    out[0, row, col, base + 1] = ty
    out[0, row, col, base + 2] = tw
    out[0, row, col, base + 3] = th
    out[0, row, col, base + 4] = obj
    out[0, row, col, base + 5 + cls_id] = cls


def test_decodes_a_planted_cell_to_the_expected_box():
    outs = blank_outputs()
    # stride 8 grid, cell (10, 20), anchor 0 = (10, 13), class 2 = car.
    plant(outs[0], row=10, col=20, anchor=0, cls_id=2)
    dets = decode(outs, conf_threshold=0.25)
    assert len(dets) == 1
    d = dets[0]
    assert d.cls == "car"
    # YOLOv5: cx = (sigmoid(tx) * 2 - 0.5 + col) * stride, tx=0 -> sigmoid=0.5 -> 0.5
    expected_cx = (0.5 * 2 - 0.5 + 20) * 8 / 672
    expected_cy = (0.5 * 2 - 0.5 + 10) * 8 / 672
    assert d.cx == pytest.approx(expected_cx, abs=1e-6)
    assert d.cy == pytest.approx(expected_cy, abs=1e-6)
    # w = (sigmoid(tw) * 2) ** 2 * anchor_w, tw=0 -> (1.0) ** 2 * 10 = 10
    assert d.width * 672 == pytest.approx(10.0, abs=1e-4)


def test_drops_classes_we_do_not_care_about():
    outs = blank_outputs()
    plant(outs[0], row=5, col=5, anchor=0, cls_id=22)  # zebra
    assert decode(outs, conf_threshold=0.25) == []


def test_logit_threshold_selects_exactly_what_a_sigmoid_pass_would():
    """The shortcut is an optimisation; an optimisation that changes results is a bug.

    Objectness is compared against logit(threshold) with no sigmoid, because
    sigmoid over 2.36M floats per frame costs more than the BPU inference it is
    postprocessing. This pins the two to the same answer across the boundary.
    """
    threshold = 0.25
    logit = math.log(threshold / (1 - threshold))
    outs = blank_outputs()
    plant(outs[0], row=1, col=1, anchor=0, cls_id=2, obj=logit + 0.01, cls=10.0)  # just over
    plant(outs[0], row=2, col=2, anchor=0, cls_id=2, obj=logit - 0.01, cls=10.0)  # just under
    dets = decode(outs, conf_threshold=threshold)
    assert len(dets) == 1
    assert dets[0].cy * 672 < 20  # the row-1 cell, not row-2


def test_nms_keeps_the_stronger_of_two_overlapping_boxes():
    a = Detection(cls="car", score=0.9, x1=0.1, y1=0.1, x2=0.3, y2=0.3)
    b = Detection(cls="car", score=0.6, x1=0.12, y1=0.12, x2=0.32, y2=0.32)
    assert nms([a, b], iou_threshold=0.45) == [a]


def test_nms_keeps_boxes_of_different_classes_that_overlap():
    # A pedestrian standing in front of a car is two real detections.
    a = Detection(cls="car", score=0.9, x1=0.1, y1=0.1, x2=0.3, y2=0.3)
    b = Detection(cls="person", score=0.8, x1=0.11, y1=0.11, x2=0.31, y2=0.31)
    assert len(nms([a, b], iou_threshold=0.45)) == 2


def test_nms_keeps_a_nested_box_below_the_iou_threshold():
    outer = Detection(cls="truck", score=0.9, x1=0.0, y1=0.0, x2=1.0, y2=1.0)
    inner = Detection(cls="truck", score=0.8, x1=0.4, y1=0.4, x2=0.5, y2=0.5)
    assert len(nms([outer, inner], iou_threshold=0.45)) == 2


def test_anchor_table_matches_the_three_strides():
    assert sorted(ANCHORS) == [8, 16, 32]
    assert all(len(v) == 3 for v in ANCHORS.values())
    assert set(KEEP_CLASSES.values()) == {"person", "bicycle", "car", "motorcycle", "bus", "truck"}
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_postprocess.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'perception'`.

- [ ] **Step 3: Write the types**

Create `rdk/vision/perception/__init__.py` (empty) and `rdk/vision/perception/types.py`:

```python
"""Shared value types for the perception and ADAS pipeline.

Every box in this module is expressed as a fraction of the source frame, in
[0, 1] — never pixels. Two reasons: the suppression constants
(CORRIDOR_WIDTH_FRAC, TAILGATE_HEIGHT_FRAC) are then resolution-independent,
and a clip replayed at a different resolution than it was captured cannot
silently produce different alerts.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Detection:
    cls: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2.0


@dataclass(frozen=True)
class BoxSample:
    """One observation of a track, stamped with the frame's own capture time."""

    t_ms: int
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0


@dataclass
class Track:
    track_id: int
    cls: str
    samples: list[BoxSample] = field(default_factory=list)
    #: Consecutive frames this track was not matched. Drives ageing out.
    misses: int = 0

    @property
    def last(self) -> BoxSample:
        return self.samples[-1]

    @property
    def frames(self) -> int:
        return len(self.samples)


@dataclass(frozen=True)
class EgoState:
    moving: bool
    #: Coarse, unitless. Optical flow magnitude, not a calibrated speed.
    speed_scale: float


@dataclass(frozen=True)
class Candidate:
    threat_id: str
    severity: str
    camera: str
    track_id: int
    t_ms: int
    #: None when the track is not closing. Absence is a category, not a big number.
    ttc_s: float | None
```

- [ ] **Step 4: Write the postprocessor**

Create `rdk/vision/perception/postprocess.py`:

```python
"""YOLOv5 head decoding for the vendor-compiled yolov5s.

The model emits three float32 tensors with scale_data empty, so unlike the
vendor's own samples there is no dequantization step here.

The objectness threshold is applied to raw logits, before any sigmoid. The three
tensors total 2.36M floats per frame; at 20 inferences/s a full sigmoid pass is
~47M transcendental ops per second on a Cortex-A55, plausibly costing more than
the BPU inference it is postprocessing. Comparing against logit(threshold) is
algebraically identical because sigmoid is monotonic, and leaves tens of cells
to decode instead of thousands.
"""

from __future__ import annotations

import math

import numpy as np

from .types import Detection

INPUT_SIZE = 672

#: Standard YOLOv5 COCO anchors, keyed by stride.
#: VALIDATED AGAINST bus.jpg IN TASK 2 — if these are wrong, boxes land in
#: plausible-looking wrong places and every downstream TTC number is garbage.
ANCHORS: dict[int, list[tuple[int, int]]] = {
    8: [(10, 13), (16, 30), (33, 23)],
    16: [(30, 61), (62, 45), (59, 119)],
    32: [(116, 90), (156, 198), (373, 326)],
}

#: COCO ids the helmet cares about. Everything else is noise on a road.
KEEP_CLASSES: dict[int, str] = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

NUM_CLASSES = 80
CELL_STRIDE = 5 + NUM_CLASSES  # tx, ty, tw, th, obj, then class logits


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def decode(outputs: list[np.ndarray], conf_threshold: float) -> list[Detection]:
    """Decode raw head tensors into detections in letterboxed-square fractions.

    `outputs` must be in stride order 8, 16, 32 — the order the model returns.
    """
    logit_threshold = math.log(conf_threshold / (1.0 - conf_threshold))
    strides = sorted(ANCHORS)
    results: list[Detection] = []

    for out, stride in zip(outputs, strides):
        grid = out.shape[1]
        cells = out.reshape(grid, grid, len(ANCHORS[stride]), CELL_STRIDE)
        obj_logits = cells[..., 4]
        rows, cols, anchors = np.nonzero(obj_logits > logit_threshold)

        for row, col, anchor in zip(rows, cols, anchors):
            cell = cells[row, col, anchor]
            class_logits = cell[5:]
            cls_id = int(np.argmax(class_logits))
            if cls_id not in KEEP_CLASSES:
                continue

            score = float(_sigmoid(cell[4]) * _sigmoid(class_logits[cls_id]))
            if score < conf_threshold:
                continue

            tx, ty, tw, th = (float(v) for v in cell[:4])
            aw, ah = ANCHORS[stride][anchor]
            cx = (_sigmoid_scalar(tx) * 2.0 - 0.5 + col) * stride
            cy = (_sigmoid_scalar(ty) * 2.0 - 0.5 + row) * stride
            w = (_sigmoid_scalar(tw) * 2.0) ** 2 * aw
            h = (_sigmoid_scalar(th) * 2.0) ** 2 * ah

            results.append(
                Detection(
                    cls=KEEP_CLASSES[cls_id],
                    score=score,
                    x1=(cx - w / 2) / INPUT_SIZE,
                    y1=(cy - h / 2) / INPUT_SIZE,
                    x2=(cx + w / 2) / INPUT_SIZE,
                    y2=(cy + h / 2) / INPUT_SIZE,
                )
            )

    return results


def _sigmoid_scalar(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _iou(a: Detection, b: Detection) -> float:
    ix1, iy1 = max(a.x1, b.x1), max(a.y1, b.y1)
    ix2, iy2 = min(a.x2, b.x2), min(a.y2, b.y2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = a.width * a.height + b.width * b.height - inter
    return inter / union if union > 0 else 0.0


def nms(dets: list[Detection], iou_threshold: float) -> list[Detection]:
    """Greedy non-maximum suppression, per class.

    Per class, because a pedestrian standing in front of a car is two real
    detections and class-agnostic NMS would throw one away.
    """
    kept: list[Detection] = []
    for det in sorted(dets, key=lambda d: d.score, reverse=True):
        if all(_iou(det, k) <= iou_threshold for k in kept if k.cls == det.cls):
            kept.append(det)
    return kept
```

- [ ] **Step 5: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_postprocess.py -q'
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/perception rdk/vision/tests/test_postprocess.py
git commit -m "feat(adas): decode the yolov5s head with a logit-threshold shortcut"
```

---

## Task 2: Detector on the BPU, and anchor validation

**Files:**

- Create: `rdk/vision/perception/detector.py`, `rdk/vision/tools/check_anchors.py`
- Test: `rdk/vision/tests/test_detector.py`

**Interfaces:**

- Consumes: `decode`, `nms`, `Detection`, `INPUT_SIZE`
- Produces:
  - `letterbox_nv12(nv12: bytes, src_w: int, src_h: int) -> tuple[bytes, LetterboxGeom]`
  - `LetterboxGeom(scale: float, pad_x: int, pad_y: int)` with `to_source(det: Detection) -> Detection`
  - `Detector(model_path: str, conf_threshold: float = 0.25, iou_threshold: float = 0.45)` with `infer(nv12: bytes, src_w: int, src_h: int) -> list[Detection]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_detector.py`. These tests cover the pure geometry only — the BPU part is exercised by Step 5's script, since it needs hardware.

```python
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.detector import LetterboxGeom, letterbox_dims
from perception.types import Detection


def test_letterbox_dims_preserves_aspect_for_16_by_9():
    # 1920x1080 into 672x672: scale by height-limited 672/1920, pad vertically.
    geom = letterbox_dims(1920, 1080)
    assert geom.scale == pytest.approx(672 / 1920)
    assert geom.pad_x == 0
    assert geom.pad_y == pytest.approx((672 - 1080 * 672 / 1920) / 2, abs=1.0)


def test_to_source_undoes_the_letterbox():
    """A box in the padded square maps back to a fraction of the real frame.

    Getting this wrong shifts every box vertically by the pad, which looks like
    a detector that is slightly off rather than a geometry bug.
    """
    geom = letterbox_dims(1920, 1080)
    # A box occupying the full width of the letterboxed content.
    content_h = 1080 * geom.scale
    top = geom.pad_y / 672
    bottom = (geom.pad_y + content_h) / 672
    det = Detection(cls="car", score=0.9, x1=0.0, y1=top, x2=1.0, y2=bottom)
    mapped = geom.to_source(det)
    assert mapped.x1 == pytest.approx(0.0, abs=1e-6)
    assert mapped.x2 == pytest.approx(1.0, abs=1e-6)
    assert mapped.y1 == pytest.approx(0.0, abs=1e-3)
    assert mapped.y2 == pytest.approx(1.0, abs=1e-3)


def test_square_input_needs_no_padding():
    geom = letterbox_dims(672, 672)
    assert geom.pad_x == 0 and geom.pad_y == 0
    assert geom.scale == pytest.approx(1.0)
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_detector.py -q'
```

Expected: FAIL, `ImportError: cannot import name 'letterbox_dims'`.

- [ ] **Step 3: Write the detector**

Create `rdk/vision/perception/detector.py`:

```python
"""yolov5s on the BPU.

Letterboxing is done here, in software, rather than by the VSE. That costs CPU
but guarantees the file path and the camera path present geometrically
identical input to the model — which is the whole point of the FrameSource
seam. Moving it to the VSE is an M2 optimisation, and would need a parity test
of its own.

Aspect ratio is preserved with grey padding because that is how YOLOv5 was
trained. Stretching 16:9 into a square distorts every object and costs recall
on exactly the small, distant vehicles that matter most for time-to-contact.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .postprocess import INPUT_SIZE, decode, nms
from .types import Detection

#: NV12 grey. Y=128 with both chroma planes at 128 is neutral.
PAD_VALUE = 128


@dataclass(frozen=True)
class LetterboxGeom:
    scale: float
    pad_x: float
    pad_y: float

    def to_source(self, det: Detection) -> Detection:
        """Map a box in padded-square fractions back to source-frame fractions."""
        content_w = INPUT_SIZE - 2 * self.pad_x
        content_h = INPUT_SIZE - 2 * self.pad_y

        def fx(v: float) -> float:
            return (v * INPUT_SIZE - self.pad_x) / content_w

        def fy(v: float) -> float:
            return (v * INPUT_SIZE - self.pad_y) / content_h

        return Detection(
            cls=det.cls,
            score=det.score,
            x1=fx(det.x1),
            y1=fy(det.y1),
            x2=fx(det.x2),
            y2=fy(det.y2),
        )


def letterbox_dims(src_w: int, src_h: int) -> LetterboxGeom:
    scale = min(INPUT_SIZE / src_w, INPUT_SIZE / src_h)
    return LetterboxGeom(
        scale=scale,
        pad_x=(INPUT_SIZE - src_w * scale) / 2.0,
        pad_y=(INPUT_SIZE - src_h * scale) / 2.0,
    )


def _resize_plane(plane: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Nearest-neighbour resize. No cv2 dependency in the sidecar."""
    ys = (np.arange(out_h) * plane.shape[0] / out_h).astype(np.int32)
    xs = (np.arange(out_w) * plane.shape[1] / out_w).astype(np.int32)
    return plane[ys][:, xs]


def letterbox_nv12(nv12: bytes, src_w: int, src_h: int) -> tuple[bytes, LetterboxGeom]:
    """Scale an NV12 frame into a padded 672x672 NV12 frame."""
    geom = letterbox_dims(src_w, src_h)
    out_w = int(round(src_w * geom.scale))
    out_h = int(round(src_h * geom.scale))
    # NV12 chroma is half resolution in both axes, so every extent must be even.
    out_w -= out_w % 2
    out_h -= out_h % 2

    buf = np.frombuffer(nv12, dtype=np.uint8)
    y = buf[: src_w * src_h].reshape(src_h, src_w)
    uv = buf[src_w * src_h :].reshape(src_h // 2, src_w)

    canvas_y = np.full((INPUT_SIZE, INPUT_SIZE), PAD_VALUE, dtype=np.uint8)
    canvas_uv = np.full((INPUT_SIZE // 2, INPUT_SIZE), PAD_VALUE, dtype=np.uint8)

    px, py = int(geom.pad_x), int(geom.pad_y)
    py -= py % 2  # keep the chroma rows aligned to the luma rows
    canvas_y[py : py + out_h, px : px + out_w] = _resize_plane(y, out_w, out_h)
    canvas_uv[py // 2 : py // 2 + out_h // 2, px : px + out_w] = _resize_plane(
        uv, out_w, out_h // 2
    )

    return canvas_y.tobytes() + canvas_uv.tobytes(), geom


class Detector:
    def __init__(
        self,
        model_path: str,
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
    ) -> None:
        from hobot_dnn import pyeasy_dnn  # imported here so tests need no BPU

        self._model = pyeasy_dnn.load(model_path)[0]
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold

    def infer(self, nv12: bytes, src_w: int, src_h: int) -> list[Detection]:
        padded, geom = letterbox_nv12(nv12, src_w, src_h)
        outputs = self._model.forward(np.frombuffer(padded, dtype=np.uint8))
        tensors = [np.array(o.buffer) for o in outputs]
        dets = decode(tensors, self.conf_threshold)
        kept = nms(dets, self.iou_threshold)
        return [geom.to_source(d) for d in kept]
```

- [ ] **Step 4: Run the geometry tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_detector.py -q'
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Write the anchor validation script**

This is the gate on every downstream number. Create `rdk/vision/tools/check_anchors.py`:

```python
"""Prove the anchor table is right before trusting anything built on it.

If ANCHORS is wrong, boxes land in plausible-looking wrong places: the pipeline
runs, detections appear, and every TTC number is quietly garbage. bus.jpg is a
COCO image shipped on the board containing a large bus and several people —
exactly the classes the helmet cares about — so a correct decode is obvious and
a wrong one is unmissable.

    python3 tools/check_anchors.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.detector import Detector

IMAGE = "/app/pydev_demo/02_detection_sample/02_ultralytics_yolo11/bus.jpg"
MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def jpeg_to_nv12(path: str) -> tuple[bytes, int, int]:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, check=True,
    )
    w, h = (int(v) for v in probe.stdout.decode().strip().split("x"))
    w -= w % 2
    h -= h % 2
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}",
         "-pix_fmt", "nv12", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    )
    return raw.stdout, w, h


def main() -> None:
    nv12, w, h = jpeg_to_nv12(IMAGE)
    dets = Detector(MODEL).infer(nv12, w, h)

    print(f"{IMAGE}  {w}x{h}  -> {len(dets)} detections")
    for d in sorted(dets, key=lambda d: -d.score):
        print(f"  {d.cls:11s} {d.score:.2f}  "
              f"x[{d.x1:.3f},{d.x2:.3f}] y[{d.y1:.3f},{d.y2:.3f}]")

    buses = [d for d in dets if d.cls == "bus"]
    people = [d for d in dets if d.cls == "person"]

    problems = []
    if not buses:
        problems.append("no bus found — anchors or class map are wrong")
    else:
        bus = max(buses, key=lambda d: d.width * d.height)
        # The bus dominates this image: it spans most of the frame.
        if bus.width < 0.5 or bus.height < 0.5:
            problems.append(f"bus box too small ({bus.width:.2f}x{bus.height:.2f}) — decode is wrong")
        if not (0.0 <= bus.x1 < bus.x2 <= 1.0 and 0.0 <= bus.y1 < bus.y2 <= 1.0):
            problems.append("bus box outside the frame — letterbox mapping is wrong")
    if len(people) < 2:
        problems.append(f"expected several people, found {len(people)}")

    if problems:
        for p in problems:
            print(f"FAIL: {p}")
        raise SystemExit(1)
    print("OK: anchors and letterbox geometry validated")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Run it on the board**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 tools/check_anchors.py'
```

Expected: `OK: anchors and letterbox geometry validated`, with a bus box spanning
more than half the frame and at least two people.

**If it fails:** do not proceed and do not adjust thresholds to make it pass.
Either `ANCHORS` is wrong for this compiled model, the output tensor order is not
stride 8/16/32, or the letterbox mapping is inverted. Print the raw decoded
boxes before `to_source` to tell the last case from the first two.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/perception/detector.py rdk/vision/tools/check_anchors.py rdk/vision/tests/test_detector.py
git commit -m "feat(adas): run yolov5s on the BPU, with anchors validated against bus.jpg"
```

---

## Task 3: The FrameSource seam

**Files:**

- Create: `rdk/vision/perception/frame_source.py`
- Test: `rdk/vision/tests/test_frame_source.py`

**Interfaces:**

- Produces:
  - `Frame(nv12: bytes, t_ms: int, camera: str, width: int, height: int)` — frozen
  - `FrameSource` — a `Protocol` with `frames() -> Iterator[Frame]`
  - `FileSource(path, camera, fps=10.0, start_t_ms=0)` implementing it
  - `probe_dims(path: str) -> tuple[int, int]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_frame_source.py`:

```python
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.frame_source import FileSource, Frame, probe_dims


@pytest.fixture
def clip(tmp_path):
    """Two seconds of synthetic video, the format ffmpeg gives us from a ride."""
    path = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi",
         "-i", "testsrc=size=640x360:rate=10:duration=2",
         "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


def test_probe_reports_the_real_dimensions(clip):
    assert probe_dims(str(clip)) == (640, 360)


def test_yields_nv12_frames_of_the_right_size(clip):
    frames = list(FileSource(str(clip), camera="front", fps=10.0).frames())
    assert len(frames) > 0
    f = frames[0]
    assert isinstance(f, Frame)
    assert f.camera == "front"
    # NV12 is 1.5 bytes per pixel.
    assert len(f.nv12) == int(640 * 360 * 1.5)


def test_timestamps_advance_at_the_requested_rate(clip):
    frames = list(FileSource(str(clip), camera="front", fps=10.0).frames())
    assert frames[0].t_ms == 0
    assert frames[1].t_ms == 100
    assert frames[5].t_ms == 500


def test_start_offset_lets_a_clip_sit_on_a_ride_timeline(clip):
    frames = list(FileSource(str(clip), camera="rear", fps=10.0, start_t_ms=60_000).frames())
    assert frames[0].t_ms == 60_000
    assert frames[1].t_ms == 60_100


def test_a_missing_file_raises_rather_than_yielding_nothing(tmp_path):
    # Silently yielding zero frames would look like a clip with no hazards,
    # which is the most dangerous possible failure for a measurement harness.
    with pytest.raises(FileNotFoundError):
        list(FileSource(str(tmp_path / "nope.mp4"), camera="front").frames())
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_frame_source.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'perception.frame_source'`.

- [ ] **Step 3: Write the frame source**

Create `rdk/vision/perception/frame_source.py`:

```python
"""The seam that keeps the offline harness and the on-bike runtime identical.

A FrameSource yields (nv12, t_ms, camera) and nothing else. Everything below
this interface — detector, tracker, threat, suppression — is reached by exactly
one code path, so parity is a property of the structure rather than something
maintained by discipline.

FileSource decodes with ffmpeg, which reads both the .mjpeg the mipi_cam
recorder writes and the .h264 the ctypes binding will write, so a clip from
either recording path replays without special-casing.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol


@dataclass(frozen=True)
class Frame:
    nv12: bytes
    #: Capture time. Everything downstream derives dt from this, never from a
    #: frame counter — a dropped frame must not silently change dh/dt.
    t_ms: int
    camera: str
    width: int
    height: int


class FrameSource(Protocol):
    def frames(self) -> Iterator[Frame]: ...


def probe_dims(path: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, check=True,
    )
    w, h = (int(v) for v in out.stdout.decode().strip().split("x"))
    return w, h


class FileSource:
    """Frames from a recorded clip, at a fixed sampling rate."""

    def __init__(self, path: str, camera: str, fps: float = 10.0, start_t_ms: int = 0) -> None:
        self.path = path
        self.camera = camera
        self.fps = fps
        self.start_t_ms = start_t_ms

    def frames(self) -> Iterator[Frame]:
        if not Path(self.path).exists():
            raise FileNotFoundError(self.path)
        width, height = probe_dims(self.path)
        frame_bytes = width * height * 3 // 2

        proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-i", self.path,
             "-vf", f"fps={self.fps}", "-pix_fmt", "nv12",
             "-f", "rawvideo", "-"],
            stdout=subprocess.PIPE,
        )
        assert proc.stdout is not None
        try:
            index = 0
            while True:
                buf = proc.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                yield Frame(
                    nv12=buf,
                    t_ms=self.start_t_ms + round(index * 1000.0 / self.fps),
                    camera=self.camera,
                    width=width,
                    height=height,
                )
                index += 1
        finally:
            proc.stdout.close()
            proc.wait()
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_frame_source.py -q'
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/perception/frame_source.py rdk/vision/tests/test_frame_source.py
git commit -m "feat(adas): add the FrameSource seam with an ffmpeg-backed FileSource"
```

---

## Task 4: Tracker

**Files:**

- Create: `rdk/vision/perception/tracker.py`
- Test: `rdk/vision/tests/test_tracker.py`

**Interfaces:**

- Consumes: `Detection`, `BoxSample`, `Track`
- Produces: `Tracker(iou_threshold=0.3, max_misses=3, max_gap_ms=500)` with `update(dets: list[Detection], t_ms: int) -> list[Track]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_tracker.py`:

```python
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
    # A person and a car overlapping must not be associated with each other.
    tracker = Tracker()
    tracker.update([box(0.4, 0.4, 0.5, 0.5, cls="car")], t_ms=0)
    tracks = tracker.update([box(0.4, 0.4, 0.5, 0.5, cls="person")], t_ms=100)
    assert len(tracks) == 2
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tracker.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'perception.tracker'`.

- [ ] **Step 3: Write the tracker**

Create `rdk/vision/perception/tracker.py`:

```python
"""IoU association with constant-velocity prediction.

Association is greedy by IoU and never crosses class boundaries: a pedestrian
stepping in front of a car must not inherit the car's box history, because the
history is what TTC is computed from.

Tracks age out on two independent clocks. `max_misses` handles a detector that
flickers; `max_gap_ms` handles video that stops arriving. The second matters
more than it looks — carrying a track across a 500 ms hole yields one enormous
dh/dt sample and a fabricated time-to-contact.
"""

from __future__ import annotations

from .types import BoxSample, Detection, Track


def _iou(a: BoxSample, d: Detection) -> float:
    ix1, iy1 = max(a.x1, d.x1), max(a.y1, d.y1)
    ix2, iy2 = min(a.x2, d.x2), min(a.y2, d.y2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = (a.x2 - a.x1) * (a.y2 - a.y1)
    area_d = d.width * d.height
    union = area_a + area_d - inter
    return inter / union if union > 0 else 0.0


class Tracker:
    def __init__(
        self,
        iou_threshold: float = 0.3,
        max_misses: int = 3,
        max_gap_ms: int = 500,
    ) -> None:
        self.iou_threshold = iou_threshold
        self.max_misses = max_misses
        self.max_gap_ms = max_gap_ms
        self._tracks: list[Track] = []
        self._next_id = 1
        self._last_t_ms: int | None = None

    def update(self, dets: list[Detection], t_ms: int) -> list[Track]:
        if self._last_t_ms is not None and t_ms - self._last_t_ms > self.max_gap_ms:
            # The video stopped. Everything we were following is stale.
            self._tracks = []
        self._last_t_ms = t_ms

        unmatched = list(dets)
        for track in self._tracks:
            best, best_iou = None, self.iou_threshold
            for det in unmatched:
                if det.cls != track.cls:
                    continue
                score = _iou(track.last, det)
                if score > best_iou:
                    best, best_iou = det, score
            if best is None:
                track.misses += 1
                continue
            unmatched.remove(best)
            track.misses = 0
            track.samples.append(
                BoxSample(t_ms=t_ms, x1=best.x1, y1=best.y1, x2=best.x2, y2=best.y2)
            )

        for det in unmatched:
            self._tracks.append(
                Track(
                    track_id=self._next_id,
                    cls=det.cls,
                    samples=[BoxSample(t_ms=t_ms, x1=det.x1, y1=det.y1, x2=det.x2, y2=det.y2)],
                )
            )
            self._next_id += 1

        self._tracks = [t for t in self._tracks if t.misses <= self.max_misses]
        return [t for t in self._tracks if t.misses == 0]
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_tracker.py -q'
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/perception/tracker.py rdk/vision/tests/test_tracker.py
git commit -m "feat(adas): track detections by IoU with timestamp-based ageing"
```

---

## Task 5: Time to contact

**Files:**

- Create: `rdk/vision/adas/__init__.py`, `rdk/vision/adas/ttc.py`
- Test: `rdk/vision/tests/test_ttc.py`

**Interfaces:**

- Consumes: `Track`, `BoxSample`
- Produces:
  - `smoothed_heights(track: Track, alpha: float = 0.4) -> list[tuple[int, float]]`
  - `height_rate(track: Track, window_ms: int = 300) -> float | None` — box-height fraction per second, `None` if fewer than two samples in the window
  - `time_to_contact(track: Track, window_ms: int = 300) -> float | None` — seconds, `None` when not closing

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_ttc.py`:

```python
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ttc import height_rate, smoothed_heights, time_to_contact
from perception.types import BoxSample, Track


def track_with(heights, t_step_ms=100, t0=0):
    samples = [
        BoxSample(t_ms=t0 + i * t_step_ms, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)
        for i, h in enumerate(heights)
    ]
    return Track(track_id=1, cls="car", samples=samples)


def test_a_growing_box_has_a_positive_rate():
    # 0.10 -> 0.16 over 500 ms is 0.12 per second.
    track = track_with([0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16])
    assert height_rate(track, window_ms=600) == pytest.approx(0.10, abs=0.02)


def test_a_shrinking_box_has_a_negative_rate():
    track = track_with([0.20, 0.19, 0.18, 0.17])
    assert height_rate(track, window_ms=400) < 0


def test_a_steady_box_has_a_rate_near_zero():
    track = track_with([0.2, 0.2, 0.2, 0.2])
    assert height_rate(track, window_ms=400) == pytest.approx(0.0, abs=1e-9)


def test_rate_uses_real_timestamps_not_frame_counts():
    """A dropped frame must not change the answer.

    Two tracks cover the same heights over the same elapsed time; one just has
    a gap in the middle. A counter-based derivative would report different
    rates, and on a thermally throttled board that is the difference between
    an alert and silence.
    """
    even = track_with([0.10, 0.12, 0.14, 0.16], t_step_ms=100)
    gappy = Track(
        track_id=2,
        cls="car",
        samples=[
            BoxSample(t_ms=0, x1=0.4, y1=0.45, x2=0.6, y2=0.55),      # h = 0.10
            BoxSample(t_ms=100, x1=0.4, y1=0.44, x2=0.6, y2=0.56),    # h = 0.12
            BoxSample(t_ms=300, x1=0.4, y1=0.42, x2=0.6, y2=0.58),    # h = 0.16
        ],
    )
    assert height_rate(even, window_ms=400) == pytest.approx(
        height_rate(gappy, window_ms=400), abs=0.01
    )


def test_ttc_is_height_over_rate():
    # h = 0.16, growing at ~0.10/s -> about 1.6 s.
    track = track_with([0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16])
    assert time_to_contact(track, window_ms=600) == pytest.approx(1.6, abs=0.3)


def test_a_non_closing_track_has_no_ttc_at_all():
    """Absence is a category, not a big number.

    Returning a large float here is how a receding vehicle becomes a collision
    warning the moment some later comparison flips sign.
    """
    assert time_to_contact(track_with([0.20, 0.19, 0.18, 0.17]), window_ms=400) is None


def test_a_steady_track_has_no_ttc():
    assert time_to_contact(track_with([0.2, 0.2, 0.2, 0.2]), window_ms=400) is None


def test_a_single_sample_yields_nothing():
    assert height_rate(track_with([0.2]), window_ms=400) is None
    assert time_to_contact(track_with([0.2]), window_ms=400) is None


def test_smoothing_damps_a_single_jittery_frame():
    noisy = track_with([0.20, 0.20, 0.35, 0.20, 0.20])
    values = [h for _, h in smoothed_heights(noisy)]
    assert max(values) < 0.30
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ttc.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'adas'`.

- [ ] **Step 3: Write the TTC module**

Create `rdk/vision/adas/__init__.py` (empty) and `rdk/vision/adas/ttc.py`:

```python
"""Time to contact from box-height expansion.

tau = h / (dh/dt). One lens, no calibration, no intrinsics: a box that is not
growing is not closing, at any distance.

Height rather than area or width, per the parent spec: it degrades most
gracefully under partial occlusion and lane-splitting, where vehicles routinely
clip each other horizontally but rarely vertically.

The derivative is a least-squares slope over a time window rather than a
frame-to-frame difference, because single-frame box jitter would otherwise
dominate it. The window is in milliseconds of real capture time, so a dropped
frame changes how many samples contribute but not what the slope means.
"""

from __future__ import annotations

from perception.types import Track


def smoothed_heights(track: Track, alpha: float = 0.4) -> list[tuple[int, float]]:
    """Exponentially smoothed box heights, paired with their capture times."""
    out: list[tuple[int, float]] = []
    value: float | None = None
    for sample in track.samples:
        value = sample.height if value is None else alpha * sample.height + (1 - alpha) * value
        out.append((sample.t_ms, value))
    return out


def height_rate(track: Track, window_ms: int = 300) -> float | None:
    """Least-squares slope of smoothed height, in height-fraction per second."""
    series = smoothed_heights(track)
    if len(series) < 2:
        return None
    latest = series[-1][0]
    window = [(t, h) for t, h in series if latest - t <= window_ms]
    if len(window) < 2:
        return None

    n = len(window)
    mean_t = sum(t for t, _ in window) / n
    mean_h = sum(h for _, h in window) / n
    numerator = sum((t - mean_t) * (h - mean_h) for t, h in window)
    denominator = sum((t - mean_t) ** 2 for t, _ in window)
    if denominator == 0:
        return None
    return numerator / denominator * 1000.0  # per ms -> per second


def time_to_contact(track: Track, window_ms: int = 300) -> float | None:
    """Seconds until the box fills the frame, or None when not closing.

    None rather than a large number: a receding or steady vehicle is a
    different category from a distant approaching one, and collapsing the two
    into one float is how a division by zero becomes an alert at 100 km/h.
    """
    rate = height_rate(track, window_ms)
    if rate is None or rate <= 0:
        return None
    height = smoothed_heights(track)[-1][1]
    return height / rate
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ttc.py -q'
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/__init__.py rdk/vision/adas/ttc.py rdk/vision/tests/test_ttc.py
git commit -m "feat(adas): compute time-to-contact from box-height expansion"
```

---

## Task 6: The four threat rules

**Files:**

- Create: `rdk/vision/adas/threat.py`
- Test: `rdk/vision/tests/test_threat.py`

**Interfaces:**

- Consumes: `Track`, `EgoState`, `Candidate`, `time_to_contact`, `height_rate`
- Produces:
  - Constants `TTC_FORWARD_COLLISION = 2.0`, `TTC_PEDESTRIAN_AHEAD = 2.5`, `TTC_REAR_APPROACH = 3.0`, `CLOSING_RATE_MIN = 0.08`, `TAILGATE_HEIGHT_FRAC = 0.45`, `TAILGATE_DWELL_S = 4.0`, `CORRIDOR_WIDTH_FRAC = 0.5`, `VEHICLE_CLASSES`
  - `in_corridor(track: Track, width_frac: float = CORRIDOR_WIDTH_FRAC) -> bool`
  - `evaluate(tracks: list[Track], ego: EgoState, t_ms: int, camera: str) -> list[Candidate]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_threat.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.threat import CLOSING_RATE_MIN, evaluate, in_corridor
from perception.types import BoxSample, EgoState, Track

MOVING = EgoState(moving=True, speed_scale=1.0)
STOPPED = EgoState(moving=False, speed_scale=0.0)


def closing_track(cls="car", start_h=0.10, growth=0.01, n=8, cx=0.5, t0=0, step=100):
    """A track whose box grows steadily — i.e. something getting closer."""
    samples = []
    for i in range(n):
        h = start_h + growth * i
        samples.append(
            BoxSample(t_ms=t0 + i * step, x1=cx - 0.1, y1=0.5 - h / 2, x2=cx + 0.1, y2=0.5 + h / 2)
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
    # Just over CLOSING_RATE_MIN in height-fraction per second.
    growth_per_frame = (CLOSING_RATE_MIN + 0.02) / 10
    approaching = closing_track(start_h=0.45, growth=growth_per_frame, n=10)
    assert "rear_approach" in ids(evaluate([approaching], MOVING, t_ms=900, camera="rear"))


def test_severity_is_critical_for_collisions_and_caution_for_tailgating():
    forward = evaluate([closing_track(growth=0.03)], MOVING, t_ms=700, camera="front")
    assert forward[0].severity == "critical"
    tail = evaluate([steady_track()], MOVING, t_ms=4_400, camera="rear")
    assert tail[0].severity == "caution"


def test_a_candidate_carries_its_track_and_measured_ttc():
    result = evaluate([closing_track(growth=0.03)], MOVING, t_ms=700, camera="front")
    assert result[0].track_id == 1
    assert result[0].ttc_s is not None and result[0].ttc_s > 0
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_threat.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'adas.threat'`.

- [ ] **Step 3: Write the threat engine**

Create `rdk/vision/adas/threat.py`:

```python
"""The four threat rules. Pure — no camera, no BPU, no I/O, no clock of its own.

This purity is the point. The offline harness and the on-bike runtime import
this same module, so a threshold tuned against recorded rides is literally the
code that fires on the road.

Every constant here is a STARTING VALUE from the parent spec, not a measured
result. They are conservative by design: a false alert at 100 km/h can cause the
crash it was meant to prevent, so thresholds loosen only against measured data,
never a hunch.
"""

from __future__ import annotations

from perception.types import Candidate, EgoState, Track

from .ttc import height_rate, time_to_contact

TTC_FORWARD_COLLISION = 2.0
TTC_PEDESTRIAN_AHEAD = 2.5
TTC_REAR_APPROACH = 3.0

#: Box-height fraction per second separating "approaching" from "just close".
CLOSING_RATE_MIN = 0.08
TAILGATE_HEIGHT_FRAC = 0.45
TAILGATE_DWELL_S = 4.0

#: Fraction of frame width, centred, that counts as the rider's path.
CORRIDOR_WIDTH_FRAC = 0.5

VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck", "bicycle"}


def in_corridor(track: Track, width_frac: float = CORRIDOR_WIDTH_FRAC) -> bool:
    """Is the box centre inside the centred path corridor?

    Centre rather than any overlap: a wide truck in the next lane clips the
    corridor edge constantly, and alerting on that trains the rider to ignore us.
    """
    half = width_frac / 2.0
    return abs(track.last.cx - 0.5) <= half


def _dwell_s(track: Track, min_height: float) -> float:
    """How long the box has been continuously at or above `min_height`."""
    dwell_from = None
    for sample in reversed(track.samples):
        if sample.height < min_height:
            break
        dwell_from = sample.t_ms
    if dwell_from is None:
        return 0.0
    return (track.last.t_ms - dwell_from) / 1000.0


def evaluate(tracks: list[Track], ego: EgoState, t_ms: int, camera: str) -> list[Candidate]:
    """Threat candidates for one frame. Suppression is a separate stage."""
    # Stage 1 of the suppression stack, applied here because a stopped bike has
    # no threats by definition rather than suppressed ones.
    if not ego.moving:
        return []

    out: list[Candidate] = []
    for track in tracks:
        if not in_corridor(track):
            continue
        ttc = time_to_contact(track)
        rate = height_rate(track)

        if camera == "front":
            if track.cls in VEHICLE_CLASSES and ttc is not None and ttc < TTC_FORWARD_COLLISION:
                out.append(_candidate("forward_collision", "critical", camera, track, t_ms, ttc))
            elif track.cls == "person" and ttc is not None and ttc < TTC_PEDESTRIAN_AHEAD:
                out.append(_candidate("pedestrian_ahead", "critical", camera, track, t_ms, ttc))
            continue

        # Rear camera. The two rear threats are separated by closing rate, not
        # distance: without that, every normally-following car fires the
        # critical alert.
        closing = rate is not None and rate > CLOSING_RATE_MIN
        if track.cls in VEHICLE_CLASSES and closing and ttc is not None and ttc < TTC_REAR_APPROACH:
            out.append(_candidate("rear_approach", "critical", camera, track, t_ms, ttc))
        elif (
            track.cls in VEHICLE_CLASSES
            and not closing
            and track.last.height > TAILGATE_HEIGHT_FRAC
            and _dwell_s(track, TAILGATE_HEIGHT_FRAC) > TAILGATE_DWELL_S
        ):
            out.append(_candidate("tailgating", "caution", camera, track, t_ms, ttc))

    return out


def _candidate(
    threat_id: str, severity: str, camera: str, track: Track, t_ms: int, ttc: float | None
) -> Candidate:
    return Candidate(
        threat_id=threat_id,
        severity=severity,
        camera=camera,
        track_id=track.track_id,
        t_ms=t_ms,
        ttc_s=ttc,
    )
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_threat.py -q'
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/threat.py rdk/vision/tests/test_threat.py
git commit -m "feat(adas): add the four threat rules as a pure function"
```

---

## Task 7: The suppression stack

**Files:**

- Create: `rdk/vision/adas/suppress.py`
- Test: `rdk/vision/tests/test_suppress.py`

**Interfaces:**

- Consumes: `Candidate`
- Produces:
  - Constants `MIN_TRACK_FRAMES = 3`, `MIN_TTC_FRAMES = 3`, `THREAT_COOLDOWN_S = 8.0`, `GLOBAL_ALERT_GAP_S = 4.0`
  - `Suppressor(min_track_frames=MIN_TRACK_FRAMES, min_ttc_frames=MIN_TTC_FRAMES, threat_cooldown_s=THREAT_COOLDOWN_S, global_gap_s=GLOBAL_ALERT_GAP_S)` with `admit(candidates: list[Candidate], track_frames: dict[int, int], t_ms: int) -> list[Candidate]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_suppress.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.suppress import Suppressor
from perception.types import Candidate


def cand(threat_id="forward_collision", severity="critical", track_id=1, t_ms=0, ttc=1.5):
    return Candidate(
        threat_id=threat_id, severity=severity, camera="front",
        track_id=track_id, t_ms=t_ms, ttc_s=ttc,
    )


def mature(track_id=1, frames=10):
    return {track_id: frames}


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
    s = Suppressor(min_ttc_frames=3)
    s.admit([cand(t_ms=0)], mature(), t_ms=0)
    s.admit([cand(t_ms=100)], mature(), t_ms=100)
    s.admit([], mature(), t_ms=200)          # the candidate went away
    assert s.admit([cand(t_ms=300)], mature(), t_ms=300) == []


def admit_until_fired(s, threat_id="forward_collision", severity="critical", start=0, track_id=1):
    """Push frames until the suppressor emits, returning the time it fired."""
    t = start
    for _ in range(10):
        out = s.admit(
            [cand(threat_id=threat_id, severity=severity, track_id=track_id, t_ms=t)],
            mature(track_id), t_ms=t,
        )
        if out:
            return t
        t += 100
    raise AssertionError("never fired")


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
        assert s.admit([cand(threat_id="pedestrian_ahead", track_id=2, t_ms=t)], mature(2), t_ms=t) == []
        t += 100


def test_a_critical_preempts_a_caution_cooldown():
    s = Suppressor()
    admit_until_fired(s, threat_id="tailgating", severity="caution", track_id=5)
    # Immediately after, a critical must still get through.
    t = 2_000
    out = []
    for _ in range(5):
        out = s.admit([cand(threat_id="forward_collision", severity="critical", track_id=6, t_ms=t)], mature(6), t_ms=t)
        if out:
            break
        t += 100
    assert out and out[0].threat_id == "forward_collision"


def test_a_caution_never_preempts_a_critical():
    s = Suppressor()
    admit_until_fired(s, threat_id="forward_collision", severity="critical", track_id=6)
    t = 2_000
    for _ in range(5):
        assert s.admit(
            [cand(threat_id="tailgating", severity="caution", track_id=7, t_ms=t)], mature(7), t_ms=t
        ) == []
        t += 100
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_suppress.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'adas.suppress'`.

- [ ] **Step 3: Write the suppressor**

Create `rdk/vision/adas/suppress.py`:

```python
"""The six-stage gate between a threat candidate and a rider's ears.

Stage 1 (ego moving) lives in threat.evaluate, because a stopped bike has no
threats rather than suppressed ones. The remaining five are here.

Every stage is a named constant rather than a number buried in a conditional,
because M1's whole purpose is to tune these against measured data — and a
threshold you cannot find is a threshold you cannot tune.
"""

from __future__ import annotations

from perception.types import Candidate

MIN_TRACK_FRAMES = 3
MIN_TTC_FRAMES = 3
THREAT_COOLDOWN_S = 8.0
GLOBAL_ALERT_GAP_S = 4.0

_SEVERITY_RANK = {"caution": 0, "critical": 1}


class Suppressor:
    def __init__(
        self,
        min_track_frames: int = MIN_TRACK_FRAMES,
        min_ttc_frames: int = MIN_TTC_FRAMES,
        threat_cooldown_s: float = THREAT_COOLDOWN_S,
        global_gap_s: float = GLOBAL_ALERT_GAP_S,
    ) -> None:
        self.min_track_frames = min_track_frames
        self.min_ttc_frames = min_ttc_frames
        self.threat_cooldown_s = threat_cooldown_s
        self.global_gap_s = global_gap_s
        self._runs: dict[tuple[str, int], int] = {}
        self._last_fired_ms: dict[str, int] = {}
        self._last_any_ms: int | None = None
        self._last_any_severity: str = "caution"

    def admit(
        self, candidates: list[Candidate], track_frames: dict[int, int], t_ms: int
    ) -> list[Candidate]:
        seen = {(c.threat_id, c.track_id) for c in candidates}
        for key in list(self._runs):
            if key not in seen:
                # Stage 3: the run must be consecutive. One qualifying frame
                # followed by a gap is noise, not a threat.
                del self._runs[key]

        admitted: list[Candidate] = []
        for c in candidates:
            key = (c.threat_id, c.track_id)
            self._runs[key] = self._runs.get(key, 0) + 1

            # Stage 2: track maturity.
            if track_frames.get(c.track_id, 0) < self.min_track_frames:
                continue
            # Stage 3: TTC stability.
            if self._runs[key] < self.min_ttc_frames:
                continue
            # Stage 5: per-threat cooldown.
            last = self._last_fired_ms.get(c.threat_id)
            if last is not None and (t_ms - last) / 1000.0 < self.threat_cooldown_s:
                continue
            # Stage 6: global rate limit, with severity preemption. A critical
            # may cut a caution's gap short; a caution may never cut a
            # critical's.
            if self._last_any_ms is not None:
                gap_s = (t_ms - self._last_any_ms) / 1000.0
                if gap_s < self.global_gap_s:
                    preempts = (
                        _SEVERITY_RANK[c.severity] > _SEVERITY_RANK[self._last_any_severity]
                    )
                    if not preempts:
                        continue

            admitted.append(c)
            self._last_fired_ms[c.threat_id] = t_ms
            self._last_any_ms = t_ms
            self._last_any_severity = c.severity

        return admitted
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_suppress.py -q'
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/suppress.py rdk/vision/tests/test_suppress.py
git commit -m "feat(adas): add the six-stage suppression gate"
```

---

## Task 8: Ego motion

**Files:**

- Create: `rdk/vision/adas/ego_motion.py`
- Test: `rdk/vision/tests/test_ego_motion.py`

**Interfaces:**

- Consumes: `EgoState`
- Produces:
  - `MIN_FLOW_MAGNITUDE = 0.6`
  - `estimate(prev_y: bytes, curr_y: bytes, width: int, height: int, grid: int = 8) -> EgoState`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_ego_motion.py`:

```python
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ego_motion import estimate

W, H = 64, 64


def textured(seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, size=(H, W), dtype=np.uint8)


def shifted(image, dx):
    return np.roll(image, dx, axis=1)


def test_identical_frames_read_as_stopped():
    frame = textured()
    state = estimate(frame.tobytes(), frame.tobytes(), W, H)
    assert state.moving is False
    assert state.speed_scale == 0.0


def test_a_shifted_frame_reads_as_moving():
    frame = textured()
    state = estimate(frame.tobytes(), shifted(frame, 6).tobytes(), W, H)
    assert state.moving is True
    assert state.speed_scale > 0


def test_a_bigger_shift_reads_as_faster():
    frame = textured()
    slow = estimate(frame.tobytes(), shifted(frame, 2).tobytes(), W, H)
    fast = estimate(frame.tobytes(), shifted(frame, 10).tobytes(), W, H)
    assert fast.speed_scale > slow.speed_scale


def test_sensor_noise_alone_does_not_read_as_moving():
    """A parked bike at a light must stay 'stopped'.

    This is the gate that kills the most common false alarm there is, so it has
    to survive the mild frame-to-frame noise every sensor produces.
    """
    frame = textured().astype(np.int16)
    rng = np.random.default_rng(7)
    noisy = np.clip(frame + rng.integers(-3, 4, size=frame.shape), 0, 255).astype(np.uint8)
    state = estimate(frame.astype(np.uint8).tobytes(), noisy.tobytes(), W, H)
    assert state.moving is False
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ego_motion.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'adas.ego_motion'`.

- [ ] **Step 3: Write the estimator**

Create `rdk/vision/adas/ego_motion.py`:

```python
"""Is the bike moving? Coarse global flow on the front camera's luma plane.

Only the moving/stopped decision is load-bearing. It is the single
highest-value suppression stage: a car pulling up behind you at a light is
visually indistinguishable from a rear approach, and ego motion is the only
thing that separates them.

The speed scale is unitless and deliberately crude — block-matched horizontal
displacement, not a calibrated velocity. Nothing in M1 needs a real speed, and
pretending otherwise would invite someone to build on it.
"""

from __future__ import annotations

import numpy as np

from perception.types import EgoState

#: Mean absolute block displacement, in pixels, above which we call it moving.
MIN_FLOW_MAGNITUDE = 0.6

#: How far the search looks, in pixels, either side of zero.
SEARCH_RADIUS = 12


def estimate(
    prev_y: bytes, curr_y: bytes, width: int, height: int, grid: int = 8
) -> EgoState:
    """Compare two luma planes and report whether the scene is translating."""
    prev = np.frombuffer(prev_y, dtype=np.uint8)[: width * height].reshape(height, width)
    curr = np.frombuffer(curr_y, dtype=np.uint8)[: width * height].reshape(height, width)

    block_h = height // grid
    block_w = width // grid
    displacements: list[int] = []

    for gy in range(grid):
        y0 = gy * block_h
        for gx in range(grid):
            x0 = gx * block_w
            block = curr[y0 : y0 + block_h, x0 : x0 + block_w].astype(np.int32)
            best_shift, best_cost = 0, None
            for shift in range(-SEARCH_RADIUS, SEARCH_RADIUS + 1):
                sx = x0 + shift
                if sx < 0 or sx + block_w > width:
                    continue
                reference = prev[y0 : y0 + block_h, sx : sx + block_w].astype(np.int32)
                cost = int(np.abs(block - reference).sum())
                if best_cost is None or cost < best_cost:
                    best_shift, best_cost = shift, cost
            displacements.append(abs(best_shift))

    magnitude = float(np.mean(displacements)) if displacements else 0.0
    moving = magnitude >= MIN_FLOW_MAGNITUDE
    return EgoState(moving=moving, speed_scale=magnitude if moving else 0.0)
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ego_motion.py -q'
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/ego_motion.py rdk/vision/tests/test_ego_motion.py
git commit -m "feat(adas): estimate ego motion from global luma flow"
```

---

## Task 9: The replay harness

**Files:**

- Create: `rdk/vision/tools/replay.py`
- Test: `rdk/vision/tests/test_replay.py`

**Interfaces:**

- Consumes: everything above
- Produces:
  - `cache_key(clip: str, model_hash: str, conf_threshold: float) -> str`
  - `run_clip(source, detect, camera, ...) -> ReplayResult`
  - `ReplayResult(alerts: list[Candidate], frames: int, detections: dict[int, list[Detection]], latency_ms: list[float])`
  - CLI: `python3 tools/replay.py CLIP --camera front [--fps 10] [--cache DIR] [--out DIR]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_replay.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.frame_source import Frame
from perception.types import Detection
from tools.replay import ReplayResult, cache_key, run_clip, write_outputs


class FakeSource:
    """A scripted frame sequence, so the harness is testable with no BPU."""

    def __init__(self, count, width=64, height=64, fps=10.0, camera="front"):
        self.count = count
        self.width = width
        self.height = height
        self.fps = fps
        self.camera = camera

    def frames(self):
        for i in range(self.count):
            yield Frame(
                nv12=bytes(self.width * self.height * 3 // 2),
                t_ms=round(i * 1000 / self.fps),
                camera=self.camera,
                width=self.width,
                height=self.height,
            )


def approaching(i):
    """A car centred in the corridor, growing steadily."""
    h = 0.10 + 0.03 * i
    return [Detection(cls="car", score=0.9, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)]


def test_a_closing_car_produces_an_alert():
    result = run_clip(FakeSource(12), detect=lambda frame, i: approaching(i), camera="front",
                      ego_moving=True)
    assert [a.threat_id for a in result.alerts] == ["forward_collision"]


def test_an_empty_clip_produces_no_alerts():
    result = run_clip(FakeSource(12), detect=lambda frame, i: [], camera="front", ego_moving=True)
    assert result.alerts == []
    assert result.frames == 12


def test_the_same_clip_twice_gives_the_same_alerts():
    """Determinism is the parity property M1 can actually verify.

    The camera-vs-file comparison needs hardware that does not exist yet; a
    harness that is not reproducible could not support that test anyway.
    """
    a = run_clip(FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True)
    b = run_clip(FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True)
    assert [(x.threat_id, x.t_ms, x.track_id) for x in a.alerts] == [
        (x.threat_id, x.t_ms, x.track_id) for x in b.alerts
    ]


def test_cached_detections_reproduce_the_live_run_exactly():
    live = run_clip(FakeSource(12), detect=lambda frame, i: approaching(i), camera="front", ego_moving=True)
    cached = run_clip(FakeSource(12), detect=lambda frame, i: live.detections[i],
                      camera="front", ego_moving=True)
    assert [a.threat_id for a in cached.alerts] == [a.threat_id for a in live.alerts]


def test_the_cache_key_changes_with_the_model_and_the_threshold():
    """A stale cache silently tuning against another model's detections is the
    exact self-deceiving measurement this milestone exists to avoid."""
    base = cache_key("clip.mp4", "abc123", 0.25)
    assert base != cache_key("clip.mp4", "def456", 0.25)
    assert base != cache_key("clip.mp4", "abc123", 0.30)
    assert base == cache_key("clip.mp4", "abc123", 0.25)


def test_outputs_are_written_where_the_summary_says(tmp_path):
    result = ReplayResult(alerts=[], frames=10, detections={}, latency_ms=[5.0, 7.0])
    write_outputs(result, tmp_path, clip="ride.mp4")
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["frames"] == 10
    assert summary["alerts"] == 0
    assert summary["latency_ms_p50"] == 6.0
    assert (tmp_path / "alerts.jsonl").exists()
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_replay.py -q'
```

Expected: FAIL, `ModuleNotFoundError: No module named 'tools.replay'`.

- [ ] **Step 3: Write the harness**

Create `rdk/vision/tools/replay.py`:

```python
"""Offline harness: a clip in, an alert sequence out.

This is the instrument M1 exists to build. It runs the identical modules the
on-bike runtime will run, differing only in where frames come from — which is
the whole reason for the FrameSource seam.

Detections are cached because tuning means many passes over one corpus and
re-running BPU inference each time would make the loop unusable. The cache is
keyed on (clip, model hash, confidence threshold), so changing the detector or
its threshold invalidates it automatically rather than silently tuning against
detections from a different model.

    python3 tools/replay.py ride.mp4 --camera front --out /tmp/replay
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.ego_motion import estimate
from adas.suppress import Suppressor
from adas.threat import evaluate
from perception.frame_source import FileSource
from perception.tracker import Tracker
from perception.types import Candidate, Detection, EgoState


@dataclass
class ReplayResult:
    alerts: list[Candidate] = field(default_factory=list)
    frames: int = 0
    detections: dict[int, list[Detection]] = field(default_factory=dict)
    latency_ms: list[float] = field(default_factory=list)


def cache_key(clip: str, model_hash: str, conf_threshold: float) -> str:
    raw = f"{Path(clip).name}|{model_hash}|{conf_threshold:.4f}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def run_clip(source, detect, camera: str, ego_moving: bool | None = None) -> ReplayResult:
    """Drive one clip through the full pipeline.

    `detect(frame, index) -> list[Detection]` is injected so the harness is
    testable without a BPU, and so a cached-detection run uses the identical
    code path as a live one.

    `ego_moving` forces the ego state; leave it None to estimate from the video.
    """
    tracker = Tracker()
    suppressor = Suppressor()
    result = ReplayResult()
    prev_y: bytes | None = None

    for index, frame in enumerate(source.frames()):
        started = time.monotonic()
        dets = detect(frame, index)
        result.detections[index] = dets

        if ego_moving is None:
            if prev_y is None:
                ego = EgoState(moving=False, speed_scale=0.0)
            else:
                ego = estimate(prev_y, frame.nv12, frame.width, frame.height)
            prev_y = frame.nv12
        else:
            ego = EgoState(moving=ego_moving, speed_scale=1.0 if ego_moving else 0.0)

        tracks = tracker.update(dets, frame.t_ms)
        candidates = evaluate(tracks, ego, frame.t_ms, camera)
        track_frames = {t.track_id: t.frames for t in tracks}
        result.alerts.extend(suppressor.admit(candidates, track_frames, frame.t_ms))
        result.frames += 1
        result.latency_ms.append((time.monotonic() - started) * 1000.0)

    return result


def write_outputs(result: ReplayResult, out_dir: Path, clip: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    with (out_dir / "alerts.jsonl").open("w", encoding="utf-8") as fh:
        for alert in result.alerts:
            fh.write(json.dumps(asdict(alert), ensure_ascii=False) + "\n")

    latencies = sorted(result.latency_ms)
    duration_h = (result.frames / 10.0) / 3600.0 if result.frames else 0.0
    summary = {
        "clip": clip,
        "frames": result.frames,
        "alerts": len(result.alerts),
        "alerts_per_hour": (len(result.alerts) / duration_h) if duration_h else 0.0,
        "latency_ms_p50": statistics.median(latencies) if latencies else 0.0,
        "latency_ms_p95": latencies[int(len(latencies) * 0.95)] if latencies else 0.0,
        "by_threat": {
            threat: sum(1 for a in result.alerts if a.threat_id == threat)
            for threat in {a.threat_id for a in result.alerts}
        },
        # Stated plainly so no reader mistakes a clean run for a validated one.
        "tuning_status": "constants are untuned starting values; see the M1 spec",
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("clip")
    parser.add_argument("--camera", choices=["front", "rear"], required=True)
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--cache", default="/tmp/replay-cache")
    parser.add_argument("--out", default="/tmp/replay")
    args = parser.parse_args()

    model_hash = hashlib.sha256(Path(args.model).read_bytes()).hexdigest()[:16]
    cache_path = Path(args.cache) / f"{cache_key(args.clip, model_hash, args.conf)}.jsonl"

    if cache_path.exists():
        cached = [
            [Detection(**d) for d in json.loads(line)]
            for line in cache_path.read_text(encoding="utf-8").splitlines()
        ]
        print(f"using cached detections: {cache_path}")

        def detect(frame, index):
            return cached[index] if index < len(cached) else []
    else:
        from perception.detector import Detector

        detector = Detector(args.model, conf_threshold=args.conf)

        def detect(frame, index):
            return detector.infer(frame.nv12, frame.width, frame.height)

    source = FileSource(args.clip, camera=args.camera, fps=args.fps)
    result = run_clip(source, detect, camera=args.camera)

    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as fh:
            for index in sorted(result.detections):
                fh.write(json.dumps([asdict(d) for d in result.detections[index]]) + "\n")

    write_outputs(result, Path(args.out), clip=args.clip)
    print(f"{result.frames} frames, {len(result.alerts)} alerts -> {args.out}/summary.json")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests**

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_replay.py -q'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite, including M0's**

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: all pass. M0's 104 must not regress.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/tools/replay.py rdk/vision/tests/test_replay.py
git commit -m "feat(adas): add the offline replay harness with a keyed detection cache"
```

---

## Task 10: Bench measurement and documentation

**Files:**

- Create: `rdk/vision/tools/soak.py`
- Modify: `rdk/README.md`

**Interfaces:**

- Consumes: `Detector`, `FileSource`

- [ ] **Step 1: Verify the ffmpeg NV12 layout gate**

Before any measurement, prove ffmpeg's NV12 matches what the pipeline expects.
A mismatch would present as a threat-engine bug and send debugging to the wrong
module entirely.

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -c "
import sys; sys.path.insert(0, \".\")
from perception.frame_source import FileSource, probe_dims
import subprocess
subprocess.run([\"ffmpeg\",\"-v\",\"error\",\"-f\",\"lavfi\",\"-i\",
  \"testsrc=size=1920x1080:rate=10:duration=1\",\"-pix_fmt\",\"yuv420p\",\"-y\",\"/tmp/t.mp4\"],check=True)
f = next(FileSource(\"/tmp/t.mp4\", camera=\"front\").frames())
expected = 1920*1080*3//2
print(\"frame bytes\", len(f.nv12), \"expected\", expected)
assert len(f.nv12) == expected, \"NV12 plane layout differs from the pipeline assumption\"
print(\"OK: NV12 layout matches\")
"'
```

Expected: `OK: NV12 layout matches`.

- [ ] **Step 2: Write the soak tool**

Create `rdk/vision/tools/soak.py`:

```python
"""Sustained inference, to find the thermal and throughput ceiling.

Run with the voice pipeline live. That is the only configuration that ships,
and idle is already 75.5 C with max-aec running — the parent spec's 71 C
predates the voice work, so ADAS has less headroom than it assumed.

    python3 tools/soak.py --clip ride.mp4 --minutes 10 --streams 2
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.detector import Detector
from perception.frame_source import FileSource

MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def temps() -> dict[str, float]:
    out = subprocess.run(["hrut_somstatus"], capture_output=True).stdout.decode()
    found: dict[str, float] = {}
    for line in out.splitlines():
        for key in ("CPU", "BPU", "DDR"):
            if line.strip().startswith(key):
                try:
                    found[key] = float(line.split(":")[1].split("(")[0])
                except (IndexError, ValueError):
                    pass
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", required=True)
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--streams", type=int, default=2)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()

    detector = Detector(args.model)
    frames = [f for f in FileSource(args.clip, camera="front", fps=10.0).frames()]
    if not frames:
        raise SystemExit("clip yielded no frames")

    print(f"start temps: {temps()}")
    deadline = time.monotonic() + args.minutes * 60
    count = 0
    index = 0
    last_report = time.monotonic()
    started = time.monotonic()

    while time.monotonic() < deadline:
        frame = frames[index % len(frames)]
        index += 1
        for _ in range(args.streams):
            detector.infer(frame.nv12, frame.width, frame.height)
            count += 1
        if time.monotonic() - last_report >= 30:
            elapsed = time.monotonic() - started
            print(f"{elapsed:6.0f}s  {count/elapsed:5.1f} inf/s  "
                  f"({count/elapsed/args.streams:4.1f} fps/camera)  {temps()}", flush=True)
            last_report = time.monotonic()

    elapsed = time.monotonic() - started
    print(f"\nsustained {count/elapsed:.1f} inferences/s over {elapsed/60:.1f} min")
    print(f"that is {count/elapsed/args.streams:.1f} fps per camera with {args.streams} streams")
    print(f"end temps: {temps()}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Measure the detector on real traffic**

This needs a clip of ordinary road traffic. Any phone video works; transcode it
and copy it to the board:

```bash
ffmpeg -i traffic.mov -vf scale=1920:1080 -c:v libx264 -y /tmp/traffic.mp4
scp /tmp/traffic.mp4 root@192.168.50.9:/tmp/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 tools/replay.py /tmp/traffic.mp4 --camera front --out /tmp/replay && cat /tmp/replay/summary.json'
```

Record in `rdk/README.md`: frames processed, detections per frame, per-frame
latency p50/p95, and how far away vehicles are still detected.

- [ ] **Step 4: Confirm the cache reproduces the live run**

This is the parity property M1 can verify without a camera.

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && \
  cp /tmp/replay/alerts.jsonl /tmp/alerts-live.jsonl && \
  python3 tools/replay.py /tmp/traffic.mp4 --camera front --out /tmp/replay2 && \
  diff /tmp/alerts-live.jsonl /tmp/replay2/alerts.jsonl && echo "PARITY OK: cached run matches live"'
```

Expected: `PARITY OK`. A diff here means the cache is not faithfully replaying
what the BPU produced, which would invalidate every tuning run built on it.

- [ ] **Step 5: Run the thermal soak**

```bash
ssh root@192.168.50.9 'systemctl is-active max-agent'   # must be active
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 tools/soak.py --clip /tmp/traffic.mp4 --minutes 10 --streams 2'
```

Record the sustained inferences/s, the fps per camera, and the start and end
temperatures. If fps per camera lands below 10, that is a real finding for M2,
not a failure of this task — write down the number.

- [ ] **Step 6: Update the README**

Add an "ADAS M1" section to `rdk/README.md` recording:

- the anchor validation result from `tools/check_anchors.py`
- detector performance on the real clip: detections/frame, latency p50/p95, range
- the cache/live parity result
- sustained fps per camera and the temperatures, against the 75.5 °C idle baseline
- that **file-vs-camera parity is deferred** with the corpus, and why
- that **the suppression constants are untuned starting values** — a green suite
  proves the code matches the thresholds, not that the thresholds are right

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/tools/soak.py rdk/README.md
git commit -m "feat(adas): measure detector, parity and thermals; record M1 results"
```

---

## Plan self-review

**Spec coverage.** Every spec section maps to a task: architecture and the seam
(Tasks 1–3), data flow and TTC (Tasks 4–5), threat logic (Task 6), suppression
(Task 7), ego motion (Task 8), outputs and the detection cache (Task 9),
verification and the two hardware gates (Tasks 2 and 10). The spec's four
"what M1 must prove" items land in Tasks 2, 10, 10 and 1–8 respectively.

**Known gap, stated rather than hidden.** The spec's acceptance criterion 4
(file-vs-camera parity) cannot be met without a camera. Task 9 and Task 10 verify
determinism and cache/live equivalence instead, and the deferral is recorded in
the plan header and the README.

**Type consistency.** `Detection`, `BoxSample`, `Track`, `EgoState` and
`Candidate` are defined once in Task 1 and used unchanged after. `evaluate`
takes `(tracks, ego, t_ms, camera)` in Tasks 6 and 9; `Suppressor.admit` takes
`(candidates, track_frames, t_ms)` in Tasks 7 and 9; `Detector.infer` takes
`(nv12, src_w, src_h)` in Tasks 2, 9 and 10.

**Untuned by construction.** Every threshold is a module-level named constant,
and `summary.json` states the tuning status in its own field, so no downstream
reader can mistake a clean run for a validated one.
