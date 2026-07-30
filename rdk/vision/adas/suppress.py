"""The six-stage gate between a threat candidate and a rider's ears.

Stage 1 (ego moving) lives in threat.evaluate, because a stopped bike has no
threats rather than suppressed ones. The remaining five are here. Stage 3's
run need not be strictly consecutive: a candidate may go absent for up to
`run_grace_frames` frames and keep its run credit, so one detector flicker
does not re-arm the whole stability gate.

Every stage is a named constant rather than a number buried in a conditional,
because M1's whole purpose is to tune these against measured data — and a
threshold you cannot find is a threshold you cannot tune.
"""

from __future__ import annotations

from perception.types import Candidate

from .tuning import DEFAULT

MIN_TRACK_FRAMES = DEFAULT.min_track_frames
MIN_TTC_FRAMES = DEFAULT.min_ttc_frames
THREAT_COOLDOWN_S = DEFAULT.threat_cooldown_s
GLOBAL_ALERT_GAP_S = DEFAULT.global_gap_s
RUN_GRACE_FRAMES = DEFAULT.run_grace_frames

_SEVERITY_RANK = {"caution": 0, "critical": 1}


class Suppressor:
    def __init__(
        self,
        min_track_frames: int = MIN_TRACK_FRAMES,
        min_ttc_frames: int = MIN_TTC_FRAMES,
        threat_cooldown_s: float = THREAT_COOLDOWN_S,
        global_gap_s: float = GLOBAL_ALERT_GAP_S,
        run_grace_frames: int = RUN_GRACE_FRAMES,
    ) -> None:
        self.min_track_frames = min_track_frames
        self.min_ttc_frames = min_ttc_frames
        self.threat_cooldown_s = threat_cooldown_s
        self.global_gap_s = global_gap_s
        self.run_grace_frames = run_grace_frames
        self._runs: dict[tuple[str, int], int] = {}
        self._missed: dict[tuple[str, int], int] = {}
        self._last_fired_ms: dict[str, int] = {}
        self._last_any_ms: int | None = None
        self._last_any_severity: str = "caution"

    def admit(
        self, candidates: list[Candidate], track_frames: dict[int, int], t_ms: int
    ) -> list[Candidate]:
        seen = {(c.threat_id, c.track_id) for c in candidates}
        for key in list(self._runs):
            if key not in seen:
                # Stage 3, bounded grace: the detector blinked but the track
                # persists (Stage 2 still gates on maturity). One flicker at
                # 10 fps used to re-arm the whole 3-frame gate — ~600 ms of
                # blindness bought by a single dropped detection.
                missed = self._missed.get(key, 0)
                if missed < self.run_grace_frames:
                    self._missed[key] = missed + 1
                else:
                    del self._runs[key]
                    self._missed.pop(key, None)

        admitted: list[Candidate] = []
        for c in candidates:
            key = (c.threat_id, c.track_id)
            self._runs[key] = self._runs.get(key, 0) + 1
            self._missed.pop(key, None)

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
