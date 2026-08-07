"""Every vision.watch constant, in one frozen dataclass with a fingerprint.

Mirrors adas/tuning.py's pattern: a Tuning is comparable, injectable, and its
fingerprint discloses whether two watch sessions ran under the same
constants. There is only one shadow-log-shaped consumer today (none), but the
gate's threshold is exactly the kind of value a real-ride tune will want to
sweep, so the seam is built in from the start rather than retrofitted like
adas/tuning.py's constants were.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class WatchTuning:
    #: How often the sampler grabs a candidate frame, whether or not it ends
    #: up shipping. The relay governor is the real spend guard; this just
    #: sets how often the gate gets a chance to say "nothing changed".
    sample_interval_s: float = 30.0
    #: Grayscale-histogram correlation below this = "the scene changed". Tuned
    #: against the fixture pairs in test_watch_gate.py; real-ride tuning is
    #: follow-up work, like the ADAS thresholds were.
    change_threshold: float = 0.90
    #: Longest edge of a shipped frame, matching bench_server's
    #: DEFAULT_FRAME_WIDTH — same budget reasoning: enough for a model to
    #: describe a scene, cheap to upload from a board on a phone tether.
    frame_width: int = 640


DEFAULT = WatchTuning()


def fingerprint(tuning: WatchTuning = DEFAULT) -> str:
    """12 hex chars identifying a constant set. Stable across processes."""
    payload = json.dumps(asdict(tuning), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
