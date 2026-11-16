# Audio integration guide

How to put a Max voice assistant on your own hardware: what to send the
relay, how to tell it what your chip already does, an example client to start
from, and a way to measure whether the hardware is good enough.

|                                                                   |                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [The audio contract](contract.md)                                 | One page. The format the relay expects, what it sends back, and the `audio` declaration.  |
| [Reference device client](../../examples/device-client/README.md) | A small Python client for a Linux board: capture, playback, interruption, reconnect.      |
| [Test bench](test-bench.md)                                       | Speech in wind, engine and street noise, with scores for detection, recognition and echo. |
| [Hardware guide](hardware.md)                                     | Microphones, speakers, audio chips, and how each connects to the kit.                     |

## The shape of it

```
 microphone(s) ─► device processing ─► 16 kHz PCM ─► relay ─► voice backend
                  (echo, noise, gain,                 │
                   speech, wake word)                 │
 speaker ◄────────────────────── 24 kHz PCM ◄─────────┘
```

Everything to the left of the relay is the device's job. **The relay does not
clean audio**: it does not cancel echo, suppress noise, or adjust gain. It
forwards what it is sent. So the questions for a hardware builder are which
of those jobs the device does, and whether it does them well enough.

## What you have to provide, and what you do not

|                                    | Who does it                                         | Notes                                                                                         |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Speech recognition (ASR)           | The relay's voice backend                           | Any of the supported backends, including local Whisper. Nothing to build.                     |
| Speech detection (VAD)             | The backend, or the relay for the pipeline backends | A device may also do it and send speech only: declare `voiceGate`.                            |
| Wake word                          | The relay, from the transcript                      | A device may do it on the chip instead: declare `wakeWord`.                                   |
| Echo cancellation (AEC)            | **The device**                                      | Only the device has the speaker signal. Phones and browsers supply it; a bare board does not. |
| Microphone noise suppression (ENC) | **The device**, optionally                          | A DSP, a beamformer, or close microphone placement.                                           |
| Gain control (AGC)                 | **The device**, optionally                          | The relay does not level the signal.                                                          |
| Noise cancelling for the ear (ANC) | The headset's own chip                              | Acoustics and dedicated hardware. Nothing in the kit touches it.                              |
| TURN, WebRTC                       | Not used                                            | Devices reach the relay over a WebSocket on the ordinary HTTPS port.                          |

## Quick start

1. **Read the [contract](contract.md).** It is one page.
2. **Run the reference client** against your relay, first from a file, then
   from the sound card:

   ```bash
   pip install -r examples/device-client/requirements.txt
   python3 examples/device-client/max_device.py --relay wss://your-relay/agent --token …
   ```

3. **Declare what your hardware does.** Only what is true:

   ```bash
   python3 examples/device-client/max_device.py --aec yes --ns yes --microphones 2 --speaker open
   ```

   The client prints the plan the relay answers with.

4. **Measure.** Generate the [test bench](test-bench.md) recordings, play
   them at your device, and score what its microphone captured.
5. **Choose parts** with the [hardware guide](hardware.md) open.

## What the declaration changes today

| The device declares                                               | The relay                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `wakeWord: true`                                                  | Skips its own check for the assistant's name.                              |
| `voiceGate: true`                                                 | Adds the silence the device leaves out, so turns still end.                |
| `echoCancellation: false`, with a speaker the microphone can hear | Asks the device to confirm an interruption with its own microphone.        |
| `noiseSuppression`, `autoGainControl`, `microphones`              | Recorded in the log. Nothing changes: the relay has no such stage to skip. |
| Nothing                                                           | Behaves exactly as before the contract existed.                            |

## Known limits

- The relay's built-in speech detector is a loudness detector. It ignores
  steady noise and holds up in wind, but it does not find a voice that is
  less than about 10 dB above engine or street noise. The
  [test bench](test-bench.md) shows where it stops. A device for loud places
  should clean its signal first or use a realtime backend.
- The iOS, Android and RDK clients do not send a declaration yet. The web
  client sends what the browser reports.
- There is no reference firmware for a microcontroller. The Python client is
  the pattern to port.
- The bench's speech and noise are synthesised unless you supply recordings.
