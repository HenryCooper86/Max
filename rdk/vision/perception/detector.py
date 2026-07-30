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

#: NV12 neutral grey: luma mid-scale, both chroma channels centred.
PAD_LUMA = 128
PAD_CHROMA = 128


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
    """Nearest-neighbour resize, so the sidecar needs no cv2 dependency."""
    ys = np.minimum((np.arange(out_h) * plane.shape[0] // out_h), plane.shape[0] - 1)
    xs = np.minimum((np.arange(out_w) * plane.shape[1] // out_w), plane.shape[1] - 1)
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

    canvas_y = np.full((INPUT_SIZE, INPUT_SIZE), PAD_LUMA, dtype=np.uint8)
    canvas_uv = np.full((INPUT_SIZE // 2, INPUT_SIZE), PAD_CHROMA, dtype=np.uint8)

    px, py = int(geom.pad_x), int(geom.pad_y)
    px -= px % 2  # chroma pairs U,V horizontally; an odd offset would swap them
    py -= py % 2  # and one chroma row covers two luma rows
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
        # Alias the vendor buffer instead of copying: arrays are read-only within
        # the same infer call (decode and nms only read, letterbox allocates fresh).
        tensors = [np.asarray(o.buffer) for o in outputs]
        dets = decode(tensors, self.conf_threshold)
        kept = nms(dets, self.iou_threshold)
        return [geom.to_source(d) for d in kept]
