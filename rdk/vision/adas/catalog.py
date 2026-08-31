"""Spoken strings for the four v1 threats.

Mirrors — exactly — the matching entries in shared/adas.ts, which is the
canonical catalog (it is what clients display and the relay validates).
tests/test_catalog_drift.py enforces the match wherever the full checkout is
present. The WAV filenames key off these ids; changing a string here means
re-rendering the board's alert clips with tools/render_alerts.py.
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
        "message": "前方有行人横穿，立即减速！",
        "advice": "收油轻刹，准备停车。",
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
        "message": "后车跟车过近，注意不要急刹。",
        "advice": "平稳行驶，适当让出车距。",
    },
}
