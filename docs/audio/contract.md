# The audio contract

One page: what the relay expects from a device, what it sends back, and how a
device says what its own hardware already does.

It applies to anything that speaks to the relay's `/agent` WebSocket: a board,
a phone app, a browser. The reference implementation is
[`examples/device-client/max_device.py`](../../examples/device-client/max_device.py).

## What the device sends

|                       |                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                | PCM, 16-bit signed, little-endian, **mono, 16 kHz**                                                                                         |
| Framing               | Binary WebSocket messages. **20 ms per message (640 bytes)** is what every Max client sends. A message over 32 KB is refused.               |
| Order                 | `session.start` (JSON) → wait for `session.started` → `audio.start` (JSON) → audio frames. Audio sent before `session.started` is an error. |
| Rate declared         | `session.start` must carry `"sampleRate": 16000, "channels": 1`. Anything else is refused: resample on the device.                          |
| Pace                  | Send each frame as it is captured. Do not batch several frames into one burst; the speech detectors behind the relay work in real time.     |
| When the link is slow | Drop frames rather than queue them. A microphone that falls behind real time is worse than one with a gap.                                  |

### Level

The relay does not adjust the microphone level, and it has no automatic gain.

- Aim for speech peaking between about -12 and -6 dBFS, and never clipping.
  This is a working target, not a measured limit.
- The relay's own speech detector (used with the Whisper pipeline and local
  model backends) filters out low rumble, then treats a frame as speech when
  its RMS is above 450 (about -37 dBFS) **and** above two and a half times
  the background level. Speech quieter than that is not heard at all. It
  listens for the first 300 ms of a stream before it will open a turn.
- The realtime backends (Doubao, OpenAI Realtime, Grok, Gemini Live) use their
  vendor's detector instead. Its thresholds are not ours to state.

### What the relay does not do for you

The relay passes microphone audio to the voice backend untouched. It does
**not** cancel echo, suppress noise, control gain, or resample. If the device
does none of those, nothing does. Echo cancellation in particular has to
happen on the device, because only the device has the speaker signal.

## What the device receives

|           |                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Voice     | Binary WebSocket messages: PCM, 16-bit signed, little-endian, **mono, 24 kHz**. Play them in order, back to back.                                                                                            |
| Events    | JSON text messages. The ones a device must handle are below.                                                                                                                                                 |
| Buffering | Keep the playback buffer short. A long buffer makes interruption feel late and puts the echo outside an echo canceller's reach. The RDK board client keeps 80 ms queued ahead of a 120 ms sound-card buffer. |

Events that matter for audio:

| Event                                 | What to do                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `session.started`                     | The relay is ready. Read `audio` (the plan, below), then send `audio.start`.                                 |
| `status` with `state: "hearing"`      | The wearer started speaking. Stop playing the assistant: drop everything not yet played. See "Interruption". |
| `hazard.alert` with `interrupt: true` | A safety alert. Stop the assistant at once, unconditionally.                                                 |
| `transcript`                          | What was heard and said, for a display or a log.                                                             |
| `error`                               | Log it.                                                                                                      |

## Saying what the device already does

Add an `audio` object to `session.start`. Every field is optional. **Leave out
what you do not know**: a missing field means "unknown", and the relay then
behaves exactly as it does for a device that says nothing.

```json
{
  "type": "session.start",
  "sampleRate": 16000,
  "channels": 1,
  "audio": {
    "echoCancellation": true,
    "noiseSuppression": true,
    "autoGainControl": false,
    "voiceGate": false,
    "wakeWord": false,
    "microphones": 2,
    "speaker": "open"
  }
}
```

| Field              | Say `true` when                                                                                | What the relay does                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `echoCancellation` | The device removes its own speaker from the microphone signal.                                 | With `false` and a speaker the microphone can hear, the relay asks the device to confirm interruptions (see below). |
| `noiseSuppression` | A DSP, beamformer or "ENC" cleans background noise.                                            | Recorded in the relay's log. Nothing changes today: the relay has no noise stage to skip.                           |
| `autoGainControl`  | The device levels the microphone gain.                                                         | Recorded. Nothing changes today.                                                                                    |
| `voiceGate`        | The device stops sending audio when nobody is speaking.                                        | The relay supplies the missing silence, so a turn still ends.                                                       |
| `wakeWord`         | The device spots the wake word itself and sends only speech meant for the assistant.           | The relay skips its own check for the assistant's name.                                                             |
| `microphones`      | — (a number, 1 to 16)                                                                          | Recorded.                                                                                                           |
| `speaker`          | — one of `sealed` (in or over the ear), `open` (near the ear, unsealed), `bone`, `loudspeaker` | Used with `echoCancellation` to decide about interruptions.                                                         |

A declaration the relay does not understand is ignored field by field; it
never refuses the connection.

### The relay's answer

`session.started` carries the plan the relay made:

```json
{ "type": "session.started", "audio": { "wakeGate": "device", "silenceFill": true, "bargeIn": "confirm" } }
```

| Field         | Values                   | Meaning                                                                                                    |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `wakeGate`    | `relay`, `device`, `off` | Who checks that the wearer said the assistant's name. `off`: the relay's wake word is disabled altogether. |
| `silenceFill` | `true`, `false`          | The relay adds silence after the device's last frame (120 ms after it, for up to 1.6 s).                   |
| `bargeIn`     | `relay`, `confirm`       | `confirm`: do not cut the assistant on `hearing` alone. See below.                                         |

A relay older than this contract sends no `audio` field. Treat that as
`wakeGate: "relay"`, `silenceFill: false`, `bargeIn: "relay"`.

## Interruption

The speech detectors behind the relay listen to the device's microphone. If
the device's speaker reaches its microphone and nothing cancels it, they hear
the assistant and report the wearer as speaking. Acting on that makes the
assistant cut itself off, and can loop.

- `bargeIn: "relay"`: on `status: hearing`, stop playback immediately.
- `bargeIn: "confirm"`: on `status: hearing`, stop playback only if the
  device's own microphone was loud at about the same moment. The reference
  client uses three consecutive 20 ms frames above its speech threshold,
  within 0.6 s, and waits up to 0.3 s for them.

The relay sets `confirm` when a device declares `echoCancellation: false` and
its speaker is anything but `sealed`.

## Reconnecting

- Back off: 1, 2, 4, 8, 16, then 30 seconds between attempts.
- A new connection is a new session: send `session.start` again, wait for
  `session.started`, send `audio.start` again.
- Close code **4001** means the relay closed a session nobody was talking in.
  Do not reconnect at once. Wait until the microphone hears something.
- Drop any audio not yet played when the link drops.
- Answer the relay's WebSocket pings, and send your own: a dead mobile link
  often delivers no close at all.

## Signing in

A relay with accounts or a relay token refuses the WebSocket without a
credential. Pass it as `?token=…` on the `/agent` address.

## What Max's own clients do

So you can compare your device with ones that work. "Platform" means the
operating system's voice processing, not ours.

|                          | Web                                        | iOS                                | Android                                                   | RDK X5 board                                                |
| ------------------------ | ------------------------------------------ | ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Capture                  | Browser, resampled to 16 kHz in a worklet  | AVAudioEngine, converted to 16 kHz | AudioRecord at 16 kHz, voice-communication source         | ALSA at 48 kHz, decimated to 16 kHz                         |
| Frames                   | 20 ms                                      | 20 ms                              | 20 ms                                                     | 20 ms                                                       |
| Echo cancellation        | Platform (`echoCancellation`)              | Platform (voice-processing I/O)    | Platform (`AcousticEchoCanceler`, when the phone has one) | WebRTC audio processing, fed the played signal as reference |
| Noise suppression        | Platform                                   | Platform (implied by voice mode)   | Platform (`NoiseSuppressor`)                              | WebRTC, high                                                |
| Gain control             | Platform                                   | Platform (implied)                 | Not enabled                                               | WebRTC, adaptive digital                                    |
| Stops sending in silence | No                                         | No                                 | No                                                        | No                                                          |
| Wake word on the device  | No                                         | No                                 | No                                                        | No                                                          |
| Cuts the reply on        | `hearing`, or any transcript of the wearer | same                               | same                                                      | `hearing`, confirmed by its own microphone                  |
| Declares `audio`         | Yes: what the browser reports              | Not yet                            | Not yet                                                   | Not yet                                                     |
