"""Streaming speech-to-text with sherpa-onnx (X-ASR zipformer transducer or streaming paraformer).

Turn-taking decides when an utterance ends, so sherpa's own endpointing is disabled. The sherpa import is
deferred to `_build_recognizer` so importing this module stays cheap.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from max_speech.engines.base import SttStream
from max_speech.models import ModelDownloadError, extracted_root

RATE = 16000
# The transducer emits a word only once it has seen about a second of audio after it. Turn-taking ends a
# turn 120-200 ms into the quiet, so `finish` supplies the rest as zeros; with 0.5 s the last word was
# routinely lost ("capital of France" -> "capital of"). 1.5 s costs ~30 ms of compute per turn.
TAIL_PAD_S = 1.5
KINDS = ("transducer", "paraformer")


def _resolve_dir(model_dir: Path) -> Path:
    """Sherpa archives hold one top-level directory; flat downloads have the tokens file at the root."""
    try:
        return extracted_root(Path(model_dir), "tokens.txt")
    except ModelDownloadError:
        raise FileNotFoundError(f"tokens.txt not found in {model_dir}") from None


def _pick(root: Path, *patterns: str) -> str:
    for pattern in patterns:
        found = sorted(root.glob(pattern))
        if found:
            return str(found[0])
    raise FileNotFoundError(f"no file matching {' or '.join(patterns)} in {root}")


def _build_recognizer(model_dir: Path, kind: str):
    import sherpa_onnx

    root = _resolve_dir(model_dir)
    common = {"tokens": str(root / "tokens.txt"), "num_threads": 2, "enable_endpoint_detection": False}
    if kind == "paraformer":
        return sherpa_onnx.OnlineRecognizer.from_paraformer(
            encoder=_pick(root, "encoder*.int8.onnx", "encoder*.onnx"),
            decoder=_pick(root, "decoder*.int8.onnx", "decoder*.onnx"),
            **common,
        )
    extra = {}
    if (root / "bpe.model").exists():
        extra = {"modeling_unit": "bpe", "bpe_vocab": str(root / "bpe.model")}
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=_pick(root, "encoder*.int8.onnx", "encoder*.onnx"),
        decoder=_pick(root, "decoder*.int8.onnx", "decoder*.onnx"),
        joiner=_pick(root, "joiner*.int8.onnx", "joiner*.onnx"),
        **common,
        **extra,
    )


class _Stream:
    def __init__(self, engine: SherpaStreamingStt):
        self._engine = engine
        self._stream = engine._create()
        self._last = ""

    def accept(self, audio: np.ndarray) -> str | None:
        text = self._engine._feed(self._stream, np.asarray(audio, dtype=np.float32))
        if text == self._last:
            return None
        self._last = text
        return text

    def finish(self) -> str:
        text = self._engine._finish(self._stream)
        self._last = text
        return text

    def reset(self) -> None:
        # Sherpa's own reset() does not clear input_finished, so build a new stream.
        self._stream = self._engine._create()
        self._last = ""


class SherpaStreamingStt:
    id = "sherpa-onnx"
    # Both supported models (the X-ASR zipformer and the streaming paraformer) are bilingual Chinese/English only.
    languages = ("zh", "en")
    # Hotwords need modified_beam_search plus a BPE vocab file; the X-ASR download ships only bpe.model, and the
    # greedy decoder used here ignores them. Advertised as unsupported rather than accepted and dropped.
    keyterms = False

    def __init__(self, model_dir: Path, kind: str = "transducer", model_id: str = "x-asr-zh-en-480ms"):
        if kind not in KINDS:
            raise ValueError(f"unknown streaming stt kind {kind!r}; choose one of {', '.join(KINDS)}")
        self.model_id = model_id
        self.kind = kind
        self._recognizer = _build_recognizer(Path(model_dir), kind)
        self._lock = threading.Lock()  # the recognizer is shared by every stream

    # -- internals, all serialized on the lock --------------------------------------------------------------

    def _create(self):
        with self._lock:
            return self._recognizer.create_stream()

    def _read(self, stream) -> str:
        result = self._recognizer.get_result(stream)
        text = result if isinstance(result, str) else result.text
        return text.strip()

    def _drain(self, stream) -> None:
        while self._recognizer.is_ready(stream):
            self._recognizer.decode_stream(stream)

    def _feed(self, stream, audio: np.ndarray) -> str:
        with self._lock:
            stream.accept_waveform(RATE, audio)
            self._drain(stream)
            return self._read(stream)

    def _finish(self, stream) -> str:
        with self._lock:
            stream.accept_waveform(RATE, np.zeros(int(TAIL_PAD_S * RATE), dtype=np.float32))
            stream.input_finished()
            self._drain(stream)
            return self._read(stream)

    # -- StreamingSttEngine ---------------------------------------------------------------------------------

    def new_stream(self, *, language: str | None = None, keyterms: tuple[str, ...] = ()) -> SttStream:
        # `language` and `keyterms` are accepted for the protocol; the model is bilingual and `keyterms` is False.
        return _Stream(self)

    def warm_up(self) -> None:
        stream = self.new_stream()
        stream.accept(np.zeros(RATE // 2, dtype=np.float32))
        stream.finish()
