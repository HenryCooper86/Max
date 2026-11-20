"""mlx-whisper for Apple Silicon. The model comes from the registry, never from mlx-whisper's own hub lookup."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from max_speech.audio import INPUT_RATE, resample
from max_speech.engines.base import Transcript


class WhisperMlxStt:
    id = "whisper-mlx"

    def __init__(self, model_dir: Path, model_id: str):
        import mlx_whisper

        self.model_id = model_id
        self._mlx = mlx_whisper
        self._path = str(model_dir)

    def transcribe(
        self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None
    ) -> Transcript:
        samples = resample(np.asarray(audio, dtype=np.float32), rate, INPUT_RATE)
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
