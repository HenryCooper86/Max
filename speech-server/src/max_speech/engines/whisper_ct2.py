"""faster-whisper (CTranslate2). Used on CUDA and CPU."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from max_speech.audio import INPUT_RATE, resample
from max_speech.engines.base import Transcript


class WhisperCt2Stt:
    id = "whisper-ct2"

    def __init__(self, model_dir: Path, model_id: str, *, device: str = "cpu", compute_type: str = "int8"):
        from faster_whisper import WhisperModel

        self.model_id = model_id
        self._model = WhisperModel(str(model_dir), device=device, compute_type=compute_type)

    def transcribe(
        self, audio: np.ndarray, rate: int, *, language: str | None = None, prompt: str | None = None
    ) -> Transcript:
        samples = resample(np.asarray(audio, dtype=np.float32), rate, INPUT_RATE)
        # Greedy decoding and no VAD: lowest latency, and the relay already sends speech-only segments.
        segments, info = self._model.transcribe(
            samples, language=language, initial_prompt=prompt, beam_size=1, vad_filter=False
        )
        parts = [(s.start, s.end, s.text.strip()) for s in segments]
        text = " ".join(p[2] for p in parts if p[2]).strip()
        return Transcript(
            text=text,
            language=info.language,
            duration_s=len(samples) / INPUT_RATE,
            segments=tuple(parts),
        )

    def warm_up(self) -> None:
        self.transcribe(np.zeros(INPUT_RATE // 2, dtype=np.float32), INPUT_RATE)
