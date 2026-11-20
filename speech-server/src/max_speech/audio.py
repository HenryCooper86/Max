from __future__ import annotations

import io
import struct

import numpy as np
import soundfile as sf

OUTPUT_RATE = 24_000
INPUT_RATE = 16_000


class AudioDecodeError(ValueError):
    pass


def float_to_pcm16(x: np.ndarray) -> bytes:
    # Symmetric scale (32767) so +1.0 and -1.0 both fit without wrapping.
    clipped = np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0)
    return np.rint(clipped * 32767.0).astype("<i2").tobytes()


def pcm16_to_float(b: bytes) -> np.ndarray:
    return (np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0).astype(np.float32)


def resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    # Linear interpolation is enough for speech at these rates and avoids a scipy dependency.
    if src_rate == dst_rate:
        return x
    n_out = round(len(x) * dst_rate / src_rate)
    if len(x) == 0 or n_out == 0:
        return np.zeros(0, dtype=np.float32)
    positions = np.linspace(0, len(x) - 1, n_out)
    return np.interp(positions, np.arange(len(x)), x).astype(np.float32)


def wav_bytes(pcm16: bytes, rate: int) -> bytes:
    # Canonical 44-byte header, mono 16-bit, so streaming clients can parse it without surprises.
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm16))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm16))
    )
    return header + pcm16


def decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    try:
        samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as exc:
        raise AudioDecodeError("could not read the audio file; send WAV, FLAC or OGG") from exc
    return samples.mean(axis=1).astype(np.float32), int(rate)
