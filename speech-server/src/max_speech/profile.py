from __future__ import annotations

import logging
import platform
import sys
from typing import Literal

from max_speech.settings import Settings

Profile = Literal["cuda", "mlx", "cpu"]

log = logging.getLogger(__name__)


def _cuda_available() -> bool:
    # Probing is best effort: a broken or missing GPU stack must fall back to CPU, not crash startup.
    try:
        import onnxruntime

        if "CUDAExecutionProvider" in onnxruntime.get_available_providers():
            return True
    except Exception:
        log.debug("onnxruntime CUDA probe failed", exc_info=True)
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return True
    except Exception:
        log.debug("ctranslate2 CUDA probe failed", exc_info=True)
    return False


def detect_profile() -> Profile:
    if _cuda_available():
        return "cuda"
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return "mlx"
    return "cpu"


def resolve_profile(settings: Settings) -> Profile:
    if settings.profile is not None:
        return settings.profile  # type: ignore[return-value]
    return detect_profile()
