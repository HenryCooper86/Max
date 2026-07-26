"""Spoken strings for the four v1 threats.

Mirrors the matching entries in shared/adas.ts. Duplicated rather than imported
because the sidecar is Python and the catalog is TypeScript, so no test can
catch drift from either side — keep the two in step by hand when either
changes.

Two of these are not in shared/adas.ts yet: `pedestrian_ahead` and `tailgating`
are M2 additions, and their strings should be added there when that catalog
next changes. The WAV filenames key off these ids.
"""

from __future__ import annotations

CATALOG: dict[str, dict[str, str]] = {
    "forward_collision": {
        "direction": "front",
        "label": "前车急刹",
        "message": "前车急刹，注意保持车距！",
        "advice": "立即收油，平稳减速。",
    },
    "pedestrian_ahead": {
        "direction": "front",
        "label": "前方行人",
        "message": "前方有行人，请减速。",
        "advice": "缓慢通过，注意避让。",
    },
    "rear_approach": {
        "direction": "rear",
        "label": "后方快速接近",
        "message": "注意，后方车辆高速接近。",
        "advice": "保持车道，握稳车把，不要急刹。",
    },
    "tailgating": {
        "direction": "rear",
        "label": "后车跟车过近",
        "message": "后车跟车过近，注意保持车距。",
        "advice": "保持匀速，不要急刹。",
    },
}
