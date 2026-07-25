# In-Process Acoustic Echo Cancellation — Embedded Client Design

## Summary

Give the helmet client barge-in back. Today the RDK X5 runs the ES8326's hardware
duck (`CROSSTALK=10`), which stops Max hearing himself but suppresses the mic
whenever he speaks — so the rider cannot interrupt him. Barge-in is a shipped
feature on web, iOS and Android; embedded is the only client without it.

A small C++ helper, `max-aec`, replaces `arecord` in the capture chain. It owns
the microphone, receives the far-end reference on a pipe, and runs the WebRTC
Audio Processing Module — echo cancellation, noise suppression and gain control —
emitting the same 16 kHz 320-sample frames the agent already sends upstream.

This is ladder step 2 from
`docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`. Step 1
(`module-echo-cancel`) was tried on hardware and does not work; step 3 (the
hardware duck) is what we are running now and what this replaces.

**The evidence this exists to fix.** With the duck disabled and no canceller, a
live Doubao session produced a closed loop — Doubao's ASR transcribed Max's own
replies as rider speech and he answered himself:

```
agent: 今天晴间多云，气温大概25度…
rider: 今天晴间多云。            ← Max's own reply, read back as the rider
agent: 对的，今天晴间多云…
rider: 对的，今天晴间多。
```

Those fake turns also reach QA transcripts and per-user memory. Full field notes
in `rdk/README.md` under "AEC".

## Scope

### Goals

- Restore barge-in on the embedded client without the echo loop.
- Noise suppression and gain control on the uplink — wanted regardless at speed.
- Offline, deterministic verification that does not need a headset or a live
  conversation.
- Graceful degradation to today's working half-duplex behaviour on any failure.

### Non-goals

- **AGC/NS tuning for wind noise.** Needs real ride recordings; defaults only.
- **`module-echo-cancel`.** Disproven on this board.
- **Making the PulseAudio card release permanent.** Related, separate work.
- **Changing web/iOS/Android.** They have working platform AEC already.
- **Auto-switching between AEC and half-duplex mid-session.** See "Failure
  posture" for why.

## Hardware and library baseline

Verified on the board 2026-07-25/26.

| Element     | Status                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| Toolchain   | `gcc`, `g++`, `make`, `cmake`, `pkg-config` all present                 |
| APM runtime | `libwebrtc_audio_processing.so.1` **already installed**                 |
| APM headers | `libwebrtc-audio-processing-dev` 0.3.1-0ubuntu5, one `apt install` away |
| Codec       | ES8326, single duplex card — capture and playback share one clock       |
| Node        | v22.23.1, agent runs under `tsx` as a systemd unit                      |

APM 0.3.1 is the classic API — `AudioProcessing::Create()`,
`echo_cancellation()`, `noise_suppression()`, `gain_control()`,
`ProcessReverseStream()`, `ProcessStream()`, `set_stream_delay_ms()` — the same
version PulseAudio's `module-echo-cancel` builds on.

## Architecture

```text
relay ──24 kHz PCM16──► playback.ts
                          ×2 upsample → 48 kHz
                          soft limiter          ← reference tapped HERE
                          ├──────────────────► aplay → speaker
                          └──48 kHz reference──┐
                                               ▼
  mic ──ALSA 48 kHz──► max-aec ── APM: AEC + NS + AGC ──► 16 kHz 320-smp frames ──► relay
                        (owns capture, ÷3 to 16 kHz internally)
```

### The reference is tapped after the soft limiter

An echo canceller models the echo path as **linear** — it learns a filter from
reference to echo. Our soft limiter is deliberately **non-linear** (a tanh knee
above threshold). Tapping the 24 kHz stream as it arrives from the relay would
leave everything the limiter does as unmodellable residue, and cancellation
would degrade exactly when Max is loudest — which is exactly when the rider most
needs to interrupt.

So the reference is the post-limiter 48 kHz signal: literally the samples handed
to the DAC.

### APM runs at 16 kHz

It is the uplink rate, so nothing extra is converted on the path we actually
send, and it is the cheapest of APM's supported rates on the A55s. `max-aec`
decimates both mic and reference 48 → 16 kHz with the **same** FIR already in
`rdk/agent/src/audio/dsp.ts`. A mismatch between the two legs would itself
present as echo.

Frame arithmetic is exact: APM processes 10 ms frames (160 samples at 16 kHz),
and the uplink frame is 320 samples (20 ms) — precisely 2 APM frames. No
repacketisation.

### Units

- **`max-aec`** (C++) — owns ALSA capture, reads reference frames from a pipe,
  runs APM, writes 16 kHz 320-sample PCM16 to stdout. Testable standalone from
  WAV files.
- **`capture.ts`** — spawns `max-aec` instead of `arecord`; identical output
  contract. Gains the reference pipe.
- **`playback.ts`** — after the limiter, forks each 48 kHz block to the reference
  pipe. `flush()` gains reference-drop and reset responsibilities.
- **`mixer.ts`** (new, small) — sets `CROSSTALK` to match the AEC state at
  startup.

### The coupling this introduces

Playback and capture are independent today; this joins them. That is inherent —
an echo canceller needs both signals — and pretending otherwise is what the
PulseAudio virtual-sink routing attempted, badly. Naming it here so it is a
chosen cost rather than an accident: **`playback.flush()` stops being a local
concern and becomes part of the AEC contract.**

## Delay alignment

APM needs `set_stream_delay_ms()`: the time between handing it a reference frame
and that audio arriving back in the mic. A wrong value means the filter adapts to
the wrong lag and cancels nothing.

Budget: reference queue + `aplay`'s ALSA buffer (capped near 120 ms, see
`BUFFER_FRAMES` in `playback.ts`) + ES8326 latency + acoustic flight (~1 ms in a
helmet). Low hundreds of milliseconds — **measured on the bench, not assumed.**

Three mechanisms together:

1. **`MAX_AEC_DELAY_MS`** — config value seeded from a bench measurement (play a
   click, locate it in the capture, compute the offset).
2. **`DelayAgnostic` and `ExtendedFilter` enabled** — APM adapts around a wrong
   baseline rather than failing outright.
3. **Log APM's own `stream_delay_ms()` estimate** — so the configured value is
   checked against reality instead of trusted.

**One thing works strongly in our favour.** Capture and playback are the same
duplex codec on one clock, so sample-rate drift between mic and speaker — the
other classic destroyer of echo cancellers — cannot occur. The single-device
design that made raw ALSA awkward is a real asset here.

### The barge-in trap

`flush()` SIGKILLs `aplay` to cut Max off. The reference queue then holds audio
that **will never be played**. Feeding it to APM makes it subtract a phantom
echo from the mic, damaging the rider's speech at the precise moment they are
interrupting — the feature would half-work in the worst possible way: barge-in
cuts the audio, then mangles what the rider says next.

Therefore **`flush()` drops pending reference and signals `max-aec` to reset APM
in the same operation.** Playback flush and reference flush are atomic, not two
steps.

## Failure posture

### The agent owns the mixer

`CROSSTALK` and the AEC state must never disagree — a board left at `0` with AEC
off is exactly the echo loop above. The agent sets it explicitly at startup:

| Agent state                 | `CROSSTALK1`/`CROSSTALK2`          |
| --------------------------- | ---------------------------------- |
| AEC active                  | 0 — duck off, canceller handles it |
| AEC unavailable or disabled | 10 — hardware duck, half duplex    |

No reliance on `alsactl` state surviving a reboot, and no stale mixer setting
turning into a mystery later. Two settings, one decision.

### Degradation

If `max-aec` will not start — missing binary, ALSA busy, library absent — the
agent falls back to `arecord` plus the hardware duck and logs it loudly. That is
exactly today's working behaviour: no barge-in, no loop, usable helmet. A voice
assistant that refuses to talk because its echo canceller is missing is worse
than one that talks half-duplex.

`MAX_AEC_MODE=apm|off` makes this switchable without a rebuild, which also gives
a clean A/B on the bench.

**No AEC failure may crash the agent.** The EPIPE crash fixed in `c246462` is the
precedent: the helper's pipes get the same error guards as `aplay` and
`arecord`, and a dead helper means falling back, not dying.

**No auto-switching mid-session.** Poor cancellation is logged (APM exposes
ERLE), not acted on. A rider whose barge-in works for ten minutes and then
silently stops is worse off than one who knows it never works; unpredictable
safety behaviour is its own hazard.

## Verification

### Offline ERLE harness — the centrepiece

Feed `max-aec` two synthetic WAVs: a reference signal, and a "mic" track built as
`delayed·attenuated(reference) + clean speech`. Measure how much echo was
removed, in dB. Deterministic, no board, no headset, no live conversation, runs
in CI. Sweeping the delay parameter finds where cancellation collapses and
validates the `MAX_AEC_DELAY_MS` budget.

This directly answers how the previous spike failed: an RMS ratio that _looked_
healthy while the real behaviour was broken. ERLE against known ground truth
cannot flatter itself the same way, because the harness controls exactly what
echo went in.

### Automated echo-loop detector

The failure has a distinctive signature: a `rider` turn that is a prefix of the
previous `agent` turn. That is mechanically checkable over recorded transcripts,
so the regression is caught by a test rather than by a human reading a transcript
and noticing. This bug reached a live rider once; it must not depend on
attention again.

### Unit tests

Reference-queue bookkeeping; that `flush()` drops pending reference **and**
signals reset; frame packing (320 samples = 2 APM frames); identical decimation
on both legs; mixer state matching AEC state; failure paths falling back rather
than throwing.

### Bench, on the board

Measured delay figure; real ERLE with the headset; CPU and thermal headroom —
the board idles at 71 °C and APM at 16 kHz plus two decimations is not free.

### Acceptance

**A live conversation, and only that:** Max does not answer himself, **and**
barge-in still cuts him off mid-sentence — both, in one session. The 2026-07-25
session proved that half of this passing means nothing.

## Acceptance criteria

- Barge-in cuts Max off mid-sentence on the embedded client.
- Max does not transcribe or answer his own speech in a live session.
- Offline ERLE harness runs in CI and reports suppression in dB.
- The echo-loop detector fails on a recorded looping transcript and passes on a
  clean one.
- `max-aec` failure degrades to `arecord` + `CROSSTALK=10`, never a crash.
- `CROSSTALK` always matches the AEC state, set by the agent at startup.
- `npm run check` passes; web, iOS and Android are untouched.

## Follow-on

1. **AGC/NS tuning against real ride recordings** — defaults only in v1.
2. **Permanent PulseAudio card release**, so a desktop session restart cannot
   take the mic from the agent.
3. **Report the `module-echo-cancel` suspended-sink failure upstream**, with the
   evidence in `rdk/README.md`.
