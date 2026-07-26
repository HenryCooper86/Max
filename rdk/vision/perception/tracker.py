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
                    samples=[
                        BoxSample(t_ms=t_ms, x1=det.x1, y1=det.y1, x2=det.x2, y2=det.y2)
                    ],
                )
            )
            self._next_id += 1

        self._tracks = [t for t in self._tracks if t.misses <= self.max_misses]
        return [t for t in self._tracks if t.misses == 0]
