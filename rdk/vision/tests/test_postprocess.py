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
