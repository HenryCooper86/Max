"""The change gate: is the new frame worth shipping.

Pure functions, no threading, no I/O beyond decoding the bytes handed in — so
this is exactly as testable off-board as bench_server.downscale is, using the
same requirements-dev numpy/opencv. cv2/numpy are still imported lazily
inside the functions (board-only style), matching mipi_camera.py and
bench_server.py: the module itself must stay importable wherever the rest of
this package is.
"""

from __future__ import annotations

from .tuning import DEFAULT, WatchTuning


def histogram_correlation(jpeg_a: bytes, jpeg_b: bytes) -> float:
    """Grayscale-histogram correlation in [-1, 1]; 1.0 = identical distributions.

    Raises ValueError on undecodable input (caller treats as 'changed').
    Correlation, not pixel difference: a frame-to-frame gate must tolerate the
    sensor's own exposure/noise wobble between two shots of the same scene,
    and a global brightness-distribution comparison is cheap enough to run
    every sample_interval_s on the board without touching the BPU.
    """
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    hists = []
    for jpeg in (jpeg_a, jpeg_b):
        decoded = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if decoded is None:
            raise ValueError("undecodable JPEG")
        hist = cv2.calcHist([decoded], [0], None, [256], [0, 256])
        cv2.normalize(hist, hist)
        hists.append(hist)

    return float(cv2.compareHist(hists[0], hists[1], cv2.HISTCMP_CORREL))


def scene_changed(
    previous_jpeg: bytes | None, current_jpeg: bytes, tuning: WatchTuning = DEFAULT
) -> bool:
    """None previous (first frame after enable) -> True. Undecodable -> True.

    Both are fail-toward-shipping: an unset reference is not evidence the
    scene is unchanged, and neither is a frame this process could not decode.
    The relay governor is the actual spend guard, so shipping an extra frame
    here is cheap; dropping a real change silently is not.
    """
    if previous_jpeg is None:
        return True
    try:
        correlation = histogram_correlation(previous_jpeg, current_jpeg)
    except ValueError:
        return True
    return correlation < tuning.change_threshold
