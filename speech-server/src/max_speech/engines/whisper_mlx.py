"""mlx-whisper for Apple Silicon. The model comes from the registry, never from mlx-whisper's own hub lookup."""

from __future__ import annotations

import functools
import importlib
import logging
from pathlib import Path

import numpy as np

from max_speech.audio import INPUT_RATE, resample
from max_speech.engines.base import Transcript
from max_speech.engines.mlx_gate import MLX_GATE

log = logging.getLogger(__name__)


def _model_holder():
    """mlx-whisper's model cache (`mlx_whisper.transcribe.ModelHolder`), or None if this release has none."""
    try:
        return getattr(importlib.import_module("mlx_whisper.transcribe"), "ModelHolder", None)
    except ImportError:
        return None


class WhisperMlxStt:
    id = "whisper-mlx"
    # Calls may overlap: every MLX evaluation is under MLX_GATE, and between two 30 s windows a batch call lets a
    # waiting live call (a session's second pass) go first. So a long upload need not keep the second pass waiting.
    interleaves = True

    def __init__(self, model_dir: Path, model_id: str):
        import mlx_whisper

        self.model_id = model_id
        self._mlx = mlx_whisper
        self._path = str(model_dir)
        self._holder = _model_holder()
        self._dtype = None
        if self._holder is None:
            log.warning(
                "mlx-whisper has no ModelHolder: a long transcription will hold the GPU for its whole length"
            )
        else:
            try:
                import mlx.core as mx

                self._dtype = mx.float16  # what transcribe() asks the holder for (fp16 is its default)
            except ImportError:
                pass

    def _add_yield_points(self) -> None:
        """Make the cached model give the gate to live work before each window it decodes.

        transcribe() calls `model.decode(segment, options)` once per 30 s window (and again per temperature fallback),
        each a complete evaluation, and keeps nothing lazy across them but its own arrays, so another thread's MLX
        work in between cannot change what it computes: the transcript is the same as with the gate held throughout.
        """
        if self._holder is None:
            return
        model = self._holder.get_model(self._path, self._dtype)  # loads it (under the gate) the first time
        # Patched on the class, once: a wrapper stored on the model itself would hold the model through its bound
        # method, a cycle that keeps the weights alive until the cycle collector frees them at some later moment.
        cls = type(model)
        if cls.__dict__.get("_max_speech_yields", False):
            return
        decode = cls.decode

        @functools.wraps(decode)
        def decode_after_yield(self, *args, **kwargs):
            MLX_GATE.yield_point()  # a no-op unless this thread holds the gate as batch work and someone waits
            return decode(self, *args, **kwargs)

        cls.decode = decode_after_yield
        cls._max_speech_yields = True

    def transcribe(
        self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None
    ) -> Transcript:
        samples = resample(np.asarray(audio, dtype=np.float32), rate, INPUT_RATE)
        with MLX_GATE:
            self._add_yield_points()
            result = self._mlx.transcribe(
                samples, path_or_hf_repo=self._path, language=language, initial_prompt=prompt
            )
        segments = tuple(
            (float(s["start"]), float(s["end"]), str(s["text"]).strip()) for s in result.get("segments", ())
        )
        return Transcript(
            text=str(result.get("text", "")).strip(),
            language=result.get("language"),
            duration_s=len(samples) / INPUT_RATE,
            segments=segments,
        )

    def warm_up(self) -> None:
        self.transcribe(np.zeros(INPUT_RATE // 2, dtype=np.float32), INPUT_RATE)
