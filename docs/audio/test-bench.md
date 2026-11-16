# The audio test bench

A way to find out whether a device's microphone, speaker and audio chip are
good enough for a voice assistant, with numbers, before deciding the software
is at fault.

```bash
npm run bench:audio -- generate --out bench
npm run bench:audio -- score --dir bench
```

It measures three things:

| Score            | Question it answers                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Speech detection | When the wearer starts talking in noise, is it noticed, how late, and how often is noise alone mistaken for talking?   |
| Recognition      | Is what the wearer said understood?                                                                                    |
| Echo             | When the assistant talks, how much of it comes back into the microphone, and does the assistant then interrupt itself? |

## What it uses, and what that means

**The speech is synthesised.** `generate` uses the system voice (`say` on
macOS, plus `ffmpeg`) to speak five short commands, three in English and two
in Chinese. A synthetic voice is cleaner and more regular than a person in a
helmet. Pass `--speech DIR` with your own recordings named `en-weather.wav`,
`en-navigate.wav`, `en-call.wav`, `zh-weather.wav`, `zh-navigate.wav` to use
real voices; the words must match the built-in lines.

**The noise is synthesised too.** Wind, engine and street are generated from
a formula, not recorded on a road. Each has the trait that makes the real
thing hard: wind is almost all low rumble arriving in gusts, engine is a
harmonic drone that wanders with the revs, street is hiss with passing
vehicles and horns. They are the same on every machine, which is what makes
two results comparable. They are not what your device will meet on a real
road. Pass `--noise DIR` with `wind.wav`, `engine.wav` and `street.wav`
(16 kHz, mono, 16-bit, at least 20 seconds) to use recordings made at your
own microphone.

**Speech detection is the relay's own detector.** That is the one used with
the Whisper pipeline and local model backends. The realtime backends (Doubao,
OpenAI Realtime, Grok, Gemini Live) use their vendor's detector, which cannot
be run offline, so this score does not describe them.

**The limits are rules of thumb.** "Good", "usable" and "poor" come from
`LIMITS` in `scripts/audio-bench/score.ts`. They are starting points chosen by
us, not an industry standard.

## Step 1: the software baseline

```bash
npm run bench:audio -- generate --out bench
npm run bench:audio -- score --dir bench
```

`generate` writes 65 recordings: every command clean, and in each noise at
20, 10, 5 and 0 dB (speech louder than noise by that much). Each file has two
seconds of noise alone, then the command, then a second and a half more
noise. `manifest.json` records what was said and exactly when.

Scoring the generated files tells you what the software does with a perfect
microphone. On the baseline we measured:

| Condition                   | Detected | Onset delay | False starts |
| --------------------------- | -------- | ----------- | ------------ |
| Clean                       | 5 of 5   | 80 ms       | 0            |
| Wind, 20 dB                 | 5 of 5   | 80 ms       | 0            |
| Street, 20 dB               | 4 of 5   | 80 ms       | 1            |
| Engine, 20 dB               | 2 of 5   | 80 ms       | 3            |
| Any noise at 10 dB or worse | 0 of 5   | —           | 5            |

Read the last row carefully: **the relay's built-in detector is a simple
loudness detector, and steady noise 10 dB or less below the voice trips it
before anyone speaks.** A "false start" followed by "not detected" means the
detector was already open on the noise when the speech arrived. On a device
that will be used in noise, either clean the signal on the device before it
is sent, or use a realtime backend with its own detector.

## Step 2: your hardware

1. Put the device where it will be worn: on a head form, in a helmet, on a
   pair of glasses.
2. Play each recording from `bench/` through a loudspeaker about where the
   wearer's mouth would be, at speaking level.
3. Record the device's microphone **after** its own processing, as 16 kHz
   mono 16-bit WAV, one file per recording, with the same file names, into
   another folder.
4. Score the captures against the originals:

```bash
npm run bench:audio -- score --dir bench --captured captures
```

Start each capture when playback starts, so the timings in `manifest.json`
still hold. A capture that starts late shifts every onset delay by that much.

Compare with step 1. If your captures score worse than the generated files in
the clean condition, the problem is the microphone path: level, placement or
clipping. If they score better in noise, your device's noise handling is
earning its place.

This plays noise and speech from one loudspeaker, so a beamformer sees them
arrive from the same direction and cannot separate them. For a multi-microphone
device, play the noise from a second loudspeaker to the side instead.

## Step 3: recognition

Recognition needs a speech-to-text server, any that speaks the OpenAI
`/audio/transcriptions` API. Use the one your relay uses:

```bash
BENCH_STT_BASE_URL=http://localhost:8000/v1 \
BENCH_STT_MODEL=Systran/faster-whisper-small \
npm run bench:audio -- score --dir bench --captured captures
```

`BENCH_STT_API_KEY` is sent as a bearer token when set. Each recording is
uploaded to that server, so point it at one you are content to send test
audio to.

The error rate is the share of words (characters, for Chinese) that came out
wrong, missing or invented. Without `BENCH_STT_BASE_URL` this column reads
"not measured".

## Step 4: echo

`generate` also writes `assistant-reference.wav`: the assistant talking for
about ten seconds.

1. Play it through **the device's own speaker**, at the loudest volume a
   wearer would use, with nobody speaking.
2. Record the device's microphone after its processing. That is the echo.
3. If the device can switch its echo canceller off, record again with it off.
4. Optionally record someone speaking a command with the speaker silent.

```bash
npm run bench:audio -- echo --echo echo.wav --raw echo-no-aec.wav --speech voice.wav
```

| Line                         | Meaning                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Echo at the microphone       | How loud the leftover echo is. Lower is better.                                                                               |
| Mistaken for the wearer      | How many times the relay's detector took the echo for speech. **Anything above 0 means the assistant will interrupt itself.** |
| Removed by echo cancellation | The difference between the two recordings. Needs `--raw`.                                                                     |
| Wearer's voice over the echo | How far a real voice stands above the echo. Needs `--speech`.                                                                 |

If the echo is mistaken for the wearer and the device cannot cancel it,
declare `echoCancellation: false` in the [audio contract](contract.md). The
relay then asks the device to confirm interruptions with its own microphone.

## Through a live relay

The bench scores recordings offline. To hear what a whole session does with
one, send it through a running relay with the reference client:

```bash
python3 examples/device-client/max_device.py \
  --relay ws://localhost:8787/agent \
  --play bench/en-weather_wind_10db.wav --record reply.wav
```

The transcript of what the relay heard is printed, and the assistant's reply
is saved to `reply.wav`.

## What the bench does not tell you

- How the device behaves at speed, in real wind, on a real engine.
- Anything about a realtime backend's speech detection.
- Whether a person is understood: the speech is synthetic unless you supply
  your own.
- Comfort, latency as the wearer feels it, or battery life.
