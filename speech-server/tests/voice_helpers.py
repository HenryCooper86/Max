"""Shared builders for the custom-voice tests."""

import io

import numpy as np
import soundfile as sf

CONSENT = {
    "consent": "true",
    "consent_statement": "I, Ava Lee, agree that my voice may be cloned for the Acme assistant.",
    "consent_speaker": "Ava Lee",
}
STATEMENT = CONSENT["consent_statement"]


def speech_like(seconds=8.0, rate=24000, amp=0.3, lead=0.0, tail=0.0):
    """A tone that wobbles in loudness, with optional silence before and after."""
    n = int(seconds * rate)
    t = np.arange(n, dtype=np.float32) / rate
    body = amp * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    return np.concatenate([np.zeros(int(lead * rate)), body, np.zeros(int(tail * rate))]).astype(np.float32)


def wav_of(samples, rate=24000, subtype="PCM_16", fmt="WAV") -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format=fmt, subtype=subtype)
    return buf.getvalue()


def good_wav(seconds=8.0, rate=24000) -> bytes:
    return wav_of(speech_like(seconds, rate), rate)
