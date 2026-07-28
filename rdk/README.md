# Max on RDK X5

Embedded client for the Max helmet assistant. See
`docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`.

## Provisioning

```bash
# Node 22 (Ubuntu 22.04 ships Node 12)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs alsa-utils python3-pip
node --version   # expect v22.13+

sudo mkdir -p /var/lib/max/gallery
sudo chown -R "$USER" /var/lib/max
```

`/run/max` is deliberately absent here. `/run` is tmpfs, so anything created by
hand vanishes on the next reboot and `max-vision` then fails to bind
`MAX_VISION_SOCKET`. `max-vision.service` declares `RuntimeDirectory=max`, which
makes systemd create and own the directory on every start.

## Hardware checklist

Record the result of every step in "Bench findings" below.

1. **ALSA devices** — `arecord -l` and `aplay -l`. Note the ES8326B card and
   device numbers; these become `RDK_ALSA_CAPTURE` / `RDK_ALSA_PLAYBACK`.
2. **Headset wiring (CTIA vs OMTP)** — record 5 s and confirm the capture is not
   silent:
   ```bash
   arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 5 /tmp/mic.wav
   python3 -c "import wave,audioop;w=wave.open('/tmp/mic.wav');d=w.readframes(w.getnframes());print('rms',audioop.rms(d,2))"
   ```
   An RMS near 0 with someone speaking means the headset is OMTP-wired and needs
   an adapter.
3. **Loopback** — `aplay -D plughw:0,0 /tmp/mic.wav`. Confirm intelligible.
4. **Echo return loss (the AEC spike)** — play a sweep through the helmet
   speaker while recording the helmet mic, with nobody speaking:
   ```bash
   sox -n /tmp/sweep.wav synth 5 sine 200-8000
   aplay -D plughw:0,0 /tmp/sweep.wav & arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 5 /tmp/echo.wav; wait
   ```
   Compare the RMS of `/tmp/echo.wav` against a silent reference recording. **But
   read "AEC" below before drawing any conclusion from it** — this measurement
   was run, looked healthy, and was still wrong. The only real test is a live
   conversation. Do not bother with `module-echo-cancel`; it was tried and does
   not work on this board.
5. **Cameras** — see "Camera findings" below before touching this. Do **not**
   rely on `open_cam` auto-detect; use the known-good `mipi_cam` command to
   confirm a module streams, and note its VCON index.

## Bench findings

Verified over SSH against the real board on 2026-07-25.

> The board's IP is network-dependent. It was `10.42.0.11` on 2026-07-27; the
> `192.168.50.9` used in commands throughout this file is a stale example. Find
> the current one with `arp -a`, narrow with `nc -G 2 -z <ip> 22`, and confirm
> with `ssh root@<ip> 'ls /usr/hobot'`.

| Item                              | Value                                                                                                                                                                                                                 | Date       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Board                             | `D-Robotics X5 MD V0.2`, Ubuntu 22.04.5, kernel 6.1.83                                                                                                                                                                | 2026-07-25 |
| ALSA capture device               | `plughw:0,0` — card 0 `duplexaudio`, codec **ES8326**                                                                                                                                                                 | 2026-07-25 |
| ALSA playback device              | `plughw:0,0` — same duplex card, one device for both                                                                                                                                                                  | 2026-07-25 |
| Headset wiring (CTIA/OMTP)        | **CTIA, mic works** — −43.6 dBFS ambient, not silence                                                                                                                                                                 | 2026-07-25 |
| Raw echo coupling                 | **+5.5 dB** above the noise floor (`CROSSTALK=0`, DAC 0 dB)                                                                                                                                                           | 2026-07-25 |
| `module-echo-cancel`              | **tried, does not work** — master sink stays SUSPENDED, no audio                                                                                                                                                      | 2026-07-25 |
| AEC path chosen                   | **in-process** — `rdk/aec/max-aec`, WebRTC APM; built and deployed                                                                                                                                                    | 2026-07-26 |
| Reference-to-mic lag              | **81 ms** measured (was 953 ms before playback pacing)                                                                                                                                                                | 2026-07-26 |
| Echo loop                         | **fixed** — confirmed live, headset on, Max replies once and stops                                                                                                                                                    | 2026-07-26 |
| Barge-in                          | **works** — confirmed live, talking over Max cuts his reply                                                                                                                                                           | 2026-07-26 |
| Live Doubao session               | **works** — Max speaks, 1.69 MB voice audio down                                                                                                                                                                      | 2026-07-25 |
| Helmet speaks confirmations       | **built, NOT yet heard** — relay has no `DOUBAO_TTS_*` credentials                                                                                                                                                    | 2026-07-28 |
| Full duplex                       | **works** — simultaneous `arecord` + `aplay`, no device contention                                                                                                                                                    | 2026-07-25 |
| Camera front port index           | **MIPI channel 0** (`vcon@0`/`@1`, i2c bus 6) — the CAM1 connector                                                                                                                                                    | 2026-07-27 |
| Camera rear port index            | **MIPI channel 2** (`vcon@2`/`@3`, i2c bus 4) — the other connector                                                                                                                                                   | 2026-07-27 |
| `mipi_cam` nv12 output            | **works** — `out_format:=nv12`, 3110400 B/frame at 1920×1080                                                                                                                                                          | 2026-07-27 |
| CAM1 live capture                 | **works** — OV5647 ch 0: photo, preview and `.mjpeg` via max-vision                                                                                                                                                   | 2026-07-27 |
| Gallery recording rate            | **9.9 fps** measured (60 frames / 6.05 s), 1920×1080 mjpeg                                                                                                                                                            | 2026-07-27 |
| max-vision restart                | **reacquires** — two consecutive restarts, no orphan, no traceback                                                                                                                                                    | 2026-07-27 |
| ADAS shadow ride                  | **works** — segments + shadow log + one ADAS thread, `MAX_ADAS_SHADOW=1`                                                                                                                                              | 2026-07-27 |
| Shadow ride frame rate            | **9.7 fps** (583 frames in a 60 s segment), 1080p mjpeg                                                                                                                                                               | 2026-07-27 |
| ADAS latency under a ride         | **47.2 ms** p50, 61.7 ms p95 — replay of the ride's own footage                                                                                                                                                       | 2026-07-27 |
| Thermal under a shadow ride       | **~94 °C plateau** (93.8–94.7), **one** camera, bench ambient                                                                                                                                                         | 2026-07-27 |
| Shadow ride disk rate             | **~3 MB/s** — 821 MB for 4.5 min; ~11 GB/hour                                                                                                                                                                         | 2026-07-27 |
| BPU                               | present, idle, 500–1000 MHz; `pyeasy_dnn` + `libsrcampy` OK                                                                                                                                                           | 2026-07-25 |
| Node.js                           | **v22.23.1** installed from NodeSource; npm 10.9.8                                                                                                                                                                    | 2026-07-25 |
| First live session                | **works** — 656 KB mic PCM up, 3 device.result round trips                                                                                                                                                            | 2026-07-25 |
| pytest                            | 6.2.5 on the board; the suite runs there — no local pytest or numpy                                                                                                                                                   | 2026-07-25 |
| BPU detector                      | **yolov5s validated** — anchors checked against `bus.jpg`                                                                                                                                                             | 2026-07-26 |
| ADAS latency                      | **52.4 ms** per frame p50 (19.1 fps single stream)                                                                                                                                                                    | 2026-07-26 |
| ADAS sustained                    | **11.4 fps per camera**, 2 streams, voice live, no throttling                                                                                                                                                         | 2026-07-26 |
| Thermal under ADAS load           | 78.6 °C → **plateau ~90 °C** over 10 min; bench ambient only                                                                                                                                                          | 2026-07-26 |
| Vision consent gate + frame route | **works** — `MAX_VISION_SHARE=0` refuses `/frame/front` with 403; set to `1` it returns 200, a real 640×360 JPEG (26–27 KB, confirmed live over two fetches), gate re-confirmed refusing after restore                | 2026-07-28 |
| Vision describe (live)            | **NOT verified** — relay's `ARK_API_KEY` is invalid (401 "The API key doesn't exist" in two regions, two auth header styles); no working credential exists, so the round trip to the vision model was never attempted | 2026-07-28 |

### AEC — the sweep said "gate passed". A live conversation said otherwise.

> **Read this before changing any audio mixer setting.** The measurement below
> was reproduced faithfully, and its conclusion was still **wrong**.
>
> `CROSSTALK` is no longer set by hand: since 2026-07-26 the agent owns it and
> drops it to 0 when AEC is active, restoring it to 10 when `MAX_AEC_MODE=off`.
> See "In-process AEC" below.

**What actually happened (2026-07-25, live Doubao session, headset on).** With
`CROSSTALK=0` as the sweep recommended, Max heard his own voice through the
helmet speaker, Doubao's ASR transcribed it as rider speech, and he answered
himself in a closed loop:

```
agent: 今天晴间多云，气温大概25度…
rider: 今天晴间多云。            ← Max's own reply, transcribed as the rider
agent: 对的，今天晴间多云…
rider: 对的，今天晴间多。        ← and again
```

Every `rider:` turn is a truncated prefix of Max's previous reply. The 12 s
follow-up window keeps the loop alive without anyone saying "Max" again, so it
runs to the 60 s cap. Worse than cosmetic: those fake turns are written to QA
transcripts and per-user memory as genuine rider speech.

**Why the measurement misled.** An RMS ratio between a sweep and a noise floor
does not predict whether an ASR will latch onto the echo. The caveat listed
below — "speech at full playback volume will couple more" — turned out to be the
entire story. **Only a live conversation tests this.** A sweep is not a proxy.

**The three real states:**

| Config                          | Echo loop | Barge-in   |
| ------------------------------- | --------- | ---------- |
| `CROSSTALK=10` (vendor default) | no        | no         |
| `CROSSTALK=0`, no AEC           | **yes**   | yes        |
| `CROSSTALK=0` + real AEC        | no        | yes ← goal |

That third row is the goal, and as of 2026-07-26 it is what the agent runs:
`MAX_AEC_MODE=apm` drops `CROSSTALK` to 0 and puts max-aec in the capture path.
Setting `MAX_AEC_MODE=off` returns the board to row one — half duplex, no loop,
no barge-in — which is spec ladder step 3, the "emergency only" fallback.

**PulseAudio `module-echo-cancel` (ladder step 1) was tried and does not work
here.** It loads and creates `maxmic`/`maxspk`, but the master sink stays
`SUSPENDED` (unloading `module-suspend-on-idle` does not wake it) and a tone
played through _either_ sink measured mic RMS **1** versus 216 on raw ALSA —
nothing passing in either direction. PulseAudio then held the card
(`Device or resource busy`) until `pactl set-card-profile 0 off`. It is also
architecturally wrong here: it is a **desktop session** service owned by user
`sunrise`, and a helmet appliance booting to a systemd unit must not depend on a
desktop login.

**The fix is ladder step 2, in-process AEC.** The agent already holds the exact
far-end reference — `playback.write()` receives every PCM frame Doubao sends —
so it needs no monitor source, no virtual sink and no user session, and it also
brings noise suppression and AGC, which a helmet at speed wants regardless.

### Why the helmet could not speak generated text

`deviceSuccessSpeech` produces the deterministic confirmation — "拍好了。",
"开始录像。" — and sends it as a transcript marked `useBrowserSpeech`. Web and
mobile speak that themselves. **The board has no `transcript` case and drops
it**, so until 2026-07-28 the one client with no screen was the only one that
never heard the line whose stated purpose is that _"the rider hears the truth
instead of the model's chatter"_.

Observed 2026-07-27: asked for a photo, Max delivered an invented countdown
("3、2、1。照片已拍下") for what is a single frame grab, and never said 拍好了.

The relay now synthesises those lines through Doubao's HTTP TTS
(`DOUBAO_TTS_APPID` / `DOUBAO_TTS_TOKEN`, the same pair `render_alerts.py` uses)
and sends 24 kHz mono PCM16 down the binary channel the board already plays.
**The board was not changed** — `relay.ts` already treats any binary frame as
voice. Audio goes only to `platform === "embedded"`; the other clients would
otherwise say every confirmation twice.

The pacing mechanism stays on the board: `playback.ts`'s `pump()` caps the
queue at 80 ms, the fix that took the reference-to-mic lag from 953 ms to
81 ms. But an earlier version of this relay code sent a whole utterance in one
`client.send`, on the reasoning that the board's cap would meter it regardless
— that reasoning was wrong. `pump()` checks its cap BEFORE shifting a chunk off
the queue, so the cap bounds when a pump cycle starts consuming, not how much
of one already-dequeued chunk it hands to `aplay`; it cannot subdivide a
chunk. One `client.send` is one WebSocket message is one `onVoice` is one
`playback.write` call, i.e. one chunk — so a whole-utterance send arrives as
one chunk the cap cannot meter at all (measured: 192,000 bytes / 2000 ms in
one write, versus 7,680 bytes / 80 ms per 20 ms chunk), misaligning the AEC
reference and, on barge-in, discarding already-played audio the reference
still needed. The relay now chunks every confirmation into 20 ms (960-byte)
pieces and sends one `client.send` per chunk, which is what actually makes the
board's pacing guarantee hold here, the same as it already holds for Doubao's
own voice.

**Not yet verified live.** The Lightsail relay has no `DOUBAO_TTS_*` variables
(`grep -c` over its `.env` returns 0), and without them `createSynthesizer`
returns null on every call by design — so the helmet stays as silent as before
and the feature is inert. Add both to `/home/ubuntu/app/.env` on the relay (the
server `.env` is protected and never overwritten by a deploy), redeploy, then
check two things: that "拍好了" is actually heard, and that several turns of
normal conversation do **not** bring back the echo loop. That second one is the
regression that matters — this injects audio into the playback path feeding the
AEC reference.

### In-process AEC — built and confirmed live, 2026-07-26

**Both acceptance tests pass, in one session, headset on.** Max replies once and
stops, with no `rider:` turn echoing his words; and talking over him mid-reply
cuts him off. That is the 2026-07-25 failure closed, and full duplex with it —
the third row of the table above, which had never been reached before.

Passing both together is the bar. Either alone proves nothing: `CROSSTALK=10`
passes the first and fails the second, `CROSSTALK=0` without AEC does the
reverse, and the 2026-07-25 spike reached a wrong conclusion by checking one.

**What actually caused it to come back once, after the canceller was working.**
`playback.flush()` fires on Doubao's `status: hearing`, and `flush()` reset APM
via `Initialize()` — which discards the adapted filter, the learned
speaker-to-mic path that takes seconds to converge. Doubao's VAD runs on the
uplink, so while Max speaks the thing tripping it is usually his own residual
echo. That closed a positive feedback loop:

> echo leaks → VAD fires → filter wiped → canceller starts from zero → more echo

APM was held permanently non-converged by the very echo it existed to cancel.
The helper was seen resetting **four times in 45 s on ambient room noise alone**,
with nothing playing. The same bug is why an earlier session reported "speech
cut off immediately" — one fault, two symptoms.

The fix is two-part, and both halves matter:

- `ApmSession::reset()` does **not** call `Initialize()`. The acoustic path
  belongs to the helmet, not the utterance, and survives a barge-in. Only the
  queued reference is dropped.
- A relay barge-in is honoured only if the local voice gate — reading the
  already-cancelled mic — heard the rider within 600 ms
  (`rdk/agent/src/audio/barge-in.ts`). Doubao's VAD gets a second opinion from
  a signal the canceller has cleaned.

**If echo ever returns, read the helper's log first.** It prints levels either
side of APM, split by whether Max was speaking, and only when there is something
to say (an utterance or a reset), so an idle helmet logs nothing:

```
journalctl -u max-agent | grep max-aec
max-aec: far-end 300 frames in=... out=... (N dB removed) | quiet ... | ref ... resets ... erle ...
```

**`resets` climbing is not evidence of that bug.** It was, before `e8c95f0`,
when `reset()` still called `Initialize()`. It no longer does — see the comment
at `rdk/aec/src/apm.cpp:86` — so a reset drops the queued reference and the
decimator history and leaves the adapted filter alone. The counter now measures
reference churn, not filter damage.

What makes it climb is anything calling `playback.flush()`: a confirmed
barge-in, an interrupting hazard alert, and — the one that surprises people — a
relay disconnect, via `onClosed` in `rdk/agent/src/main.ts`. A board that has
lost the relay reconnects on a backoff that pins at 30 s, so an **idle** helmet
logging one reset every 30 s with `far-end 0 frames` is a network symptom with
no acoustic meaning at all. Confirm with `journalctl -u max-agent | grep
reconnecting` before reading anything into it. On 2026-07-27 this cost a
debugging session: 207 reconnects over a phone hotspot were read as the echo bug
returning.

So: a low `dB removed` means the canceller is short regardless of what `resets`
is doing. Diagnose from `dB removed` and `erle`, and treat `resets` as context.

**Two things nearly made barge-in fail for reasons unrelated to echo.** Both are
worth knowing before touching this code:

- The barge-in witness must be fast. The first version asked `createVoiceGate`,
  which waits 400 ms for sustained speech. The relay's event arrives ~100-200 ms
  after speech starts and is sent **once per turn**, so the witness was still
  silent when asked and every interruption would have been dropped. The guard
  now reads raw frame RMS over 3 frames (60 ms).
- Either side may notice first. If the relay is ahead, the request waits 300 ms
  for the mic rather than being discarded.

### How it is built

`rdk/aec/max-aec` is a C++ helper wrapping WebRTC APM 0.3.1. It replaces
`arecord`: it captures at 48 kHz, decimates to 16 kHz, runs echo cancellation
plus noise suppression and gain control, and writes uplink frames to stdout.
The far-end reference arrives on fd 3. The agent owns `CROSSTALK` and drops it
to 0 when AEC is active — verified by forcing it to 10 and watching the agent
zero it on restart.

Deployed and running on the board:

```
max-aec --device plughw:0,0 --delay-ms 80 --suppression 0
```

**The defect that mattered was not in the canceller.** Cross-correlating the
recorded mic against the reference measured the true reference-to-mic lag at
**953 ms**. WebRTC's filter spans ~500 ms at best, so APM never saw the echo:
it reported ERLE **-100 dB** (its no-data value) and removed 1–2 dB. The cause
was in `playback.ts` — the relay delivers TTS faster than realtime and every
frame went straight into aplay's stdin pipe (64 KB = 683 ms at 48 kHz) on top
of the 120 ms ALSA buffer, while the reference was emitted at _queue_ time.
Playback now paces itself, handing aplay at most 80 ms at a time and emitting
the reference alongside each write. Re-measured: **953 ms → 81 ms**, with the
correlation peak twice as sharp. `MAX_AEC_DELAY_MS` defaults to that measured
80 ms.

Note the delay sweep this plan originally called for stopped at 320 ms, so it
could never have found this. If cancellation looks broken, **measure the lag
first** — `rdk/aec/tools/acoustic.py` does it.

**Re-measured 24.9 ms from a live session, 2026-07-27 — not yet confirmed as a
fix.** Cross-correlating the `--dump-prefix` capture (see below) over five
consecutive windows of a real conversation gave 24.9 ms every time, peaks to
0.80, no drift. Against that, the configured 80 ms is roughly 3× the truth. The
board now runs `MAX_AEC_DELAY_MS=25`, and on the one run since, cancellation
appeared in the _first_ far-end interval (18.6 dB) instead of ramping for ~15 s
(3.2 → 5.2 → 22.1 dB at 80 ms), and held a much tighter 13.9–21.6 dB.

That is one run against an intermittent fault, so it is a promising measurement
and nothing more. Do not promote 25 ms to a documented default, or change the
figure in the findings table above, until a second clean live conversation
reproduces it. Why the path shortened from the 2026-07-26 measurement of 81 ms
is also unexplained and worth knowing before trusting either number.

**The dump cannot be replayed through `--offline` to reproduce cancellation.**
Live, `process_reverse` is called only when a reference frame is pending; the
dump writes silence into `ref.raw` for every frame that had none. Replaying it
therefore hands APM a render stream full of silent frames the live path never
saw, and the render/capture lockstep differs. A delay sweep run that way scored
a flat 1.0 dB at every setting on audio where live APM had reported up to 31 dB.
Use the dump for the lag correlation, which involves no APM at all, and use the
live log for anything about cancellation.

**The offline suppression sweep was wrong, and hardware overruled it.** Read
this before trusting any figure in the table below.

The sweep recommended `kLowSuppression`: ERLE was identical at all three levels,
so the residual suppressor appeared to buy nothing while costing up to 10 dB of
double-talk. That held until 2026-07-26, when the echo loop returned with APM
reporting **erle 0.0-2.0 dB** on a live session and `resets` climbing. Raising
`MAX_AEC_SUPPRESSION` to **2** stopped it, confirmed live with the headset on.

The caveat written next to the original sweep turned out to be the entire story:
that fixture's echo path is linear, a real speaker is not, and the nonlinear
residue is exactly what the residual suppressor exists to catch. The linear
filter handles a synthetic echo so completely that suppression looks redundant —
and handles a real one so poorly that suppression is the only thing working.

**Default is now 2.** Drop to 1 if interrupting Max becomes unreliable; high
suppression attenuates the rider during double-talk, which is the documented
cost.

**Offline figures** (`tools/erle.py`, synthetic linear echo — see the warning
above before drawing conclusions from these):

| Measurement | Result  | Meaning                               |
| ----------- | ------- | ------------------------------------- |
| ERLE        | 32.7 dB | echo-only mic, how much was removed   |
| near-end    | +7.8 dB | rider-only mic, AGC boost — preserved |
| duplex loss | 12.5 dB | echo + rider at once — **barge-in**   |

The duplex row is the one that matters and the one a lone ERLE number hides. At
`kHighSuppression` the fixture scored the _same_ 32.7 dB ERLE while destroying
22.1 dB of the rider — broken barge-in with an excellent-looking score. ERLE was
identical at all three suppression levels, so the residual suppressor bought no
echo rejection and only cost double-talk. Hence `MAX_AEC_SUPPRESSION=0`. That
fixture's echo is linear, though, and suppression is what catches nonlinear
speaker residue — raise it if a real ride leaks echo.

**What the desk bench cannot tell you — and this has now cost three separate
attempts.** With the board on a table the speaker reaches the mic at RMS ~90
against an ambient floor of ~275: there is no echo above the noise to cancel,
and every acoustic ERLE figure measured that way is noise. On 2026-07-26 a
bench run reported ~1 dB ERLE and a follow-up measured **ambient at 795 with the
speaker silent against 167 with it playing** — physically impossible, and proof
only that two readings minutes apart are not comparable. Do not diagnose echo
from this desk. Use APM's own `erle` from a live session log instead; it is
computed on real data. The helmet puts the speaker centimetres from the mic. The bench never
reproduced the loop and never could have — **acceptance was, and remains, a
live conversation.** Same lesson as 2026-07-25, one level up.

Two traps are now guarded in `tools/acoustic.py` because both were hit: it
refuses to run against a binary that does not know its flags (a failed build
silently left the old one in place and produced plausible numbers), and it
forces `CROSSTALK` to 0 (leaving the duck on credits APM for the codec's work).

Board thermals with AEC running: CPU 75.8 °C, BPU 75.7 °C, DDR 76.4 °C, against
a ~71 °C idle.

### The original sweep measurement, kept for the record

Method: a 200–8000 Hz logarithmic sweep at 0.3 full scale played through the
headset while simultaneously recording the mic, compared against a silent
reference for the noise floor. `sox` is not installed on the board, so the sweep
was generated in Python. Reproduce with:

```bash
arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 5 /tmp/silence.wav   # floor
aplay -D plughw:0,0 /tmp/sweep.wav & \
  arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 4 /tmp/echo.wav; wait
# compare audioop.rms() of the two
```

**The ES8326's `CROSSTALK1`/`CROSSTALK2` controls default to 10 and act as a
hardware duck, not an echo canceller.** Holding the DAC at 0 dB and changing only
that control:

| `CROSSTALK`  | noise floor | during playback | outcome                          |
| ------------ | ----------- | --------------- | -------------------------------- |
| 10 (default) | −35.5 dBFS  | −47.8 dBFS      | capture pushed **below** ambient |
| 0            | −43.7 dBFS  | −38.1 dBFS      | echo audible at **+5.5 dB**      |

At the default it attenuates _everything_ during playback, including room noise.
That reads like a defect, and the original conclusion here was "leave them at 0
or barge-in cannot work" — **which is what caused the echo loop above.** The
vendor default exists precisely to prevent it.

With the duck disabled, coupling measured **+5.5 dB above the noise floor**,
which looked mild enough for ladder step 1. In practice it was more than enough
to drive the ASR.

Honest limits of this measurement — the third one turned out to be decisive:

- RMS over the whole capture, not a true ERL against a calibrated reference.
- The ambient floor drifted between runs (−43.7 vs −35.5 dBFS), so treat the
  numbers as indicative rather than precise.
- Sweep was 0.3 FS; speech at full playback volume will couple more.
- **Not tested at the time: a person talking while Max speaks.** This was flagged
  as "the one result that could still overturn this" — and it did, within the
  hour.

Also on the board already: a prebuilt BPU detector at
`/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin`
and a MIPI-camera-into-YOLOv5s sample at
`/app/pydev_demo/08_mipi_camera_sample/01_mipi_camera_yolov5s.py`.

## Camera findings

**The stock auto-detect path is broken on this board.** `libsrcampy.open_cam(port, -1, …)`
always searches `vcon@0` (i2c bus 6), which is physically empty. The vendor stack
reports a phantom `ov5647` there — the log line is `vp_sensor_detect_2 Support
sensor index:0`, i.e. it lists _supported_ sensors, not detected ones — then
`/usr/hobot/bin/cam-service` NULL-dereferences initialising a sensor that does
not exist. Every camera open fails as a result, and the first failure wedges the
ISP so later attempts fail earlier and differently.

Consequences:

- **`rdk/vision/camera.py` cannot use `open_cam` auto-detect.** It must pin the
  port explicitly via `hbn_camera_create(camera_config_t*, …)` from
  `/usr/hobot/lib/libcam.so`, setting `bus_select` (the VCON index) plus `name`
  and `addr`. Headers are installed: `/usr/include/hb_camera_data_config.h`,
  `hb_camera_interface.h`, `hbn_api.h`.
- `systemctl restart cam-service` resets a wedged pipeline — no reboot needed
  between experiments.
- Vendor bug worth reporting: `cam-service.service` has
  `ExecStart=… -V6 &`, and systemd passes that trailing `&` as a literal argv.

**Sensor support is not equal.** Measured A/B on the same port:

| Module     | i2c addr | Result on MIPI host 2                        |
| ---------- | -------- | -------------------------------------------- |
| **IMX219** | `0x10`   | **streams 1920×1080 @ 30 fps** ✅            |
| **OV5647** | `0x36`   | `create_and_run_vflow ret -10`, no frames ❌ |

### OV5647 works on host 0, and fails on host 2

**The port is the variable, not the sensor.** An earlier version of this section
declared OV5647 unsupported "decided, not pending". That verdict rested on the
A/B directly above, which this file itself scopes to **MIPI host 2**. Nobody had
tried host 0. On host 0 the same sensor model streams 1920×1080 at ~24 fps with
a correctly exposed, in-focus image, and the kernel logs the full bring-up
(`sensor_start ov5647 flow0 start done`, `vin mipi0: entry hs reception`).

| Sensor | host 0     | host 2                            |
| ------ | ---------- | --------------------------------- |
| OV5647 | streams ✅ | `create_and_run_vflow ret -10` ❌ |
| IMX219 | untested   | streams ✅                        |

Two of four cells are measured — too few to encode a support matrix in code,
which is why `sensors.preflight()` reports rather than vetoes. The ruled-out
list below stays valid and stays useful; only the conclusion drawn from it
changed. The host-2 diagnosis, recorded so nobody spends another afternoon on
it:

```
isp_video_set_inter_attr ... sensor_cali_name = .../ov5647_1920x1080_tuning.json
                    ↓ 5.05 s
ctx_id 0, inst id 0, sensor .../ov5647_1920x1080_tuning.json   → teardown
create_and_run_vflow failed, ret -10
```

Ruled out, each by measurement:

- **Not the sensor driver.** `imx219` and `ov5647` in
  [x5-libcam-sensor](https://github.com/D-Robotics/x5-libcam-sensor) are
  structurally identical — same GPIO power-on, register init, and stream-on. A
  BSP rebuild of `libov5647.so` would change nothing.
- **Not signal integrity or lane config.** Every `mipi_host*/status/icnt`
  counter reads 0 and the D-PHY never leaves reset, so the sensor is never asked
  to stream.
- **Not our code.** The vendor's own `mipi_cam` fails identically.
- **Not a stale image.** `hobot-camera 3.1.1` is the newest available; `apt` has
  no upgrade.
- **Not a version gate.** `CAMERA_CALVER_NOCHECK=1` and `CAMERA_CONFIG_NOCHECK=1`
  make no difference.

The failure is in the shipped ISP tuning/camsys handling of
`ov5647_1920x1080_tuning.json`. If you want to pursue it upstream, the relevant
repo is [x5-drv-camsys](https://github.com/D-Robotics/x5-drv-camsys) — not the
sensor tree — and the block above is the bug report. One cheap local test first:
diff your BSP's `ov5647_1920x1080_tuning.json` against the board's copy
(343293 bytes); if the BSP has a newer one, dropping it in is a one-file
experiment.

`tools/record_ride.py` runs an i2c preflight before opening anything, so an
**unseated** module fails in under a second with a specific message instead of a
five-second ISP timeout that points at the wrong layer. Preflight reports rather
than vetoes: it no longer refuses a sensor for being the wrong model, because
that is exactly what would reject the OV5647 now streaming on host 0. A
combination that cannot stream fails at open, with the vendor's own error.

Known-good reference command, for confirming the camera outside our stack:

```bash
source /opt/tros/humble/setup.bash
ros2 run mipi_cam mipi_cam --ros-args \
  -p video_device:=IMX219 -p channel:=2 -p image_width:=1920 -p image_height:=1080
```

**Front+rear is NOT blocked by an address collision** — an earlier note here
claimed it was, based on only ever seeing one camera at a time. With two modules
attached, both enumerate simultaneously on **different i2c buses**:

| Connector | VCON                | i2c bus | mipi channel |
| --------- | ------------------- | ------- | ------------ |
| CAM1      | `vcon@0` / `vcon@1` | 6       | **0**        |
| the other | `vcon@2` / `vcon@3` | 4       | **2**        |

`mipi_cam` prints `this board support mipi: host 0, host 2` at startup — hosts 1
and 3 do not exist. So each connector carries exactly **one** usable camera, and
a front+rear pair is channel 0 plus channel 2. Verified from the device tree at
`/sys/firmware/devicetree/base/soc/cam/vcon@N` (`bus` and `rx_phy` properties).

No `gpio_enable_bit` / `gpio_level_bit` multiplexing is needed. (Those fields
would only matter for two modules sharing one bus, which is not the arrangement
here.)

### Exactly one process may hold the camera

A second opener does not queue or fail clearly. It fails with:

```
[INFO] [mipi_cam]: The detected sensors are 1 less than expected.
[ERROR] [mipi_cam]: [init]->cap capture init failture.
```

which names _sensor detection_ when the real cause is that `/dev/vs-isp0_*` is
busy. i2c still answers, the chip ID still reads back, and `dmesg` shows nothing
new — so every instinct sends you to the wrong layer. Check holders first:

```bash
fuser /dev/vs-isp0_cap; ps -eo pid,ppid,args | grep "[m]ipi_cam/mipi_cam"
```

**`ros2 run` is a wrapper.** It execs the real `mipi_cam` binary as a child, so
`Popen.terminate()` on it kills the wrapper and leaves the node running,
reparented to init (PPID 1), still holding the ISP — while `wait()` returns
cleanly and nothing looks wrong. Start it with `start_new_session=True` and
signal the whole process group. `rdk/vision/mipi_camera.py` does this, and also
reaps any surviving holder before it opens, so a max-vision crash cannot leave
the camera permanently unopenable.

`systemctl restart cam-service` does **not** clear an orphan; only killing the
holder does.

### Frame sharing — `MAX_VISION_SHARE`

Governs whether a frame from `/frame/<front|rear>` (`bench_server.py`) may be
sent off-board to the vision model for a scene description. It defaults to
`0`, and at `0` the route refuses every request with `403` — verified on the
bench 2026-07-28: `403` with sharing off, `200` with a real 640×360 JPEG
(26–27 KB, two independent fetches, both a plausible bench scene rather than
black or garbage) with `MAX_VISION_SHARE=1`, then `403` again once it was set
back to `0` and the sidecar restarted.

This is **not** the only route that puts image bytes on the wire. The
pre-existing `/preview/*` MJPEG route (used by the dev HUD) is unauthenticated
and streams to anyone on the LAN regardless of this setting — it predates the
gate and is not covered by it. `MAX_VISION_SHARE` only governs frames the
sidecar hands to the relay's vision call, not every way a frame can leave the
board.

If the vision model call fails or times out for any reason — no credential,
rejected auth, a bad response shape, a timeout — the relay does not guess.
`server/vision.ts`'s `describe()` returns `null` on every failure path, and the
caller speaks "我看不清。" rather than a fabricated description.

## Running

```bash
sudo mkdir -p /etc/max
sudo tee /etc/max/agent.env >/dev/null <<'ENV'
MAX_RELAY_URL=ws://<lan-ip>:8787/agent
MAX_RELAY_TOKEN=                           # required once the relay has accounts
MAX_RELAY_INSECURE_TLS=0
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
MAX_VISION_SOCKET=/run/max/vision.sock
RDK_CAMERA_FRONT=0                         # MIPI channel; CAM1 connector
RDK_CAMERA_REAR=2                          # MIPI channel; the other connector
MAX_ADAS_SHADOW=0                          # 1 starts a ride: segments + shadow ADAS
MAX_VISION_SHARE=0                         # 1 lets camera.look frames leave the board for description
MAX_CORPUS_DIR=/var/lib/max/corpus         # where ride segments are written
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
ENV

sudo cp rdk/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now max-agent max-vision
journalctl -u max-agent -f
```

Only the exact string `1` enables `MAX_RELAY_INSECURE_TLS`; anything else leaves
certificate validation on.

**`MAX_RELAY_TOKEN` is required against any relay that has user accounts** — the
relay refuses the `/agent` upgrade with 401 otherwise, and the client just
reconnects in a loop with no explanation. Accepts the operator `RELAY_AUTH_TOKEN`
or a `sess_…` login token. Keep `/etc/max/agent.env` at mode 600.

Run it through systemd rather than by hand; `nohup`/`setsid` over SSH does not
reliably survive the session:

```bash
systemctl restart max-agent && journalctl -u max-agent -f
```

Two footguns worth knowing when poking at the board over SSH:

- `pkill -f rdk/agent/src/main.ts` matches **its own SSH command line** and kills
  the shell before it prints anything. Use `pkill -f 'agent/src/mai[n].ts'`.
- PulseAudio (user `sunrise`) can hold the ALSA card, so `arecord` fails with
  `Device or resource busy`. Release it with
  `sudo -u sunrise XDG_RUNTIME_DIR=/run/user/1000 pactl set-card-profile 0 off`.
  This reverts when the desktop session restarts — making it permanent is
  outstanding work.

`max-agent` names `max-vision` in `After=` but does not `Require=` it: if the
vision sidecar is down, the agent still runs and camera actions fail truthfully
rather than taking the voice path down with them.

## On-hardware verification

With `npm run dev:server` running on the LAN host:

**Voice**

1. `systemctl start max-agent`, then `journalctl -u max-agent -f` — expect
   `[relay] session ready`.
2. Say "Max，现在天气怎么样" into the headset and hear a spoken reply.
3. Interrupt a reply mid-sentence; speech must stop within ~120 ms.
4. Unplug and replug the headset; the service recovers without a restart.

**Cameras**

1. `systemctl start max-vision`, then open `http://<board>:8081/preview/front`
   and `/preview/rear` — both show live video.
2. Say "拍照" — a `pair-*` directory appears under `/var/lib/max/gallery` with
   two JPEGs and a manifest.
3. Say "开始录像", wait, then "停止录像" — two `.h264` files and a manifest.
4. Say "开始录像" twice — Max says "已经在录了。"
5. `systemctl stop max-vision`, then say "拍照" — Max reports a truthful failure
   and the voice session keeps working.

**Dev HUD**

Open `http://<board>:8080` from a laptop, or Chromium kiosk on the board's HDMI.
Start a session and confirm turn state, transcript, latency, and both previews
update live.

## Known gap

`camera.py` does not yet attach the `libsrcampy` H.264 encoder in
`start_recording` / `stop_recording` — that is the one piece that cannot be
written without the board. The surrounding policy (recording state machine,
space guard, ten-minute cap, and which sides the manifest names) is implemented
and covered by `tests/test_camera_policy.py`. Attach `libsrcampy.Encoder` to each
live sensor on start and release it on stop, writing `front.h264` / `rear.h264`
into the pair directory. Do not change the state machine while doing so.

## Running the Python suite

pytest is a dev-only dependency. The recorder needs no third-party packages;
the ADAS pipeline added in M1 needs numpy, which is already present on the
board (1.26.4).

**The suite runs on the board.** There is no pytest or numpy on the usual dev
machine, so tests are deployed and run over SSH:

```bash
scp -r rdk/vision root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

## ADAS M1 — the measurement pipeline

Spec: `docs/superpowers/specs/2026-07-26-adas-m1-measure-design.md`.
Built 2026-07-26. **The constants are untuned starting values** — see the bottom
of this section before reading any alert as meaningful.

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/vision && \
  python3 tools/check_anchors.py && \
  python3 tools/replay.py CLIP.mp4 --camera front --out /tmp/replay'
```

### Anchors are validated, and that gates everything else

`tools/check_anchors.py` runs the real BPU over the board's own `bus.jpg`. If
the anchor table were wrong, detections would still appear and every TTC number
downstream would be quietly garbage, so this runs before anything else is
believed.

```
bus     0.68  x[0.068,0.954] y[0.215,0.689]
person  0.88  x[0.070,0.262] y[0.364,0.824]
```

The check that actually discriminates is **person aspect ratio**: 1:2.4 to
1:3.2, i.e. human-shaped. Anchor priors set box dimensions, so a wrong table
distorts aspect even when box centres look plausible. An earlier version of
this check asserted the bus filled half the frame vertically and failed — that
was the assertion being wrong, not the anchors: `bus.jpg` is portrait
(810x1080) and its lower third is road.

### Measured on the board

| Measurement                      | Result                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| End-to-end latency               | **52.4 ms** p50, 54.2 ms p95 — 19.1 fps single stream                  |
| — BPU forward                    | 19.1 ms                                                                |
| — ego motion                     | 17.3 ms                                                                |
| — postprocess (decode + NMS)     | 6.4 ms                                                                 |
| — letterbox                      | 6.2 ms                                                                 |
| Sustained, 2 streams, voice live | **22.7 inferences/s = 11.4 fps per camera**                            |
| Throttling over 10 min           | **none** — throughput flat at 22.7–22.8 throughout                     |
| Temperature                      | 78.6 °C start → **plateau ~90 °C** (peak CPU 90.6, BPU 90.0, DDR 90.9) |
| Determinism                      | identical detections across two independent live BPU runs              |
| Cache vs live                    | identical alerts                                                       |

11.4 fps per camera clears the spec's 10 fps target, and the pipeline reached
thermal steady state rather than climbing — it plateaued at 363 s and held.

**The thermal headroom is the real risk.** 90 °C was measured on an open bench
at room temperature. A helmet in a Chinese summer adds ambient that this bench
does not have, and the gap to a throttle point is perhaps 5–15 °C. Sustained
dual-camera inference is comfortable here and may not be on the bike. Ego
motion is the cheapest place to buy headroom back if needed — dropping it to
5 fps would cost little and save ~9 ms per frame.

### The alert path works end to end on hardware

Driving a synthetic approach (a `zoompan` into `bus.jpg`) through the real BPU
produced a real alert from real detections:

```json
{ "threat_id": "pedestrian_ahead", "severity": "critical", "ttc_s": 1.195, "t_ms": 300 }
```

The chain is proven: BPU detections → tracker → TTC → threat rules →
suppression → alert. It fired `pedestrian_ahead` rather than the bus because
the person crossed its more permissive 2.5 s threshold first, after which the
4 s global gap correctly suppressed everything else in a 2.5 s clip.

**Watch the fixture, not just the result.** The first two synthetic clips
produced no alerts, and the pipeline was right: `ffmpeg`'s `zoompan` resets
`zoom` per input frame when fed `-loop 1 -i image` with `d=1`, so the clips
never actually zoomed and the box height sat at a constant 0.226. Use `pzoom`
for an incremental zoom. The diagnostic that caught it prints per-frame height,
rate and TTC — worth reaching for before suspecting the rules.

### What M1 does not establish

- **Detection quality and range.** Needs real traffic footage from the helmet's
  viewpoint. Nothing here says whether stock yolov5s finds a car at 40 m from a
  moving bike, which is the question M2 rests on.
- **File-vs-camera parity.** Blocked by the same missing hardware as the corpus.
  What is verified instead is run-to-run determinism and cache/live
  equivalence; the `FrameSource` seam means the deferred test is a few lines
  rather than a refactor.
- **Whether any threshold is correct.** All constants are the parent spec's
  conservative starting values. `summary.json` carries a `tuning_status` field
  saying so, so a clean run cannot be mistaken for a validated one. The three
  exit criteria — under 1 false alert/hour, zero false criticals, no regression
  in caught hazards — all need a labelled corpus and therefore an IMX219.

One vendor caveat seen in every BPU run: the runtime warns that the hbrt
library (3.15.55.0) and the model build (3.15.45.0) differ, and recommends
matching toolchains. Detections validate correctly regardless, but if boxes
ever look subtly wrong, start here.

## ADAS M2 — the on-bike runtime, in shadow mode

Spec: `docs/superpowers/specs/2026-07-26-adas-m2-ride-design.md`. Built
2026-07-26.

### Alert audio is LOCKED, and this is the part to read before changing anything

`MAX_ADAS_AUDIO` defaults to `0`. The runtime detects, logs and tells the agent;
the agent says nothing. The agent prints which mode it is in at startup:

```
[adas] shadow mode: hazards are logged, never spoken
[adas] ALERT AUDIO ARMED — shadow numbers must have met the M1 gate
```

**Arming requires evidence, not a decision to ship.** The condition is the M1
gate, measured against real shadow data: **under 1 false alert per hour** and
**zero false `critical` alerts**. None of M1's suppression constants have been
tuned — they are the parent spec's conservative starting values — and untuned
thresholds must not reach a rider's ears at 100 km/h. A false alert at that
speed can cause the crash it was meant to prevent.

Only the exact string `1` arms it. `true`, `yes` and `on` all leave it locked,
so a plausible-looking typo cannot arm audio by accident.

### Reading a shadow log

One JSONL per ride. Each record answers "why did it fire" without re-running
anything, because the ride is over by the time anyone reads it:

```
pedestrian_ahead sev=critical ttc=1.20s seg=front_000000.h264+300ms
  h=0.272 rate=0.197 frames=4 moving=True
```

Pull the clip for any alert straight out of the ride recording:

```bash
python3 tools/clip.py /var/lib/max/corpus/ride-001/shadow.jsonl \
  --index 0 --segments /var/lib/max/corpus/ride-001 --out /tmp/alert.mp4
```

Clips come from the recorder's own segments rather than a rolling buffer —
~310 MB per camera saved — which also means **shadow clips are corpus
material**, feeding the tuning that eventually unlocks the audio.

**Shadow mode refuses to start without the recorder.** That is deliberate: a
false-alarm rate whose evidence was never written is exactly the number that
misleads, and this board has already produced two measurements that looked
healthy and meant nothing (the 2026-07-25 AEC sweep, and an acoustic bench that
measured a room instead of an echo).

### Alert audio must stay on the playback path

`alert-player.ts` plays through `playback.write()`, never a separate `aplay`.
That path carries the soft limiter, the pacing **and the AEC reference tap**.

An alert leaves the same speaker and enters the same microphone as Max's voice.
Route it around `playback` and APM is never told about it, the mic hears an
uncancelled warning, Doubao's VAD fires on it, and the echo loop returns —
triggered by our own safety alert. See the AEC section above for what that cost.

An alert also cannot be preempted: `playback.flush()` is a no-op while one
plays. Without that, a rider saying "什么?" mid-warning trips the VAD and cuts
the collision alert in half.

### Rendering the clips

```bash
DOUBAO_TTS_APPID=... DOUBAO_TTS_TOKEN=... \
  python3 tools/render_alerts.py --out /opt/max/rdk/audio/alerts
```

These credentials are **separate from the relay's** — the relay only uses TTS
inside a realtime session and has no standalone synthesis path. The network call
is the one piece of M2 no test covers.

### Bench result, 2026-07-26

Shadow mode end to end through the real BPU, file-fed:

```
alerts: 1
  pedestrian_ahead sev=critical ttc=1.20s seg=front_000000.h264+300ms
  emitted: pedestrian_ahead | 前方有行人，请减速。
```

Board suite: 200 pytest passing. Repo gate: `npm run check` green, 611 vitest.

### What M2 does not establish

- **Whether the alerts are right.** Shadow measures the false-alarm rate; it
  cannot measure _missed_ hazards without labels, which needs the corpus.
- **Anything on a real road.** No cameras (OV5647 unsupported, IMX219 absent),
  so every runtime test drives a `FileSource` and shadow mode has collected
  nothing from an actual ride.
- **That the TTS call works.** Unverified — see above.

Note `rdk/vision/adas/catalog.py` duplicates the spoken strings across the
Python/TypeScript boundary, and `pedestrian_ahead` and `tailgating` are not in
`shared/adas.ts` yet. No test can catch drift from either side; keep them in
step by hand.

## ADAS M0 — recording a corpus

See `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md`.

Record on the board (Ctrl-C or SIGTERM to stop):

```bash
systemctl restart cam-service && sleep 3
source /opt/tros/humble/setup.bash
cd /opt/max/rdk/vision
python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10 \
  --front-channel 0 --rear-channel 2
```

Those are the defaults, so plain `python3 -m tools.record_ride` does the same.
The sensor on each channel is discovered over i2c — there is no `--sensor` flag,
because a configured sensor name is what stopped the OV5647 in CAM1 from opening.

**Stop the sidecar first:** `systemctl stop max-vision`. The board allows exactly
one holder of the ISP, so a recorder and a running max-vision cannot both have
the camera.

**Two frame sources**, selected with `--source`:

| `--source`           | Camera path                                    | Segment format |
| -------------------- | ---------------------------------------------- | -------------- |
| `mipi_cam` (default) | the vendor's ROS node — **the one that works** | `.mjpeg`       |
| `binding`            | our ctypes `hbn_camera_create` + hw encoder    | `.h264`        |

`mipi_cam` is the default because our binding cannot open a camera yet:
`hbn_camera_create` returns -1 even with a matching sensor spec and the correct
VCON — re-confirmed 2026-07-27 for OV5647 and IMX219 on vcon 0 and 1 alike. The
binding path is kept so switching back is a flag flip once that is solved.

Both the recorder and the sidecar now go through `rdk/vision/mipi_camera.py`, so
the ROS dependency is no longer confined to recording — and neither is the fix
for the orphan it used to leave behind. See "Camera findings".

### Seeing captures

The bench HUD at `http://<board>:8080/` shows a **captures** grid under the
transcript, served by the sidecar on `MAX_VISION_PREVIEW_PORT` — the same reason
preview lives there, that image bytes never pass through the agent.

| Route                              | Returns                                          |
| ---------------------------------- | ------------------------------------------------ |
| `GET /gallery`                     | every capture, newest first, with sizes          |
| `GET /gallery/<pair>/<file>`       | the bytes; a `.mjpeg` downloads as an attachment |
| `GET /gallery/<pair>/<file>/thumb` | the first frame of a recording                   |

It is **read-only**: nothing on that page deletes a capture, because it is
unauthenticated and bound to `0.0.0.0`. Clear space with `rm` over SSH.

Any path resolving outside the gallery root is a `404`. The sidecar runs as
root, so that check is a security boundary, not tidiness — see
`bench_server.safe_path`. Verify it with `--path-as-is`, or curl normalises the
`..` away client-side and proves nothing:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --path-as-is \
  "http://<board>:8081/gallery/../../../etc/shadow"     # must be 404
```

**The page and the sidecar deploy separately.** The grid lives in
`rdk/agent/src/hud/index.html` and ships with the agent, which runs from source
and reads it at startup; the routes live in `rdk/vision/bench_server.py`.
Changing a route needs `systemctl restart max-vision`, and a long-running
sidecar will keep serving the old code until you do.

### Shadow mode in the sidecar

`MAX_ADAS_SHADOW=1` makes max-vision start a **ride** at service start: it writes
continuous `.mjpeg` segments under `MAX_CORPUS_DIR` and runs one shadow-mode ADAS
thread per open camera. Alerts go to `<ride>/shadow-<camera>.jsonl` and are pushed
to any connected control-socket client as `event: hazard`.

Recording and ADAS start together on purpose. Shadow mode without evidence is the
measurement that misleads, so the runtime refuses to run without a recorder — and
since the board allows exactly one holder of the ISP, `tools/record_ride.py`
cannot supply that while the sidecar has the camera. The sidecar records instead.

**This makes no sound.** `MAX_ADAS_AUDIO` is untouched and still defaults to `0`;
arming remains a human decision against shadow numbers meeting the M1 gate.

Segments are large — measured at ~3 MB/s (821 MB for 4.5 minutes), so roughly
11 GB an hour. The ride refuses to start, and stops itself, below
`MAX_GALLERY_MIN_FREE_MB` free.

**Thermal: read this before arming or running a long ride.** A shadow ride on
**one** camera plateaus at **~94 °C** at bench ambient — measured 93.8–94.7 °C
over a minute, dropping to 87.7 °C within 20 s of the ride stopping. M1's
two-camera ADAS figure was ~90 °C _without_ a concurrent segment stream, so
recording is what costs the extra headroom. Nobody has measured this in a
fairing, in sun, on a moving bike; the remaining margin to throttling is thin
enough that a second camera or a warm day should be measured, not assumed.

A ride that logs no alerts is not evidence of a broken pipeline. Replay the
ride's own segment (`python3 -m tools.replay <segment> --camera front`) — if it
also reports 0 alerts, the scene simply had no hazards. That is how the first
live ride was verified: 237 frames, 0 alerts, both live and on replay.

Because `mipi_cam` publishes decoded frames on `/image_raw`, the recorder
JPEG-encodes them, so a segment is concatenated JPEG rather than an H.264
stream. `corpus/library.py` accepts both.

Segments are 60 s plus a `.jsonl` metadata sidecar, so a power cut costs at most
one minute. A camera that will not open is logged and skipped — front-only rides
are expected on current hardware, and only a ride with no cameras at all is an
error.

Copy the corpus off the board, then label hazard windows on a laptop:

```bash
python3 -m tools.label list --root ./corpus
python3 -m tools.label add --ride ./corpus/ride-20260725-141900 \
  rear_approach:rear:12000:15000:"car closed fast"
python3 -m tools.label show --ride ./corpus/ride-20260725-141900
```

Offsets are milliseconds from the ride start, matching `wall_ms` in the
sidecars. Only the four M1 threats are accepted: `forward_collision`,
`pedestrian_ahead`, `rear_approach`, `tailgating` — anything else is rejected
rather than written, so the corpus stays interpretable.

Storage: roughly **10 GB per hour per camera** for `.mjpeg` at 10 fps / 1080p
(JPEG q85). The `binding` path would be ~1.8 GB/hour once it works, since H.264
exploits inter-frame redundancy that per-frame JPEG cannot.

**Not yet verified on hardware:** a recording that actually captures frames.
The full `mipi_cam` path is exercised — subprocess launch, rclpy node,
subscription, settle timeout, clean teardown — but no sensor that streams has
been attached since it landed. Board-verified so far:

- `cam-service` survives a failed camera open (previously any open crashed it)
- both cameras report unavailable with a specific reason and the CLI exits cleanly
- a per-node rclpy executor, without which two cameras raise
  `ValueError: generator already executing`

**Use IMX219.** The OV5647 produces zero frames even under the vendor's own
`mipi_cam`, so no source can record from it.

The two modules are visually near-identical (they are Raspberry Pi Camera v1 vs
v2). Identify one in seconds by plugging it in alone and scanning:

```bash
for b in 4 6; do echo "bus $b:"; i2cdetect -y -r $b | sed -n '3p'; done
# 0x10 => IMX219  (works)
# 0x36 => OV5647  (does not stream on this image)
```
