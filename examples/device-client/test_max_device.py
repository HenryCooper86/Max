"""Tests for the reference device client.

Run with:  python3 -m unittest -v test_max_device   (from this directory)

The session tests talk to a small scripted relay on localhost, so they cover
the real connection code: capture, playback, interruption and reconnect.
"""

import asyncio
import contextlib
import io
import json
import math
import os
import struct
import tempfile
import unittest
import wave

import websockets

import max_device
from max_device import (
    Device,
    DeviceAudio,
    InterruptionGuard,
    Settings,
    VoiceGate,
    WavMic,
    WavSpeaker,
    backoff_seconds,
    frame_rms,
    relay_url,
    session_start,
)


def tone(seconds, amplitude=8000, rate=16000):
    count = int(seconds * rate)
    return b"".join(struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 220 * n / rate))) for n in range(count))


def write_wav(path, pcm, rate=16000):
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm)


class PureParts(unittest.TestCase):
    def test_rms_of_silence_and_of_a_tone(self):
        self.assertEqual(frame_rms(bytes(640)), 0.0)
        self.assertAlmostEqual(frame_rms(tone(0.02)), 8000 / math.sqrt(2), delta=300)

    def test_backoff_doubles_and_stops_at_thirty_seconds(self):
        self.assertEqual([backoff_seconds(n) for n in range(7)], [1, 2, 4, 8, 16, 30, 30])

    def test_token_goes_in_the_query_and_replaces_an_old_one(self):
        self.assertEqual(relay_url("ws://relay/agent", ""), "ws://relay/agent")
        self.assertEqual(relay_url("wss://relay/agent", "abc"), "wss://relay/agent?token=abc")
        self.assertEqual(relay_url("wss://relay/agent?token=old&x=1", "new"), "wss://relay/agent?x=1&token=new")

    def test_session_start_declares_only_what_was_stated(self):
        bare = session_start("Board", DeviceAudio())
        self.assertNotIn("audio", bare)
        self.assertEqual((bare["sampleRate"], bare["channels"]), (16000, 1))
        self.assertEqual(bare["protocol"], 1)
        declared = session_start("Board", DeviceAudio(echo_cancellation=False, speaker="open", microphones=2))
        self.assertEqual(declared["audio"], {"echoCancellation": False, "speaker": "open", "microphones": 2})

    def test_voice_gate_opens_on_sustained_speech_and_rides_through_a_pause(self):
        gate = VoiceGate(threshold=900, open_frames=3, hold_frames=5)
        self.assertFalse(gate.push(2000))
        self.assertFalse(gate.push(2000))
        self.assertTrue(gate.push(2000))
        for _ in range(4):
            self.assertTrue(gate.push(10))  # a short pause between words
        self.assertFalse(gate.push(10))
        # One loud click is not speech.
        self.assertFalse(VoiceGate(open_frames=3).push(30000))

    def test_interruption_guard_needs_recent_speech(self):
        guard = InterruptionGuard(threshold=900, frames=3, window_seconds=0.6)
        self.assertFalse(guard.confirmed(now=10.0))
        for step in range(3):
            guard.observe(3000, now=10.0 + step * 0.02)
        self.assertTrue(guard.confirmed(now=10.3))
        self.assertFalse(guard.confirmed(now=11.0))


class ScriptedRelay:
    """A stand-in relay: says what a real one says, records what it is sent."""

    def __init__(self, plan=None, on_started=None, drop_first=False, refuse=None, reason="refused"):
        self.plan = plan or {"wakeGate": "relay", "silenceFill": False, "bargeIn": "relay"}
        self.on_started = on_started
        self.drop_first = drop_first
        self.refuse = refuse  # a close code: turn every session away with it
        self.reason = reason  # the close reason that goes with it, as a real relay sends
        self.starts = []
        self.audio_started = 0
        self.frames = 0
        self.connections = 0

    async def __aenter__(self):
        self.server = await websockets.serve(self._serve, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()

    async def _serve(self, socket, *_):
        self.connections += 1
        first = self.drop_first and self.connections == 1
        async for message in socket:
            if isinstance(message, bytes):
                self.frames += 1
                continue
            event = json.loads(message)
            if event["type"] == "session.start":
                self.starts.append(event)
                if self.refuse is not None:
                    # As a real relay does: say why in an error event, then close.
                    await socket.send(json.dumps({"type": "error", "message": "refused"}))
                    await socket.close(code=self.refuse, reason=self.reason)
                    return
                await socket.send(json.dumps({"type": "session.started", "provider": "test", "audio": self.plan}))
                if first:
                    await socket.close(code=1011)  # the link drops mid-session
                    return
            if event["type"] == "audio.start":
                self.audio_started += 1
                if self.on_started:
                    asyncio.ensure_future(self.on_started(socket))


class Sessions(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.wav = os.path.join(self.directory.name, "speech.wav")
        write_wav(self.wav, tone(1.0))

    def tearDown(self):
        self.directory.cleanup()

    def device(self, relay, audio=None, tail=1.0, **settings):
        options = dict(relay=f"ws://127.0.0.1:{relay.port}/agent", audio=audio or DeviceAudio(), verbose=False)
        mic = WavMic(self.wav, tail_seconds=tail)
        return Device(Settings(**{**options, **settings}), mic, WavSpeaker(None)), mic

    async def run_for(self, device, seconds):
        try:
            await asyncio.wait_for(device.run(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def test_captures_the_microphone_and_plays_the_reply(self):
        async def reply(socket):
            await socket.send(bytes(4800))  # 100 ms of the assistant's voice
            await socket.send(bytes(4800))

        async with ScriptedRelay(on_started=reply) as relay:
            device, _ = self.device(relay)
            await self.run_for(device, 1.6)
            self.assertEqual(relay.starts[0]["sampleRate"], 16000)
            self.assertEqual(relay.audio_started, 1)
            # One second of speech is fifty 20 ms frames; then the open mic's quiet.
            self.assertGreaterEqual(relay.frames, 50)
            self.assertEqual(device.speaker.bytes_played, 9600)
            self.assertEqual(device.plan["bargeIn"], "relay")

    async def test_an_interruption_cuts_the_reply(self):
        async def hear(socket):
            await asyncio.sleep(0.3)
            await socket.send(json.dumps({"type": "status", "state": "hearing", "detail": ""}))

        async with ScriptedRelay(on_started=hear) as relay:
            device, _ = self.device(relay)
            await self.run_for(device, 0.8)
            self.assertEqual(device.speaker.flushes, 1)

    async def test_a_device_with_echo_only_cuts_the_reply_when_its_own_mic_agrees(self):
        plan = {"wakeGate": "relay", "silenceFill": False, "bargeIn": "confirm"}

        async def hear_twice(socket):
            await asyncio.sleep(0.3)  # the wearer is talking (the tone)
            await socket.send(json.dumps({"type": "status", "state": "hearing", "detail": ""}))
            await asyncio.sleep(1.6)  # the file is over; the mic is quiet
            await socket.send(json.dumps({"type": "status", "state": "hearing", "detail": ""}))

        async with ScriptedRelay(plan=plan, on_started=hear_twice) as relay:
            audio = DeviceAudio(echo_cancellation=False, speaker="open")
            device, _ = self.device(relay, audio=audio, tail=3.0)
            await self.run_for(device, 2.6)
            self.assertEqual(relay.starts[0]["audio"], {"echoCancellation": False, "speaker": "open"})
            # Confirmed once (speech), ignored once (silence: the relay heard the speaker).
            self.assertEqual(device.speaker.flushes, 1)

    async def test_a_cut_the_relay_makes_itself_needs_no_confirmation(self):
        plan = {"wakeGate": "relay", "silenceFill": False, "bargeIn": "confirm"}

        async def cut_while_quiet(socket):
            await asyncio.sleep(1.9)  # the file is over and the mic has been quiet for most of a second
            await socket.send(json.dumps({"type": "status", "state": "hearing", "detail": "", "cause": "relay"}))

        async with ScriptedRelay(plan=plan, on_started=cut_while_quiet) as relay:
            audio = DeviceAudio(echo_cancellation=False, speaker="open")
            device, _ = self.device(relay, audio=audio, tail=3.0)
            await self.run_for(device, 2.6)
            # A guardrail stop or an announcement: the reply is cut although nobody spoke.
            self.assertEqual(device.speaker.flushes, 1)

    async def test_a_voice_gated_device_sends_speech_only(self):
        async with ScriptedRelay() as relay:
            device, _ = self.device(relay, audio=DeviceAudio(voice_gate=True), tail=2.0)
            await self.run_for(device, 2.8)
            # About fifty frames of speech and a short hold, not the 140 an open mic sends.
            self.assertGreater(relay.frames, 40)
            self.assertLess(relay.frames, 95)

    async def test_reconnects_after_a_dropped_link_and_starts_the_session_again(self):
        original = max_device.backoff_seconds
        max_device.backoff_seconds = lambda attempt: 0.05
        try:
            async with ScriptedRelay(drop_first=True) as relay:
                device, _ = self.device(relay, tail=3.0)
                await self.run_for(device, 1.2)
                self.assertEqual(relay.connections, 2)
                self.assertEqual(len(relay.starts), 2)  # session.start is sent again
                self.assertEqual(relay.audio_started, 1)  # audio flows on the second link
                self.assertGreater(relay.frames, 10)
                self.assertGreaterEqual(device.speaker.flushes, 1)  # nothing half-said survives
        finally:
            max_device.backoff_seconds = original

    async def test_stops_instead_of_reconnecting_when_the_voice_minutes_are_used_up(self):
        # The relay answers every new connection this way until the minutes are restored, so
        # a reconnect would only be refused again.
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            async with ScriptedRelay(refuse=4003, reason="usage limit reached") as relay:
                device, _ = self.device(relay, verbose=True)
                await asyncio.wait_for(device.run(), 2.0)  # it returns instead of looping
        self.assertEqual(relay.connections, 1)
        self.assertIn("voice minutes used up (usage limit reached)", said.getvalue())
        self.assertIn("This client is not reconnecting: start it again once it has", said.getvalue())

    async def test_stops_instead_of_retrying_credentials_the_relay_refused(self):
        # The relay's reason is quoted as it stands: only the relay knows
        # whether the session expired, the account was deleted or a key rotated.
        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            async with ScriptedRelay(refuse=1008, reason="session expired") as relay:
                device, _ = self.device(relay, verbose=True)
                await asyncio.wait_for(device.run(), 2.0)
        self.assertEqual(relay.connections, 1)
        self.assertIn("the relay refused this device's credentials: session expired", said.getvalue())
        self.assertIn("so this client is not retrying", said.getvalue())

    async def test_keeps_retrying_a_refusal_that_may_clear(self):
        # 1013 asks to be tried again later. Only 4003 and 1008 are final.
        original = max_device.backoff_seconds
        max_device.backoff_seconds = lambda attempt: 0.05
        try:
            async with ScriptedRelay(refuse=1013) as relay:
                device, _ = self.device(relay, tail=3.0)
                await self.run_for(device, 0.5)
                self.assertGreaterEqual(relay.connections, 3)  # it keeps coming back
        finally:
            max_device.backoff_seconds = original


if __name__ == "__main__":
    unittest.main()
