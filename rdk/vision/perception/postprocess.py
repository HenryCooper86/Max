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
#: VALIDATED AGAINST bus.jpg BY tools/check_anchors.py — if these are wrong,
#: boxes land in plausible-looking wrong places and every downstream TTC number
#: is garbage. Do not change them without re-running that check.
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


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


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

            score = float(_sigmoid(float(cell[4])) * _sigmoid(float(class_logits[cls_id])))
            if score < conf_threshold:
                continue

            tx, ty, tw, th = (float(v) for v in cell[:4])
            aw, ah = ANCHORS[stride][anchor]
            cx = (_sigmoid(tx) * 2.0 - 0.5 + int(col)) * stride
            cy = (_sigmoid(ty) * 2.0 - 0.5 + int(row)) * stride
            w = (_sigmoid(tw) * 2.0) ** 2 * aw
            h = (_sigmoid(th) * 2.0) ** 2 * ah

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
