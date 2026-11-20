import io

import numpy as np
import pytest
import soundfile as sf

from max_speech.audio import (
    INPUT_RATE,
    OUTPUT_RATE,
    AudioDecodeError,
    DownResampler,
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


def _tone(hz, rate, seconds=1.0):
    t = np.arange(int(rate * seconds)) / rate
    return (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _rms_db(x):
    x = x[len(x) // 10 : -len(x) // 10]  # ignore the edges
    return 20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def test_downsampling_attenuates_what_would_alias():
    # 15 kHz at 48 kHz folds to 9 kHz at 24 kHz unless it is filtered out first
    ref = _rms_db(_tone(15_000, 48_000))
    assert _rms_db(resample(_tone(15_000, 48_000), 48_000, 24_000)) < ref - 40


def test_downsampling_passes_speech_band_and_keeps_length():
    ref = _rms_db(_tone(1_000, 48_000))
    out = resample(_tone(1_000, 48_000), 48_000, 24_000)
    assert abs(_rms_db(out) - ref) < 0.5
    assert len(out) == 24_000


def test_streaming_downsampler_matches_one_shot_for_any_chunking():
    x = _tone(1_000, 48_000, 0.5) + _tone(3_300, 48_000, 0.5)
    r = DownResampler(48_000, 24_000)
    parts = [r.process(x[i : i + 777]) for i in range(0, len(x), 777)] + [r.flush()]
    assert np.allclose(np.concatenate(parts), resample(x, 48_000, 24_000), atol=1e-5)
    assert len(resample(x, 44_100, 24_000)) == round(len(x) * 24_000 / 44_100)
