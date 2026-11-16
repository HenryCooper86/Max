# Reference device client

A small client for the Max relay, written to be read and copied. It runs on a
Raspberry Pi or any Linux board with a sound card, and on a laptop for trying
things out.

[`max_device.py`](max_device.py) is one file and does the four things every
device has to do:

|                                                                   | Where in the file                         |
| ----------------------------------------------------------------- | ----------------------------------------- |
| **Capture**: microphone → 16 kHz mono, 20 ms frames, to the relay | `SoundCardMic`, `Device._send_microphone` |
| **Playback**: the assistant's 24 kHz voice → the speaker          | `SoundCardSpeaker`, `Device._session`     |
| **Interruption**: stop the assistant when the wearer speaks       | `Device._interrupt`, `InterruptionGuard`  |
| **Reconnect**: come back after a dropped link                     | `Device.run`, `backoff_seconds`           |

The audio rules it follows are in [the audio contract](../../docs/audio/contract.md).

## Run it

```bash
pip install -r requirements.txt

# With a microphone and speaker
python3 max_device.py --relay wss://your-relay.example/agent --token YOUR_TOKEN

# Without a sound card: a WAV file as the microphone, the reply saved to a file
python3 max_device.py --relay ws://localhost:8787/agent --play question.wav --record reply.wav
```

`--play` takes a 16 kHz, mono, 16-bit WAV. Convert anything else with
`ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav`.

A relay with accounts or a relay token needs `--token` (or `MAX_RELAY_TOKEN`).
`MAX_RELAY_URL` sets the address.

On a Raspberry Pi, `sounddevice` needs PortAudio: `sudo apt install libportaudio2`.
List sound devices with `python3 -m sounddevice`, and pick one with
`--input-device` and `--output-device`.

## Say what your hardware does

Declare only what is true. Leave the rest out.

```bash
python3 max_device.py --aec yes --ns yes --microphones 2 --speaker open
```

| Flag                                        | Meaning                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--aec yes\|no`                             | The device cancels its own speaker's echo                                              |
| `--ns yes\|no`                              | It suppresses background noise                                                         |
| `--agc yes\|no`                             | It levels the microphone gain                                                          |
| `--voice-gate yes\|no`                      | It stops sending when nobody speaks. With `yes`, this client gates on loudness itself. |
| `--wake-word yes\|no`                       | It detects the wake word itself                                                        |
| `--microphones N`                           | Number of microphones                                                                  |
| `--speaker sealed\|open\|bone\|loudspeaker` | How the voice reaches the wearer                                                       |

The client prints the relay's answer when the session starts:

```
[relay] session started; audio plan {'wakeGate': 'relay', 'silenceFill': False, 'bargeIn': 'confirm'}
```

These flags only **tell the relay** what the hardware does. They do not make
this client cancel echo or suppress noise: it sends the sound card's signal
as it comes. With `--wake-word yes` it does not listen for a wake word
either; that flag is for hardware that already does.

## What it leaves out

It is a reference, not a product.

- No echo cancellation, noise suppression or gain control of its own.
- No wake word detection.
- Speech detection, where used, is a loudness threshold (`--gate-threshold`).
- No device commands, camera, navigation or hazard handling. The relay's
  other events are received and ignored. The RDK X5 client in
  [`rdk/agent`](../../rdk/agent) is the full-featured one.
- Resampling: it asks the sound card for 16 kHz in and 24 kHz out and relies
  on the system to convert.

## Tests

```bash
python3 -m unittest -v test_max_device
```

The session tests run the client against a small scripted relay on
localhost, so they cover the real connection code: capture, playback,
interruption with and without confirmation, voice gating, and reconnecting
after a dropped link. They use WAV files, so they need no sound card.

The sound-card classes (`SoundCardMic`, `SoundCardSpeaker`) are not covered by
the tests.
