import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.detector import letterbox_dims
from perception.types import Detection


def test_letterbox_dims_preserves_aspect_for_16_by_9():
    # 1920x1080 into 672x672: scale by width-limited 672/1920, pad vertically.
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
