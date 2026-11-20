import io

import numpy as np
import pytest
import soundfile as sf

from max_speech.audio import (
    INPUT_RATE,
    OUTPUT_RATE,
    AudioDecodeError,
    decode_audio,
    float_to_pcm16,
    pcm16_to_float,
    resample,
    wav_bytes,
)


def test_rates():
    assert OUTPUT_RATE == 24_000
    assert INPUT_RATE == 16_000


def test_pcm_round_trip():
    x = np.linspace(-1, 1, 101, dtype=np.float32)
    y = pcm16_to_float(float_to_pcm16(x))
    assert y.dtype == np.float32
    assert np.max(np.abs(x - y)) < 1e-3


def test_float_to_pcm16_clips_and_is_little_endian():
    b = float_to_pcm16(np.array([2.0, -2.0, 0.0], dtype=np.float32))
    assert np.frombuffer(b, dtype="<i2").tolist() == [32767, -32767, 0]


def test_resample_length_and_identity():
    x = np.sin(np.linspace(0, 20, 22050)).astype(np.float32)
    y = resample(x, 22050, 24000)
    assert len(y) == 24000
    assert y.dtype == np.float32
    assert resample(x, 22050, 22050) is x


def test_wav_header_parses():
    pcm = float_to_pcm16(np.zeros(2400, dtype=np.float32))
    wav = wav_bytes(pcm, 24000)
    assert len(wav) == 44 + len(pcm)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    info = sf.info(io.BytesIO(wav))
    assert (info.samplerate, info.channels, info.subtype) == (24000, 1, "PCM_16")
    assert info.frames == 2400


def test_decode_audio_wav_and_stereo_mixdown():
    buf = io.BytesIO()
    stereo = np.stack([np.full(1600, 0.5), np.full(1600, -0.5)], axis=1)
    sf.write(buf, stereo, 16000, format="WAV", subtype="PCM_16")
    x, rate = decode_audio(buf.getvalue())
    assert rate == 16000 and x.dtype == np.float32 and x.ndim == 1 and len(x) == 1600
    assert np.max(np.abs(x)) < 1e-3


def test_decode_audio_flac():
    buf = io.BytesIO()
    sf.write(buf, np.zeros(800, dtype=np.float32), 16000, format="FLAC")
    x, rate = decode_audio(buf.getvalue())
    assert rate == 16000 and len(x) == 800


def test_decode_garbage_raises():
    with pytest.raises(AudioDecodeError, match="WAV, FLAC or OGG"):
        decode_audio(b"definitely not audio")
