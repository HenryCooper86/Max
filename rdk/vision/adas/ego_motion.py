"""Is the bike moving? Coarse global flow on the front camera's luma plane.

Only the moving/stopped decision is load-bearing. It is the single
highest-value suppression stage: a car pulling up behind you at a light is
visually indistinguishable from a rear approach, and ego motion is the only
thing that separates them.

The speed scale is unitless and deliberately crude — block-matched horizontal
displacement, not a calibrated velocity. Nothing in M1 needs a real speed, and
pretending otherwise would invite someone to build on it.
"""

from __future__ import annotations

import numpy as np

from perception.types import EgoState

#: Mean absolute block displacement, in pixels, above which we call it moving.
MIN_FLOW_MAGNITUDE = 0.6

#: How far the search looks, in pixels, either side of zero.
SEARCH_RADIUS = 12


def estimate(prev_y: bytes, curr_y: bytes, width: int, height: int, grid: int = 8) -> EgoState:
    """Compare two luma planes and report whether the scene is translating."""
    prev = np.frombuffer(prev_y, dtype=np.uint8)[: width * height].reshape(height, width)
    curr = np.frombuffer(curr_y, dtype=np.uint8)[: width * height].reshape(height, width)

    block_h = height // grid
    block_w = width // grid
    displacements: list[int] = []

    for gy in range(grid):
        y0 = gy * block_h
        for gx in range(grid):
            x0 = gx * block_w
            block = curr[y0 : y0 + block_h, x0 : x0 + block_w].astype(np.int32)
            best_shift, best_cost = 0, None
            for shift in range(-SEARCH_RADIUS, SEARCH_RADIUS + 1):
                sx = x0 + shift
                if sx < 0 or sx + block_w > width:
                    continue
                reference = prev[y0 : y0 + block_h, sx : sx + block_w].astype(np.int32)
                cost = int(np.abs(block - reference).sum())
                if best_cost is None or cost < best_cost:
                    best_shift, best_cost = shift, cost
            displacements.append(abs(best_shift))

    magnitude = float(np.mean(displacements)) if displacements else 0.0
    moving = magnitude >= MIN_FLOW_MAGNITUDE
    return EgoState(moving=moving, speed_scale=magnitude if moving else 0.0)
