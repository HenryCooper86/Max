#!/usr/bin/env python3
"""A reference device client for the Max voice kit.

One file, standard library plus two small packages, written to be read. It
does the four things every device has to do:

  capture       microphone -> 16 kHz mono PCM16, 20 ms frames, to the relay
  playback      24 kHz mono PCM16 from the relay -> the speaker
  interruption  stop the assistant mid-sentence when the wearer speaks
  reconnect     come back after a dropped link, without hammering the relay

It runs on a Raspberry Pi or any Linux board with a sound card, and on a
laptop for trying things out. With --play/--record it uses WAV files in place
of the sound card, which is how it is tested and how the audio test bench
drives a relay.

The protocol is small. Over one WebSocket (the relay's /agent path):

  device -> relay   {"type": "session.start", sampleRate, channels, audio: {...}}
  relay -> device   {"type": "session.started", audio: {...}}     the relay's plan
  device -> relay   {"type": "audio.start"}
  device -> relay   binary frames: microphone PCM
  relay -> device   binary frames: the assistant's voice
  relay -> device   JSON events: status, transcript, error, ...

docs/audio/contract.md describes the audio side of it in full.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import collections
import json
import math
import os
import sys
import threading
import time
import urllib.parse
import wave
from dataclasses import dataclass, field
from typing import AsyncIterator, Deque, Dict, List, Optional

MIC_RATE = 16_000  # what the relay accepts
PROTOCOL = 1  # the wire protocol this client speaks (docs/protocol.md, "Versions")
VOICE_RATE = 24_000  # what the relay sends
FRAME_SAMPLES = 320  # 20 ms at 16 kHz
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_SECONDS = FRAME_SAMPLES / MIC_RATE
IDLE_CLOSE_CODE = 4001  # the relay closed a quiet session; do not reconnect at once


# --------------------------------------------------------------------------
# Small pure pieces. These are what test_max_device.py exercises directly.
# --------------------------------------------------------------------------


def frame_rms(frame: bytes) -> float:
    """Loudness of one PCM16 frame, 0..32768."""
    samples = array.array("h")
    samples.frombytes(frame[: len(frame) - len(frame) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return 0.0
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def backoff_seconds(attempt: int) -> float:
    """Wait before reconnect number `attempt` (0, 1, 2, ...): 1, 2, 4 ... 30 s."""
    return float(min(30, 2 ** min(attempt, 5)))


def relay_url(url: str, token: str) -> str:
    """The relay reads a token from ?token=, the form every Max client uses."""
    if not token:
        return url
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "token"] + [("token", token)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


@dataclass
class DeviceAudio:
    """What this device's own hardware and firmware do to the microphone.

    Say only what is true. None means "unknown" and is left out, and the relay
    then treats the device as it would any other.
    """

    echo_cancellation: Optional[bool] = None
    noise_suppression: Optional[bool] = None
    auto_gain_control: Optional[bool] = None
    voice_gate: Optional[bool] = None
    wake_word: Optional[bool] = None
    microphones: Optional[int] = None
    speaker: Optional[str] = None  # sealed | open | bone | loudspeaker

    def declaration(self) -> Dict[str, object]:
        fields = {
            "echoCancellation": self.echo_cancellation,
            "noiseSuppression": self.noise_suppression,
            "autoGainControl": self.auto_gain_control,
            "voiceGate": self.voice_gate,
            "wakeWord": self.wake_word,
            "microphones": self.microphones,
            "speaker": self.speaker,
        }
        return {key: value for key, value in fields.items() if value is not None}


def session_start(label: str, audio: DeviceAudio) -> Dict[str, object]:
    event: Dict[str, object] = {
        "type": "session.start",
        "sampleRate": MIC_RATE,
        "channels": 1,
        "platform": "embedded",
        "protocol": PROTOCOL,
        "deviceLabel": label,
    }
    declared = audio.declaration()
    if declared:
        event["audio"] = declared
    return event


class VoiceGate:
    """Decides whether the wearer is speaking, from loudness alone.

    Opens after a few loud frames in a row and stays open through a short
    pause, so the gap between two words does not chop a sentence. A real
    product would use its DSP's voice detector; this is the simplest thing
    that behaves.
    """

    def __init__(self, threshold: float = 900.0, open_frames: int = 3, hold_frames: int = 30):
        self.threshold = threshold
        self.open_frames = open_frames
        self.hold_frames = hold_frames
        self._loud = 0
        self._hold = 0

    @property
    def open(self) -> bool:
        return self._hold > 0

    def push(self, rms: float) -> bool:
        if rms >= self.threshold:
            self._loud += 1
            if self._loud >= self.open_frames:
                self._hold = self.hold_frames
        else:
            self._loud = 0
            if self._hold > 0:
                self._hold -= 1
        return self.open


class InterruptionGuard:
    """Confirms an interruption against this device's own microphone.

    The relay says "hearing" when its speech detector fires. On a device whose
    speaker reaches its microphone, that detector can be hearing the assistant
    itself. When the relay's plan says `bargeIn: "confirm"`, cut the reply only
    if this microphone was loud around the same moment.
    """

    def __init__(self, threshold: float = 900.0, frames: int = 3, window_seconds: float = 0.6):
        self.threshold = threshold
        self.frames = frames
        self.window_seconds = window_seconds
        self._loud = 0
        self._heard_at = float("-inf")

    def observe(self, rms: float, now: float) -> None:
        self._loud = self._loud + 1 if rms >= self.threshold else 0
        if self._loud >= self.frames:
            self._heard_at = now

    def confirmed(self, now: float) -> bool:
        return now - self._heard_at <= self.window_seconds


# --------------------------------------------------------------------------
# Sound in and out. Two implementations each: the sound card, and WAV files.
# --------------------------------------------------------------------------


class SoundCardMic:
    """Microphone frames from the default (or named) input device."""

    def __init__(self, device: Optional[str]):
        import sounddevice  # imported here so file mode needs no sound card

        self._queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=50)
        self._loop = asyncio.get_running_loop()
        self._stream = sounddevice.RawInputStream(
            samplerate=MIC_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            device=device,
            callback=self._on_audio,
        )
        self._stream.start()

    def _on_audio(self, data, _frames, _time, _status) -> None:
        # Called on the sound card's thread. Hand the frame to the event loop;
        # if the network is behind, drop the frame rather than fall behind.
        frame = bytes(data)
        self._loop.call_soon_threadsafe(self._offer, frame)

    def _offer(self, frame: bytes) -> None:
        if not self._queue.full():
            self._queue.put_nowait(frame)

    async def frames(self) -> AsyncIterator[bytes]:
        while True:
            yield await self._queue.get()

    def close(self) -> None:
        self._stream.stop()
        self._stream.close()


class SoundCardSpeaker:
    """Plays the assistant's voice. `flush` drops whatever has not played yet."""

    def __init__(self, device: Optional[str]):
        import sounddevice

        self._lock = threading.Lock()
        self._pending = bytearray()
        self._stream = sounddevice.RawOutputStream(
            samplerate=VOICE_RATE,
            channels=1,
            dtype="int16",
            blocksize=VOICE_RATE // 50,
            device=device,
            callback=self._on_need,
        )
        self._stream.start()

    def _on_need(self, out, _frames, _time, _status) -> None:
        wanted = len(out)
        with self._lock:
            chunk = bytes(self._pending[:wanted])
            del self._pending[:wanted]
        out[: len(chunk)] = chunk
        out[len(chunk) :] = b"\x00" * (wanted - len(chunk))  # silence when idle

    def write(self, pcm: bytes) -> None:
        with self._lock:
            self._pending.extend(pcm)

    def flush(self) -> None:
        with self._lock:
            self._pending.clear()

    def close(self) -> None:
        self._stream.stop()
        self._stream.close()


class WavMic:
    """Plays a 16 kHz mono 16-bit WAV as if it were the microphone.

    Frames are paced at real time. After the file ends it sends silence, as an
    open microphone in a quiet room would, unless `stop_at_end` is set.
    """

    def __init__(self, path: str, stop_at_end: bool = False, tail_seconds: float = 6.0):
        with wave.open(path, "rb") as source:
            if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (MIC_RATE, 1, 2):
                raise SystemExit(f"{path}: need 16 kHz mono 16-bit WAV (try: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav)")
            self._pcm = source.readframes(source.getnframes())
        self._stop_at_end = stop_at_end
        self._tail_frames = int(tail_seconds / FRAME_SECONDS)
        self.finished = asyncio.Event()

    async def frames(self) -> AsyncIterator[bytes]:
        started = time.monotonic()
        sent = 0
        for offset in range(0, len(self._pcm) - FRAME_BYTES + 1, FRAME_BYTES):
            yield self._pcm[offset : offset + FRAME_BYTES]
            sent += 1
            await asyncio.sleep(max(0.0, started + sent * FRAME_SECONDS - time.monotonic()))
        if not self._stop_at_end:
            for _ in range(self._tail_frames):
                yield bytes(FRAME_BYTES)
                sent += 1
                await asyncio.sleep(max(0.0, started + sent * FRAME_SECONDS - time.monotonic()))
        self.finished.set()
        await asyncio.Event().wait()  # the file is done; stay quiet

    def close(self) -> None:
        pass


class WavSpeaker:
    """Writes the assistant's voice to a WAV file and counts interruptions."""

    def __init__(self, path: Optional[str]):
        self.flushes = 0
        self.bytes_played = 0
        self._file = None
        if path:
            self._file = wave.open(path, "wb")
            self._file.setnchannels(1)
            self._file.setsampwidth(2)
            self._file.setframerate(VOICE_RATE)

    def write(self, pcm: bytes) -> None:
        self.bytes_played += len(pcm)
        if self._file:
            self._file.writeframes(pcm)

    def flush(self) -> None:
        self.flushes += 1

    def close(self) -> None:
        if self._file:
            self._file.close()
            self._file = None


# --------------------------------------------------------------------------
# The session: one connection to the relay, and the loop that keeps one up.
# --------------------------------------------------------------------------


@dataclass
class Settings:
    relay: str
    token: str = ""
    label: str = "Reference device"
    audio: DeviceAudio = field(default_factory=DeviceAudio)
    gate_threshold: float = 900.0
    max_reconnects: Optional[int] = None  # None: keep trying, as a device should
    verbose: bool = True


class Device:
    def __init__(self, settings: Settings, mic, speaker):
        self.settings = settings
        self.mic = mic
        self.speaker = speaker
        self.plan: Dict[str, object] = {}
        self.events: List[Dict[str, object]] = []  # everything the relay said, for tests and the bench
        self.frames_sent = 0
        self.sessions = 0
        self._gate = VoiceGate(settings.gate_threshold)
        self._guard = InterruptionGuard(settings.gate_threshold)
        self._recent: Deque[float] = collections.deque(maxlen=5)

    def log(self, line: str) -> None:
        if self.settings.verbose:
            print(line, flush=True)

    async def run(self) -> None:
        """Keep a session up: connect, talk, and reconnect when the link drops."""
        import websockets

        attempt = 0
        while True:
            closed_idle = False
            try:
                url = relay_url(self.settings.relay, self.settings.token)
                async with websockets.connect(url, ping_interval=15, ping_timeout=15, max_size=None) as socket:
                    attempt = 0  # a successful connection resets the backoff
                    await self._session(socket)
                    closed_idle = socket.close_code == IDLE_CLOSE_CODE
            except asyncio.CancelledError:
                raise
            except Exception as error:  # refused, dropped, timed out: all end up here
                self.log(f"[link] {type(error).__name__}: {error}")
                closed_idle = getattr(getattr(error, "rcvd", None), "code", None) == IDLE_CLOSE_CODE
            self.speaker.flush()  # nothing half-said survives a dropped link

            if closed_idle:
                # The relay hung up because nobody was talking. Coming straight
                # back would only be hung up on again: wait for a voice.
                self.log("[link] idle; waiting for speech before reconnecting")
                await self._wait_for_speech()
                continue
            if self.settings.max_reconnects is not None and attempt >= self.settings.max_reconnects:
                return
            wait = backoff_seconds(attempt)
            attempt += 1
            self.log(f"[link] reconnecting in {wait:.0f} s")
            await asyncio.sleep(wait)

    async def _session(self, socket) -> None:
        self.sessions += 1
        self.plan = {}
        await socket.send(json.dumps(session_start(self.settings.label, self.settings.audio)))
        sender: Optional[asyncio.Task] = None
        try:
            async for message in socket:
                if isinstance(message, bytes):
                    self.speaker.write(message)  # the assistant's voice
                    continue
                event = json.loads(message)
                self.events.append(event)
                kind = event.get("type")
                if kind == "session.started":
                    # Only now is the relay ready for audio. Sending earlier
                    # is an error, and after a reconnect it must be said again.
                    self.plan = event.get("audio") or {}
                    self.log(f"[relay] session started; audio plan {self.plan or '(none)'}")
                    await socket.send(json.dumps({"type": "audio.start"}))
                    sender = asyncio.ensure_future(self._send_microphone(socket))
                elif kind == "status" and event.get("state") == "hearing":
                    await self._interrupt()
                elif kind == "hazard.alert" and event.get("interrupt"):
                    self.speaker.flush()  # a safety alert always cuts in
                elif kind == "transcript" and event.get("final"):
                    self.log(f"[{event.get('speaker')}] {event.get('text')}")
                elif kind == "error":
                    self.log(f"[relay] error: {event.get('message')}")
        finally:
            if sender:
                sender.cancel()

    async def _send_microphone(self, socket) -> None:
        gating = bool(self.settings.audio.voice_gate)
        async for frame in self.mic.frames():
            rms = frame_rms(frame)
            self._recent.append(rms)
            self._guard.observe(rms, time.monotonic())
            # A device that declared `voiceGate` sends speech only. The relay
            # was told, and supplies the silence that ends a turn itself.
            if gating and not self._gate.push(rms):
                continue
            await socket.send(frame)
            self.frames_sent += 1

    async def _interrupt(self) -> None:
        """The relay heard speech while the assistant may be talking."""
        if self.plan.get("bargeIn") == "confirm":
            # Give this microphone a moment to agree before cutting the reply.
            deadline = time.monotonic() + 0.3
            while not self._guard.confirmed(time.monotonic()):
                if time.monotonic() >= deadline:
                    return  # the relay heard the speaker, not the wearer
                await asyncio.sleep(0.02)
        self.speaker.flush()

    async def _wait_for_speech(self) -> None:
        gate = VoiceGate(self.settings.gate_threshold)
        async for frame in self.mic.frames():
            if gate.push(frame_rms(frame)):
                return


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def _flag(value: Optional[str]) -> Optional[bool]:
    return None if value is None else value == "yes"


def parse_arguments(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reference device client for the Max voice kit.")
    parser.add_argument("--relay", default=os.environ.get("MAX_RELAY_URL", "ws://localhost:8787/agent"),
                        help="the relay's /agent address (ws:// or wss://)")
    parser.add_argument("--token", default=os.environ.get("MAX_RELAY_TOKEN", ""), help="relay or session token, if the relay needs one")
    parser.add_argument("--label", default="Reference device", help="how this device shows up in the relay's logs")
    sound = parser.add_argument_group("sound card")
    sound.add_argument("--input-device", help="microphone device name or index (default: system default)")
    sound.add_argument("--output-device", help="speaker device name or index (default: system default)")
    files = parser.add_argument_group("files instead of a sound card")
    files.add_argument("--play", metavar="WAV", help="send this 16 kHz mono WAV as the microphone")
    files.add_argument("--record", metavar="WAV", help="write the assistant's voice to this WAV")
    files.add_argument("--seconds", type=float, help="stop after this long (default with --play: file length + 6 s)")
    declare = parser.add_argument_group("what this device already does (say only what is true)")
    for name, text in (("aec", "cancels its own speaker's echo"), ("ns", "suppresses background noise"),
                       ("agc", "levels the microphone gain"), ("voice-gate", "stops sending when nobody speaks"),
                       ("wake-word", "detects the wake word itself")):
        declare.add_argument(f"--{name}", choices=("yes", "no"), help=text)
    declare.add_argument("--microphones", type=int, help="number of microphones")
    declare.add_argument("--speaker", choices=("sealed", "open", "bone", "loudspeaker"), help="how the voice reaches the wearer")
    parser.add_argument("--gate-threshold", type=float, default=900.0, help="loudness (RMS, 0-32768) that counts as speech")
    return parser.parse_args(argv)


async def main(argv: Optional[List[str]] = None) -> Device:
    args = parse_arguments(argv)
    audio = DeviceAudio(
        echo_cancellation=_flag(args.aec),
        noise_suppression=_flag(args.ns),
        auto_gain_control=_flag(args.agc),
        voice_gate=_flag(args.voice_gate),
        wake_word=_flag(args.wake_word),
        microphones=args.microphones,
        speaker=args.speaker,
    )
    settings = Settings(relay=args.relay, token=args.token, label=args.label, audio=audio, gate_threshold=args.gate_threshold)
    mic = WavMic(args.play) if args.play else SoundCardMic(args.input_device)
    speaker = WavSpeaker(args.record) if (args.record or args.play) else SoundCardSpeaker(args.output_device)
    device = Device(settings, mic, speaker)

    seconds = args.seconds
    if seconds is None and args.play:
        with wave.open(args.play, "rb") as source:
            seconds = source.getnframes() / source.getframerate() + 6.0
    try:
        await asyncio.wait_for(device.run(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        mic.close()
        speaker.close()
    return device


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
