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

#: Block matching runs at this width, whatever the camera delivers.
#:
#: Two reasons, and the second is the important one. At 810x1080 the full-
#: resolution search measured 251.7 ms per frame — 87% of the frame budget and
#: seven times the 36 ms inference it accompanies, for a decision that is
#: ultimately one bit. And a displacement threshold in raw pixels means the same
#: physical motion reads 2.4x larger at 1920 wide than at 810, so the gate would
#: silently change behaviour with camera resolution. Fixing the working width
#: makes the threshold mean one thing everywhere.
WORK_WIDTH = 160

#: Mean absolute block displacement, in WORK_WIDTH pixels, above which we call
#: it moving.
MIN_FLOW_MAGNITUDE = 0.6

#: How far the search looks, in WORK_WIDTH pixels, either side of zero.
SEARCH_RADIUS = 12


def _downsample(plane: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    ys = np.minimum(np.arange(out_h) * plane.shape[0] // out_h, plane.shape[0] - 1)
    xs = np.minimum(np.arange(out_w) * plane.shape[1] // out_w, plane.shape[1] - 1)
    return plane[ys][:, xs]


def estimate(prev_y: bytes, curr_y: bytes, width: int, height: int, grid: int = 8) -> EgoState:
    """Compare two luma planes and report whether the scene is translating."""
    prev = np.frombuffer(prev_y, dtype=np.uint8)[: width * height].reshape(height, width)
    curr = np.frombuffer(curr_y, dtype=np.uint8)[: width * height].reshape(height, width)

    # Only ever shrink. A frame narrower than WORK_WIDTH is already cheap, and
    # upsampling it would invent detail the threshold would then measure.
    if width > WORK_WIDTH:
        scale = WORK_WIDTH / width
        width, height = WORK_WIDTH, max(grid, int(height * scale))
        prev = _downsample(prev, width, height)
        curr = _downsample(curr, width, height)

    block_h = height // grid
    block_w = width // grid
    if block_h == 0 or block_w == 0:
        return EgoState(moving=False, speed_scale=0.0)

    # Crop to a whole number of blocks so the per-block sums below are a reshape
    # rather than a loop.
    used_h, used_w = block_h * grid, block_w * grid
    curr_i = curr[:used_h, :used_w].astype(np.int16)

    # One difference image per candidate shift, with all blocks summed at once.
    # The obvious nested loop makes grid^2 * (2R+1) — 1600 — tiny numpy calls,
    # and at that size the per-call overhead is the entire cost. This is 25
    # iterations over the whole frame instead, which measured ~10x faster.
    shifts = range(-SEARCH_RADIUS, SEARCH_RADIUS + 1)
    padded = np.pad(prev[:used_h, :used_w], ((0, 0), (SEARCH_RADIUS, SEARCH_RADIUS)), mode="edge")
    costs = np.empty((len(shifts), grid, grid), dtype=np.int64)
    for i, shift in enumerate(shifts):
        start = SEARCH_RADIUS + shift
        aligned = padded[:, start : start + used_w].astype(np.int16)
        diff = np.abs(curr_i - aligned)
        costs[i] = diff.reshape(grid, block_h, grid, block_w).sum(axis=(1, 3), dtype=np.int64)

    best = np.argmin(costs, axis=0)
    displacements = np.abs(np.asarray(shifts)[best])

    magnitude = float(displacements.mean()) if displacements.size else 0.0
    moving = magnitude >= MIN_FLOW_MAGNITUDE
    return EgoState(moving=moving, speed_scale=magnitude if moving else 0.0)
