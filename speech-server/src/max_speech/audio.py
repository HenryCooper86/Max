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


def _linear(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    n_out = round(len(x) * dst_rate / src_rate)
    if len(x) == 0 or n_out == 0:
        return np.zeros(0, dtype=np.float32)
    positions = np.linspace(0, len(x) - 1, n_out)
    return np.interp(positions, np.arange(len(x)), x).astype(np.float32)


class DownResampler:
    """Streaming downsampler: windowed-sinc FIR low-pass at 0.45 x the output rate, then interpolation.

    Chunks can be fed one by one (`process`, then `flush` at the end); the filter history and the output phase
    carry over, so chunk edges leave no glitch and the result equals the one-shot `resample`.
    """

    def __init__(self, src_rate: int, dst_rate: int) -> None:
        if not 0 < dst_rate < src_rate:
            raise ValueError("DownResampler only downsamples")
        self.src, self.dst = src_rate, dst_rate
        ratio = src_rate / dst_rate
        taps = int(32 * ratio) | 1  # odd, so the filter has an exact centre
        self._half = taps // 2
        cutoff = 0.45 * dst_rate / src_rate  # cycles per input sample
        n = np.arange(taps) - self._half
        h = 2 * cutoff * np.sinc(2 * cutoff * n) * np.blackman(taps)
        self._h = (h / h.sum()).astype(np.float64)
        self._buf = np.zeros(self._half, dtype=np.float64)  # the signal is zero before it starts
        self._base = -self._half  # absolute input index of _buf[0]
        self._next = 0  # index of the next output sample

    def process(self, chunk: np.ndarray, *, _final: bool = False) -> np.ndarray:
        self._buf = np.concatenate([self._buf, np.asarray(chunk, dtype=np.float64).reshape(-1)])
        if len(self._buf) < len(self._h):
            return np.zeros(0, dtype=np.float32)
        filtered = np.convolve(self._buf, self._h, mode="valid")  # centres base+half ...
        first = self._base + self._half
        last = first + len(filtered) - 1
        # output j sits at input position j * src / dst
        j_max = int(np.floor(last * self.dst / self.src)) + 1
        js = np.arange(self._next, j_max)
        pos = js * (self.src / self.dst)
        i0 = np.floor(pos).astype(np.int64)
        frac = pos - i0
        ok = (i0 + 1 <= last) | ((i0 == last) & (frac == 0))
        js, i0, frac = js[ok], i0[ok], frac[ok]
        if len(js) == 0:
            return np.zeros(0, dtype=np.float32)
        a = filtered[i0 - first]
        b = filtered[np.minimum(i0 + 1, last) - first]
        out = (a + (b - a) * frac).astype(np.float32)
        self._next = int(js[-1]) + 1
        keep_from = max(self._base, int(np.floor(self._next * self.src / self.dst)) - self._half)
        self._buf = self._buf[keep_from - self._base :]
        self._base = keep_from
        return out

    def flush(self) -> np.ndarray:
        """The last output samples, which still needed the filter's look-ahead."""
        return self.process(np.zeros(self._half))


def resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Equal rates return `x` as is. Downsampling is low-passed first (no aliasing); upsampling is linear."""
    if src_rate == dst_rate:
        return x
    if dst_rate < src_rate and len(x):
        r = DownResampler(src_rate, dst_rate)
        parts = [r.process(x), r.flush()]
        return np.concatenate(parts).astype(np.float32, copy=False)
    return _linear(x, src_rate, dst_rate)


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
