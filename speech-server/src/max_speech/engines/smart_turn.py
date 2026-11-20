"""Smart Turn v3.2: end-of-turn detection from the last 8 seconds of audio (ONNX, CPU).

The model takes the log-mel features of the utterance so far (Whisper's recipe, 80 bins x 800 frames) and
returns the probability that the speaker has finished. The features are computed here with numpy only.
"""

from __future__ import annotations

import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
WINDOW_S = 8
N_SAMPLES = WINDOW_S * SAMPLE_RATE
N_FFT = 400
HOP = 160
N_MELS = 80
N_FRAMES = N_SAMPLES // HOP  # 800
MODEL_FILE = "smart-turn-v3.2-cpu.onnx"


def _hz_to_mel(hz: np.ndarray) -> np.ndarray:
    """Slaney scale: linear below 1 kHz, logarithmic above."""
    hz = np.asarray(hz, dtype=np.float64)
    mel = hz * 3.0 / 200.0
    high = hz >= 1000.0
    mel[high] = 15.0 + np.log(hz[high] / 1000.0) * 27.0 / np.log(6.4)
    return mel


def _mel_to_hz(mel: np.ndarray) -> np.ndarray:
    mel = np.asarray(mel, dtype=np.float64)
    hz = mel * 200.0 / 3.0
    high = mel >= 15.0
    hz[high] = 1000.0 * np.exp(np.log(6.4) / 27.0 * (mel[high] - 15.0))
    return hz


@lru_cache(maxsize=1)
def mel_filters() -> np.ndarray:
    """Triangular slaney-normalised mel filter bank, shape (N_FFT // 2 + 1, N_MELS), 0-8000 Hz."""
    fft_freqs = np.linspace(0.0, SAMPLE_RATE / 2, 1 + N_FFT // 2)
    edges = _mel_to_hz(
        np.linspace(_hz_to_mel(np.array([0.0]))[0], _hz_to_mel(np.array([8000.0]))[0], N_MELS + 2)
    )
    slope = edges[None, :] - fft_freqs[:, None]
    down = -slope[:, :-2] / np.diff(edges)[:-1]
    up = slope[:, 2:] / np.diff(edges)[1:]
    bank = np.maximum(0.0, np.minimum(down, up))
    bank *= (2.0 / (edges[2 : N_MELS + 2] - edges[:N_MELS]))[None, :]
    return bank.astype(np.float32)


@lru_cache(maxsize=1)
def _window() -> np.ndarray:
    return np.hanning(N_FFT + 1)[:-1]  # periodic Hann


def whisper_log_mel(audio_16k: np.ndarray) -> np.ndarray:
    """Log-mel features, float32 of shape (80, 800), for the last 8 s of 16 kHz mono audio.

    Shorter audio is zero-padded at the start, longer audio keeps its end. The padded vector is then
    normalised to zero mean and unit variance, as the model was trained.
    """
    audio = np.asarray(audio_16k, dtype=np.float64).reshape(-1)
    if len(audio) >= N_SAMPLES:
        audio = audio[-N_SAMPLES:]
    else:
        audio = np.pad(audio, (N_SAMPLES - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    padded = np.pad(audio, (N_FFT // 2, N_FFT // 2), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP] * _window()
    power = np.abs(np.fft.rfft(frames, axis=-1)) ** 2  # (801, 201)
    mel = (power @ mel_filters()).T[:, :-1]  # drop the last frame -> (80, 800)
    log_mel = np.log10(np.maximum(mel, 1e-10))
    log_mel = np.maximum(log_mel, log_mel.max() - 8.0)
    return ((log_mel + 4.0) / 4.0).astype(np.float32)


class SmartTurn:
    id = "smart-turn"

    def __init__(self, model_dir: str | Path, *, model_id: str) -> None:
        self.model_id = model_id  # the registry id this was built from
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(Path(model_dir) / MODEL_FILE), options, providers=["CPUExecutionProvider"]
        )
        self._lock = threading.Lock()

    def turn_complete(self, utterance: np.ndarray) -> float:
        features = whisper_log_mel(utterance)[None]
        with self._lock:
            out = self._session.run(None, {"input_features": features})[0]
        return float(np.clip(np.asarray(out).reshape(-1)[0], 0.0, 1.0))

    def warm_up(self) -> None:
        self.turn_complete(np.zeros(SAMPLE_RATE, dtype=np.float32))
