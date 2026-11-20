"""Silero VAD v6 through onnxruntime. Heavy imports stay inside the constructor so importing this is free."""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
MODEL_FILE = "silero_vad.onnx"


class SileroVadStream:
    frame_samples = FRAME_SAMPLES

    def __init__(self, session, lock: threading.Lock) -> None:
        self._session = session
        self._lock = lock
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)

    def probability(self, frame: np.ndarray) -> float:
        if frame.shape != (FRAME_SAMPLES,):
            raise ValueError(f"expected {FRAME_SAMPLES} samples, got shape {frame.shape}")
        frame = frame.astype(np.float32, copy=False)
        model_input = np.concatenate([self._context, frame])[None, :]
        with self._lock:
            out, state = self._session.run(
                None,
                {"input": model_input, "state": self._state, "sr": np.array(SAMPLE_RATE, dtype=np.int64)},
            )
        self._state = np.asarray(state, dtype=np.float32)
        self._context = frame[-CONTEXT_SAMPLES:].copy()
        return float(np.asarray(out).reshape(-1)[0])


class SileroVad:
    id = "silero"

    def __init__(self, model_dir: Path, *, model_id: str, session=None) -> None:
        self.model_id = model_id  # the registry id this was built from
        if session is None:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            session = ort.InferenceSession(
                str(Path(model_dir) / MODEL_FILE), options, providers=["CPUExecutionProvider"]
            )
        self._session = session
        # Streams share the session, so calls into it are serialized.
        self._lock = threading.Lock()

    def new_stream(self) -> SileroVadStream:
        return SileroVadStream(self._session, self._lock)
