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

from adas.tuning import DEFAULT

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
        iou_threshold: float = DEFAULT.iou_threshold,
        max_misses: int = DEFAULT.max_misses,
        max_gap_ms: int = DEFAULT.max_gap_ms,
        window_ms: int = DEFAULT.track_window_ms,
    ) -> None:
        self.iou_threshold = iou_threshold
        self.max_misses = max_misses
        self.max_gap_ms = max_gap_ms
        self.window_ms = window_ms
        self._tracks: list[Track] = []
        self._next_id = 1
        self._last_t_ms: int | None = None

    def update(self, dets: list[Detection], t_ms: int) -> list[Track]:
        if self._last_t_ms is not None and t_ms - self._last_t_ms > self.max_gap_ms:
            # The video stopped. Everything we were following is stale.
            self._tracks = []
        self._last_t_ms = t_ms

        pairs: list[tuple[float, int, int]] = []
        for t_index, track in enumerate(self._tracks):
            for d_index, det in enumerate(dets):
                if det.cls != track.cls:
                    continue
                score = _iou(track.last, det)
                if score > self.iou_threshold:
                    pairs.append((score, t_index, d_index))
        # Globally best-first, with deterministic tie-breaks. Per-track greedy
        # let an early track steal a later track's better match, and an
        # identity swap fabricates the dh/dt spike max_gap_ms exists to
        # prevent — arriving by a different route.
        pairs.sort(key=lambda p: (-p[0], self._tracks[p[1]].track_id, p[2]))
        used_tracks: set[int] = set()
        used_dets: set[int] = set()
        for score, t_index, d_index in pairs:
            if t_index in used_tracks or d_index in used_dets:
                continue
            used_tracks.add(t_index)
            used_dets.add(d_index)
            track, det = self._tracks[t_index], dets[d_index]
            track.misses = 0
            track.samples.append(
                BoxSample(t_ms=t_ms, x1=det.x1, y1=det.y1, x2=det.x2, y2=det.y2)
            )
        for t_index, track in enumerate(self._tracks):
            if t_index not in used_tracks:
                track.misses += 1
        unmatched = [det for d_index, det in enumerate(dets) if d_index not in used_dets]

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

        cutoff = t_ms - self.window_ms
        for track in self._tracks:
            if track.samples and track.samples[0].t_ms < cutoff:
                # Trim from the front: the window caps both per-track memory
                # and the O(history) walks smoothed_heights makes three times
                # per track per frame. tuning.track_window_ms guarantees the
                # window exceeds the tailgate dwell, the longest look-back.
                track.samples[:] = [s for s in track.samples if s.t_ms >= cutoff]

        return [t for t in self._tracks if t.misses == 0]
