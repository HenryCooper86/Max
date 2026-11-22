"""Voice design with Qwen3-TTS VoiceDesign on Apple Silicon, through mlx-audio.

The model turns a text description ("a deep, low-pitched older male voice") plus a sentence into speech in a
voice that fits the description. It needs 4.5 GB of weights and peaks near 8.6 GB while generating, and it is
used rarely, so it is loaded on the first call and unloaded after `idle_seconds` without one.

Designed speech drifts in timbre from one sentence to the next, so callers do not speak with it: they save a
chosen sample as a custom voice and speak through the cloning engine. That is the flow the design routes follow.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

from max_speech.engines.mlx_gate import MLX_GATE, stepwise

log = logging.getLogger(__name__)

MODEL_RATE = 24000
LANG_CODES = {"en": "english", "zh": "chinese"}
IDLE_SECONDS = 600.0
SWEEP_SECONDS = 30.0
# Design is batch work, so it runs as a stream: each chunk (this many seconds of audio, about 0.2 s of work on an
# M5 Max) is one unit under the MLX gate and live speech can take the GPU between two. The tokens are sampled exactly
# as without streaming; only the decoder runs incrementally, and on the real model the two waveforms differ by float
# rounding only (same length, correlation 1.00000, RMS difference -64 dB below the signal).
STREAMING_INTERVAL = 0.5
LOAD_PIECE_BYTES = 256 * 1024 * 1024  # weights evaluated per hold of the gate while loading (4.5 GB in all)


def _load_model(model_dir: Path):
    """`load_model(lazy=False)`, with the weights evaluated a piece at a time so a load never holds the GPU for long."""
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_audio.tts.utils import load_model

    # One unit, not split: mlx-audio's post-load hook builds the speech tokenizer and evaluates its 651 MB of weights
    # in one mx.eval. Measured on an M5 Max with the files in the page cache: 0.16-0.18 s for the whole unit once
    # mlx-audio is imported (cloning did that); reading them cold from the SSD adds roughly 0.1-0.2 s more.
    with MLX_GATE:
        model = load_model(str(model_dir), lazy=True)
    piece, size = [], 0
    for _, array in tree_flatten(model.parameters()):
        piece.append(array)
        size += array.nbytes
        if size >= LOAD_PIECE_BYTES:
            with MLX_GATE:
                mx.eval(piece)
            piece, size = [], 0
    with MLX_GATE:
        mx.eval(piece)
    return model


def _seed(seed: int) -> None:
    import mlx.core as mx

    mx.random.seed(seed)  # generate() has no seed argument; it samples from mlx's global generator


def _release() -> None:
    """Free the dropped model's memory. Called with MLX_GATE held: freeing MLX buffers is MLX work too."""
    import gc

    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        log.debug("could not clear the mlx cache", exc_info=True)


class Qwen3MlxDesign:
    id = "qwen3-design-mlx"
    sample_rate = MODEL_RATE
    languages = tuple(LANG_CODES)

    def __init__(
        self,
        model_dir: Path,
        model_id: str,
        *,
        idle_seconds: float = IDLE_SECONDS,
        sweep_seconds: float = SWEEP_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        loader: Callable[[Path], object] = _load_model,
        seeder: Callable[[int], None] = _seed,
        release: Callable[[], None] = _release,
        sweeper: bool = True,
    ) -> None:
        """The keyword arguments after `model_id` are for tests. `sweeper=False` leaves the background thread
        off, so a test drives `sweep()` itself with a fake `clock`."""
        self.model_dir = Path(model_dir)
        self.model_id = model_id
        self.idle_seconds = idle_seconds
        self._sweep_seconds = sweep_seconds
        self._clock = clock
        self._loader = loader
        self._seeder = seeder
        self._release = release
        self._use_sweeper = sweeper
        self._lock = threading.Lock()  # held while loading, generating and unloading
        self._model = None
        self._last_used = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def design(self, description: str, text: str, language: str, seed: int) -> np.ndarray:
        """Speak `text` in a voice matching `description`: 24 kHz mono float32. The same seed, text and
        description give the same audio."""
        lang_code = LANG_CODES.get(language.strip().replace("_", "-").split("-", 1)[0].lower())
        if lang_code is None:
            raise ValueError(f"voice design supports {', '.join(LANG_CODES)}; got {language!r}")
        if not description.strip():
            raise ValueError("a description is required")
        with self._lock:
            self._load_locked()
            try:
                # mlx keeps its random generator per thread, and this whole generation runs on this thread, so the
                # seed stays with it even when other threads' MLX work runs between its chunks.
                with MLX_GATE:
                    self._seeder(seed)
                stream = self._model.generate(
                    text=text,
                    instruct=description,
                    lang_code=lang_code,
                    stream=True,
                    streaming_interval=STREAMING_INTERVAL,
                )
                chunks = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in stepwise(stream)]
            finally:
                self._last_used = self._clock()
        audio = np.concatenate([c for c in chunks if c.size]) if chunks else np.zeros(0, dtype=np.float32)
        if audio.size == 0:
            raise RuntimeError("the design model produced no audio")
        return audio.astype(np.float32, copy=False)

    def ensure_loaded(self) -> None:
        """Load the weights now if they are not loaded (several seconds the first time). Routes call this before
        they take the speech lock, so the load never blocks live speech; `design()` still loads if it must."""
        with self._lock:
            self._load_locked()
            self._last_used = self._clock()

    def _load_locked(self) -> None:
        if self._model is None:
            log.info("loading voice design model %s", self.model_id)
            self._model = self._loader(self.model_dir)
            self._start_sweeper()

    # ---- idle unload ----

    def sweep(self) -> bool:
        """Unload the model if it has sat unused for `idle_seconds`; True when it did."""
        with self._lock:
            if self._model is None or self._clock() - self._last_used < self.idle_seconds:
                return False
            self._unload()
            return True

    def _unload(self) -> None:
        log.info("unloading voice design model %s after %.0f s idle", self.model_id, self.idle_seconds)
        self._drop()

    def _drop(self) -> None:
        """Drop the model and free its memory in one hold of the gate (called with `_lock` held)."""
        with MLX_GATE:
            self._model = None
            self._release()

    def _start_sweeper(self) -> None:
        if not self._use_sweeper or (self._thread is not None and self._thread.is_alive()):
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._sweep_loop, name="design-idle-sweep", daemon=True)
        self._thread.start()

    def _sweep_loop(self) -> None:
        while not self._stop.wait(self._sweep_seconds):
            self.sweep()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            if self._model is not None:
                self._drop()
