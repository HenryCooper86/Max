# Max on RDK X5

[简体中文](README.zh-CN.md) · English

Embedded client for the Max helmet assistant. See
`docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`.

## Provisioning

`rdk/provision.sh` does the directory, watchdog and unit steps below (and writes
`agent.env`); see "Deploying". The commands are kept here as the reference for
what it runs. Node and apt packages stay manual.

```bash
# Node 22 (Ubuntu 22.04 ships Node 12)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs alsa-utils python3-pip
node --version   # expect v22.13+

# Keep durable helmet state private. The agent stores its stable companion
# identity at /var/lib/max/device-id; do not delete or copy this file between
# boards. systemd also provisions /var/lib/max for normal service starts.
sudo install -d -m 0700 /var/lib/max
sudo install -d -m 0700 /var/lib/max/gallery

# Hardware watchdog: a kernel-level hang reboots the board instead of hanging.
sudo mkdir -p /etc/systemd/system.conf.d
sudo cp rdk/systemd/10-max-watchdog.conf /etc/systemd/system.conf.d/
sudo systemctl daemon-reexec
```

`/run/max` is deliberately absent here. `/run` is tmpfs, so anything created by
hand vanishes on the next reboot and `max-vision` then fails to bind
`MAX_VISION_SOCKET`. `max-vision.service` declares `RuntimeDirectory=max`, which
makes systemd create and own the directory on every start.

`MAX_DEVICE_ID_FILE` is a per-board identity, not a deployment artifact. On first start the agent
creates a canonical RDK UUID at mode `0600` under an owner-only `0700` directory and refuses an
invalid owner, mode, symlink, hard link, partial write, or changed identity. Preserve the file
across `/opt/max` releases and never copy it to another board. Verify stability without printing
the value: capture a digest in a shell variable, restart, compare the new digest, and record only
`stable`/`changed` in the acceptance record.

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

| Item                                      | Value                                                                                                                                                                                                                                                                                                    | Date       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Board                                     | `D-Robotics X5 MD V0.2`, Ubuntu 22.04.5, kernel 6.1.83                                                                                                                                                                                                                                                   | 2026-07-25 |
| ALSA capture device                       | `plughw:0,0` — card 0 `duplexaudio`, codec **ES8326**                                                                                                                                                                                                                                                    | 2026-07-25 |
| ALSA playback device                      | `plughw:0,0` — same duplex card, one device for both                                                                                                                                                                                                                                                     | 2026-07-25 |
| Headset wiring (CTIA/OMTP)                | **CTIA, mic works** — −43.6 dBFS ambient, not silence                                                                                                                                                                                                                                                    | 2026-07-25 |
| Raw echo coupling                         | **+5.5 dB** above the noise floor (`CROSSTALK=0`, DAC 0 dB)                                                                                                                                                                                                                                              | 2026-07-25 |
| `module-echo-cancel`                      | **tried, does not work** — master sink stays SUSPENDED, no audio                                                                                                                                                                                                                                         | 2026-07-25 |
| AEC path chosen                           | **in-process** — `rdk/aec/max-aec`, WebRTC APM; built and deployed                                                                                                                                                                                                                                       | 2026-07-26 |
| Reference-to-mic lag                      | **81 ms** measured (was 953 ms before playback pacing)                                                                                                                                                                                                                                                   | 2026-07-26 |
| Echo loop                                 | **fixed** — confirmed live, headset on, Max replies once and stops                                                                                                                                                                                                                                       | 2026-07-26 |
| Barge-in                                  | **works** — confirmed live, talking over Max cuts his reply                                                                                                                                                                                                                                              | 2026-07-26 |
| Live Doubao session                       | **works** — Max speaks, 1.69 MB voice audio down                                                                                                                                                                                                                                                         | 2026-07-25 |
| Helmet speaks confirmations               | **built, NOT yet heard** — relay has no `DOUBAO_TTS_*` credentials                                                                                                                                                                                                                                       | 2026-07-28 |
| Full duplex                               | **works** — simultaneous `arecord` + `aplay`, no device contention                                                                                                                                                                                                                                       | 2026-07-25 |
| Camera front port index                   | **MIPI channel 0** (`vcon@0`/`@1`, i2c bus 6) — the CAM1 connector                                                                                                                                                                                                                                       | 2026-07-27 |
| Camera rear port index                    | **MIPI channel 2** (`vcon@2`/`@3`, i2c bus 4) — the other connector                                                                                                                                                                                                                                      | 2026-07-27 |
| `mipi_cam` nv12 output                    | **works** — `out_format:=nv12`, 3110400 B/frame at 1920×1080                                                                                                                                                                                                                                             | 2026-07-27 |
| CAM1 live capture                         | **works** — OV5647 ch 0: photo, preview and `.mjpeg` via max-vision                                                                                                                                                                                                                                      | 2026-07-27 |
| Gallery recording rate                    | **9.9 fps** measured (60 frames / 6.05 s), 1920×1080 mjpeg                                                                                                                                                                                                                                               | 2026-07-27 |
| max-vision restart                        | **reacquires** — two consecutive restarts, no orphan, no traceback                                                                                                                                                                                                                                       | 2026-07-27 |
| ADAS shadow ride                          | **works** — segments + shadow log + one ADAS thread, `MAX_ADAS_SHADOW=1`                                                                                                                                                                                                                                 | 2026-07-27 |
| Shadow ride frame rate                    | **9.7 fps** (583 frames in a 60 s segment), 1080p mjpeg                                                                                                                                                                                                                                                  | 2026-07-27 |
| ADAS latency under a ride                 | **47.2 ms** p50, 61.7 ms p95 — replay of the ride's own footage                                                                                                                                                                                                                                          | 2026-07-27 |
| Thermal under a shadow ride               | **~94 °C plateau** (93.8–94.7), **one** camera, bench ambient                                                                                                                                                                                                                                            | 2026-07-27 |
| Shadow ride disk rate                     | **~3 MB/s** — 821 MB for 4.5 min; ~11 GB/hour                                                                                                                                                                                                                                                            | 2026-07-27 |
| Power stress test (software-instrumented) | **survived 13.4 min** worst-case load (shadow ride + continuous full-scale amp sweep); ADC 5V-sense transients to ~4.69 V, temps ≤90.7 °C, no throttle. All 5 prior crashes predate the 2026-07-30 move to the home LAN + power reseat; zero since, hours of max load. Meter A/B still pending hardware. | 2026-07-30 |
| BPU                                       | present, idle, 500–1000 MHz; `pyeasy_dnn` + `libsrcampy` OK                                                                                                                                                                                                                                              | 2026-07-25 |
| Node.js                                   | **v22.23.1** installed from NodeSource; npm 10.9.8                                                                                                                                                                                                                                                       | 2026-07-25 |
| First live session                        | **works** — 656 KB mic PCM up, 3 device.result round trips                                                                                                                                                                                                                                               | 2026-07-25 |
| pytest                                    | 6.2.5 on the board; the suite runs there — no local pytest or numpy                                                                                                                                                                                                                                      | 2026-07-25 |
| BPU detector                              | **yolov5s validated** — anchors checked against `bus.jpg`                                                                                                                                                                                                                                                | 2026-07-26 |
| ADAS latency                              | **52.4 ms** per frame p50 (19.1 fps single stream)                                                                                                                                                                                                                                                       | 2026-07-26 |
| ADAS sustained                            | **11.4 fps per camera**, 2 streams, voice live, no throttling                                                                                                                                                                                                                                            | 2026-07-26 |
| Thermal under ADAS load                   | 78.6 °C → **plateau ~90 °C** over 10 min; bench ambient only                                                                                                                                                                                                                                             | 2026-07-26 |
| Vision consent gate + frame route         | **works** — `MAX_VISION_SHARE=0` refuses `/frame/front` with 403; set to `1` it returns 200, a real 640×360 JPEG (26–27 KB, confirmed live over two fetches), gate re-confirmed refusing after restore                                                                                                   | 2026-07-28 |
| Vision describe (live)                    | **NOT verified** — relay's `ARK_API_KEY` is invalid (401 "The API key doesn't exist" in two regions, two auth header styles); no working credential exists, so the round trip to the vision model was never attempted                                                                                    | 2026-07-28 |
| Thermal after encode-sharing fix          | **~87.6 °C plateau** (87.5–87.8), one camera, bench ambient — down ~6.4 °C from the 2026-07-27 ~94 °C baseline                                                                                                                                                                                           | 2026-07-30 |
| Dual cameras simultaneously               | **works** — front OV5647 (ch 0) + rear IMX219 (ch 2), ~30 fps each on per-camera topics; see "Two cameras need two topics"                                                                                                                                                                               | 2026-08-01 |
| Dual-camera recording rate                | **9.8 fps** with parallel per-side encodes (sequential measured 4.4–7.25; front-only ceiling 9.98)                                                                                                                                                                                                       | 2026-08-01 |
| Recording playback pacing                 | **truthful** — manifest stamps the achieved fps; `/play` paces from it, so a clip spans its real duration at 1×                                                                                                                                                                                          | 2026-08-01 |

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
  (`shared/barge-in.ts`). Doubao's VAD gets a second opinion from
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

### Two cameras need two topics — the vendor node shares one by default

`mipi_cam` hardcodes its ROS topic (`/image_raw`) and its node name
(`mipi_cam`). Run two instances and you get two publishers on **one** topic —
measured 2026-08-01: `ros2 topic info /image_raw` showed publisher count 2 and
~50 Hz combined. Every subscriber then drinks both sensors' frames interleaved,
which presents as:

- **Preview and recordings "flicker"** — each view alternates front/rear
  images at frame rate.
- **The staleness monitor goes blind** — a dead camera's buffer stays fresh on
  the _other_ camera's frames, so the self-heal restart never fires and a
  stalled camera stays dead until a human restarts the service.

The fix is standard ROS remapping on the launch command
(`mipi_camera.launch_command`):

```bash
ros2 run mipi_cam mipi_cam --ros-args \
  -r __node:=mipi_cam_front -r /image_raw:=/front/image_raw \
  -p video_device:=OV5647 -p channel:=0 ...
```

Each `MipiCamera` publishes on `/<camera>/image_raw` under its own node name
and subscribes to its own topic. Verified live: `/front/image_raw` and
`/rear/image_raw`, one publisher each, ~30 fps each — and killing a camera's
node now trips `camera frames stale: <name>` within ~10 s, with systemd
bringing both cameras back in about 20 s. That self-heal has since fired
unattended on the bench (2026-08-01, rear stale after an OOM event) and
recovered without intervention.

### Exactly one process may hold _a given_ camera

Two processes driving two **different** sensors coexist fine — both hold the
same `/dev/vs-isp0*`/`vse0*` nodes and stream ~30 fps each (measured
2026-08-01), so the rule below is per camera, not per board. A second opener of
the **same** camera does not queue or fail clearly. It fails with:

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

`/preview/*` obeys the same gate as of 2026-08-11. It used to be exempt — a
continuous MJPEG stream of the helmet camera to anyone on the LAN, regardless
of this setting — which made "sharing off means no image leaves the board" true
only of the smaller leak. With sharing off, `/preview/front` and
`/preview/rear` now answer `403` exactly as `/frame/*` does.

**The dev HUD's camera panels therefore need `MAX_VISION_SHARE=1`.** That is
the intended trade: a bench instrument showing live camera is a frame leaving
the board, and the gate is the one control that must not have exceptions.

### Bench access — `MAX_VISION_TOKEN`

The sidecar's HTTP surface (port 8081) and the agent's HUD (port 8080) both
used to bind `0.0.0.0`, and the sidecar runs as root. Before 2026-08-11 neither was
authenticated: any peer on the network could stream the cameras, list and
download every recorded clip, read the rider's live transcript and destination,
and `POST /gallery/<id>/delete` to destroy a capture — the last of which a
plain cross-origin form POST from any page the rider happened to visit could
trigger.

Both ports now require a shared token from any peer that is not the board
itself. Port 8081 additionally **binds `127.0.0.1` unless told otherwise**: set
`MAX_VISION_LISTEN=all` in `agent.env` to listen on every interface, which the
LAN workflows below (`http://<board>:8081/...?t=<token>`, a laptop browser on the
HUD page) need. The SSH forward in "On-hardware verification" works either way,
because it connects to the board's loopback. Consequently, with the default
settings a browser on the LAN that opens `http://<board>:8080/?t=<token>` gets
the HUD but **dead camera and gallery panels** (its fetches to `<board>:8081`
find nothing listening; the HUD says so in the captures line). Only set
`MAX_VISION_LISTEN=all` on a trusted bench network: it exposes the cameras, the
gallery and its delete endpoint to every peer that holds the token. The phone does not use 8081 (the
companion talks through the relay); it does use 8080 for HUD casting, so that
port stays on all interfaces and is protected by the token alone.

```bash
MAX_VISION_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
```

- **Loopback is exempt.** `camera.look` fetches `/frame/front` over
  `127.0.0.1`, and a board talking to itself is not the exposure being closed.
- **Off-board peers send `?t=<token>`.** Open the HUD as
  `http://<board>:8080/?t=<token>`; the agent templates the token into the page
  so the browser's own fetches to 8081 carry it. There is nothing to type twice.
- **No token configured means nothing off-board is served at all** — both
  ports answer `401` to every non-loopback peer. That is the fail-closed
  direction on purpose: a forgotten env var must not publish the helmet camera,
  and a dark HUD is a visible, fixable symptom. Both services say so on start.

Keep the token out of shell history and out of the acceptance record; it is a
credential, not a setting.

If the vision model call fails or times out for any reason — no credential,
rejected auth, a bad response shape, a timeout — the relay does not guess.
`server/vision.ts`'s `describe()` returns `null` on every failure path, and the
caller speaks "我看不清。" rather than a fabricated description.

## Running

`rdk/provision.sh` creates `/etc/max/agent.env` (mode `0600`, owner root, from
prompted or environment values, secrets never echoed or put on a command line),
the private state directories, the watchdog config and the unit files and
hardening drop-ins. `rdk/deploy.sh` then ships the code. Both are described in
"Deploying" below. The file they write looks like this (secrets elided):

```bash
MAX_RELAY_URL=wss://relay.example.com/agent
MAX_RELAY_TOKEN=                           # required once the relay has accounts
MAX_REQUIRE_TLS=on                         # refuse to start on plain ws:// to a non-loopback host
MAX_RELAY_INSECURE_TLS=0
# Durable per-board identity; preserve across upgrades.
MAX_DEVICE_ID_FILE=/var/lib/max/device-id
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
# MAX_VISION_LISTEN=all                    # bench server on every interface; default is 127.0.0.1
MAX_VISION_TOKEN=                          # REQUIRED to reach the HUD (8080), and 8081 if MAX_VISION_LISTEN=all, from off the board
MAX_VISION_SOCKET=/run/max/vision.sock
RDK_CAMERA_FRONT=0                         # MIPI channel; CAM1 connector
RDK_CAMERA_REAR=2                          # MIPI channel; the other connector
MAX_ADAS_SHADOW=0                          # 1 starts a ride: segments + shadow ADAS
MAX_VISION_SHARE=0                         # 1 lets camera.look frames leave the board for description
MAX_CORPUS_DIR=/var/lib/max/corpus         # where ride segments are written
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
# MAX_VOLUME_FLOOR=14                      # quietest "小声一点" level, percent (1–90); tune by ear, see Voice volume
```

Each `session.start` also carries the release's build (`gitCommit`, the first 12
characters of the `.rdk-release-sha` that `deploy.sh` stamps into `/opt/max`,
and `appVersion`, `max-rdk@<package version>`) and the link the default route
uses (`networkType`: `wifi`, `ethernet`, `cellular` or `unknown`, read from
`/proc/net/route` at each connect), so embedded runs can be told apart by build
and network in the testing statistics. A board under test can add the same QA
attribution the phones send; leave them out otherwise:

```bash
MAX_TESTER_ID=bench-2                      # who or which bench ran it
MAX_TESTER_REGION=Asia/Shanghai
MAX_TESTING_CAMPAIGN_ID=release-readiness
MAX_TESTING_TEST_CASE_ID=baseline-live-session
MAX_TESTING_RUN_ID=                        # from the release run in Admin → Testing
MAX_TESTING_ASSIGNMENT_ID=
# MAX_RELEASE_ROOT=/opt/max                # where the release and its .rdk-release-sha live
```

Both units run under `WatchdogSec=30`: the agent heartbeats while mic frames
flow, the sidecar while camera frames do, so a wedged-but-alive process is
restarted instead of impersonating a healthy one. `StartLimitIntervalSec=0`
means a service that cannot start keeps retrying every 2 s, visibly, instead
of entering systemd's permanent `failed` state. Bench work is unaffected:
stopping a service, or running the agent by hand outside systemd (no
`NOTIFY_SOCKET`), trips nothing.

**Unit files and heartbeat-emitting code must deploy together.** `deploy.sh`
installs the new unit files from the release it is activating and restarts both
services once, in the same step. Unit files with `WatchdogSec=30` pointed at
code that never sends `WATCHDOG=1` would restart healthy services every 30 s.

Only the exact string `1` enables `MAX_RELAY_INSECURE_TLS`; anything else leaves
certificate validation on.

### Relay transport: use `wss://`

The agent sends the relay token in an `Authorization: Bearer` header
(`server/auth.ts` accepts it alongside `?token=`, see `docs/protocol.md`). It is
never placed in the URL, because a query string lands in relay and proxy access
logs; a `token` pasted into `MAX_RELAY_URL` is lifted out of the URL and sent as
the header. A header does not make `ws://` private, though: over plain `ws://`
the token and the rider's microphone audio still cross the network in clear
text.

- Production and anything a rider wears: `MAX_RELAY_URL=wss://...` with a relay
  behind a trusted certificate. Leave `MAX_REQUIRE_TLS=on`: the agent then
  refuses to start (and systemd retries visibly) if the URL is `ws://` to anything
  but `localhost`, `127.0.0.0/8` or `::1`, instead of quietly streaming audio in
  the clear.
- Plain `ws://<lan-ip>:8787/agent` is acceptable only on a bench, on a LAN you
  control, with a throwaway token. Set `MAX_REQUIRE_TLS=off` (or provision with
  `--allow-cleartext`) knowingly; the agent still prints a `WARNING` at every start.
- `MAX_REQUIRE_TLS` accepts exactly `on` or `off`; any other value stops the
  agent, so a typo cannot leave it lax.

**`MAX_RELAY_TOKEN` is required against any relay that has user accounts** — the
relay refuses the `/agent` upgrade with 401 otherwise, and the client just
reconnects in a loop with no explanation. Accepts the operator `RELAY_AUTH_TOKEN`
or a `sess_…` login token. Keep `/etc/max/agent.env` at mode 600; `provision.sh`
does, and `deploy.sh` refuses to activate a release if it is not `root:root:600`.

**Two closes are final, and the agent stops reconnecting on them.** The relay
closes with **4003** when the account's voice minutes are used up — a spent
monthly allowance, a Max Cloud balance, a project's minutes limit — and would
refuse every new session the same way until that changes — and with **1008**
when it refuses this board's credentials: a `sess_…` login token that has been
signed out, revoked or expired, a `sess_…` token where the relay insists on its
own token before a board may register a device, and the other cases in the
close-code table of [docs/protocol.md](../docs/protocol.md). (A board cannot run
on a Max Cloud project at all: the relay registers no devices for Cloud project
sessions and refuses them with 1008 `device registration unauthorized`.) The
agent has the one token it read
from `/etc/max/agent.env` and no way to fetch another, so a retry could only
repeat the refusal. It stays up, so the HUD keeps answering; it writes the
cause, quoting the relay's own close reason, to the journal and to the HUD's
error line; and neither the backoff nor the rider's voice reopens the session:

```bash
journalctl -u max-agent | grep '^\[relay\]'
[relay] closed code=4003 reason=usage limit reached
[relay] voice minutes used up (usage limit reached); the relay refuses every new session until the allowance resets or the balance or limit is raised; the agent is not reconnecting: restart max-agent once it has
[relay] closed code=1008 reason=signed out
[relay] the relay refused this device's credentials: signed out; the same ones would be refused again, so the agent is not retrying; sort out what the reason names, then restart max-agent; this board's own credential is MAX_RELAY_TOKEN in /etc/max/agent.env
```

Restart `max-agent` once the minutes are back — the monthly allowance has
reset, the Max Cloud balance has been topped up, the project's minutes limit
has been raised — or after sorting out what a 1008 reason names. Every other
close — 1006, 1011, a plain 1000 — is still an ordinary drop and reconnects on
the usual backoff (1 s, doubling, up to 30 s).

Run it through systemd rather than by hand; `nohup`/`setsid` over SSH does not
reliably survive the session:

```bash
systemctl restart max-agent && journalctl -u max-agent -f
```

### Deploying

Prerequisites on the board, once (these stay manual because they are
distribution packages, see the appendix): Node 22, `alsa-utils`, a built
`rdk/aec/max-aec` and the rendered ADAS alert clips in `/opt/max` (the first
release is installed by hand; every later deploy carries them over and refuses
to proceed without them), and the AEC build tools (`g++`, `pkg-config`,
`libwebrtc-audio-processing-dev`, `libasound2-dev`) for releases that change
`rdk/aec`.

```bash
export RDK_HOST=root@board.example.com     # an ssh target; no credentials in the repository
MAX_RELAY_URL=wss://relay.example.com/agent rdk/provision.sh --dry-run
rdk/provision.sh                           # prompts for anything not in the environment
rdk/deploy.sh --dry-run                    # prints every command that would run on the board
rdk/deploy.sh
```

`provision.sh` is repeatable: an existing `agent.env` is kept (only its owner
and mode are corrected) unless you pass `--force`. It refuses a `ws://` relay to
a remote host unless `--allow-cleartext` is given, a relay URL carrying a query
string, and any token containing characters that could break out of its line in
the env file. It enables the units but does not start them: there is no code
yet.

`deploy.sh` does what the reviewed runbook did, as versioned code in
`rdk/deploy.sh` and `rdk/remote/`:

1. **Guard.** Deploys only the commit that is both `HEAD` and `origin/main`,
   from a clean tracked tree, as a full 40-character SHA. Run it after the
   matching relay SHA is live and the signed iOS build is installed.
2. **Stage** (`remote/stage.sh`). Streams `git archive` of that SHA into a new
   root-owned `/opt/max.stage-<sha>`; ignored and untracked files never travel and
   the live checkout is never mirrored over. A stage left by a failed attempt is
   removed first (the path is rebuilt from the SHA and compared exactly).
3. **Verify and build** (`remote/build.sh`). Copies the armed ADAS alert clips
   from the live release, and the native AEC executable too while
   `rdk/aec/Makefile` and `rdk/aec/src` are unchanged; a release that changes
   them gets `max-aec` compiled on the board from the staged sources. Checks
   the copies with `cmp`/`diff -qr`, then `npm ci` and `npm run build` in the
   stage. A missing AEC binary, an AEC build failure or an empty alert set
   blocks activation.
4. **Swap, prove, roll back** (`remote/activate.sh`). Checks owners and modes
   (`root:root:755` release, `700` identity directory, `600` identity file and
   `agent.env`), moves `/opt/max` to `/opt/max.previous-<sha>-<timestamp>` and the
   stage into place, installs the release's unit files and drop-ins, and restarts
   once (vision, then agent). Success means: a new, nonempty `InvocationID`, that
   invocation's own journal containing `[relay] session ready`, the agent still on
   that invocation, `max-vision` still on its new invocation after a settle
   window (45 s by default, which covers camera acquisition; `--vision-settle`),
   and an unchanged device identity digest (never printed). If the relay session
   never becomes ready but the agent is running and its own log shows it retrying
   the relay (`[relay] socket error:`, `closed code=`, `reconnecting in` or `idle
close`, and no `[agent] uncaught exception`/`unhandled rejection`), the release
   **stays** and the script exits 3 with a warning: a good release is not rolled
   back because the relay or the network is down.
5. **Automatic rollback.** If anything after the swap fails, the failed release is
   moved to `/opt/max.failed-<sha>-<timestamp>`, the previous release and its own
   units and drop-ins are restored, and the same proof runs again. Exit status 1
   means "rolled back and proven"; 2 means the rollback could not be proven and the
   board needs the manual steps below. During a rollback, relay readiness is only a
   warning. Once activation starts, all of its output goes to
   `/opt/max.activate-<sha>.log` (0600) and its outcome is written last to
   `/opt/max.activate-<sha>.status` (`activated`, `activated-relay-unreachable`,
   `rolled-back`, `rollback-failed` or `refused`, then the SHA). The script ignores
   `SIGHUP` and `SIGPIPE` and never writes to the ssh channel, so a dropped session
   can neither strand a half-finished swap nor cancel the rollback; `deploy.sh`
   reads the status and prints the log, reconnecting if it has to ("connection lost;
   board says: ..."). `deploy.sh` exits 0, 1, 2 or 3 with the same meanings. Exit 3 with
   `closed code=1008` in the log usually means the relay token on the board is wrong
   or was rotated. Only one activation runs at a time: it holds the lock directory
   `/opt/max.activate.lock` (PID and boot id; a holder that was killed is detected
   and the lock reclaimed, so it cannot go stale), and `deploy.sh` refuses to start
   or delete anything while it is held. A leftover `started` status with no live
   holder is reported as "interrupted; the board is on release X". If the status
   file cannot be written (full disk), `deploy.sh` falls back to the script's exit
   status plus the active release. The five most recent log/status pairs are kept;
   older ones are removed after a successful run. So are release trees: a
   successful activation keeps the previous release it just moved aside and the
   newest `/opt/max.failed-*`, and removes older `/opt/max.previous-*` and
   `/opt/max.failed-*` directories (only exact canonical names, never a symlink),
   which otherwise filled the board's storage one release at a time. A rolled-back
   activation removes none.

`deploy.sh --no-hardening` installs no drop-ins and removes any installed earlier.
Re-running for the commit that is already active does nothing. Keep the previous
release directory until acceptance is complete. Never print the device ID, pairing
code, location payload, or `/etc/max/agent.env`.

The restart differs from the old runbook in one respect: it restarts `max-vision`
as well as `max-agent`. The old steps replaced `/opt/max` under a still-running
sidecar, which kept executing the previous release's code (its working directory
moves with the rename), and a drop-in only takes effect on restart.

#### Appendix: manual steps

Each board-side step is a plain script, so it can be run by hand when the
automation itself is what is broken. Arguments are the same ones `--dry-run`
prints.

```bash
ssh "$RDK_HOST" bash -s -- "/opt/max.stage-$SHA" "$SHA" < rdk/remote/stage.sh
git archive "$SHA" | ssh "$RDK_HOST" "tar -xf - -C '/opt/max.stage-$SHA'"
ssh "$RDK_HOST" bash -s -- "/opt/max.stage-$SHA" "$SHA" < rdk/remote/build.sh
```

Manual rollback, when `activate.sh` exits 2 or you must go back later. The
previous directory is the entire former release, including the exact AEC
executable and armed alert clips. Preserve `/var/lib/max/device-id` and `/etc/max`;
never copy an identity from another board:

```bash
PREVIOUS='/opt/max.previous-<sha>-<timestamp>'   # the one activate.sh printed
mv /opt/max /opt/max.failed && mv "$PREVIOUS" /opt/max
install -m 0644 /opt/max/rdk/systemd/*.service /etc/systemd/system/
rm -f /etc/systemd/system/max-*.service.d/hardening.conf   # re-add from /opt/max if it ships them
systemctl daemon-reload && systemctl restart max-vision max-agent
journalctl -u max-agent -f      # expect: [relay] session ready
```

Packages the scripts do not install:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs alsa-utils python3-pip
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

**`max-vision` refuses to run camera-less — or short of a detected camera.**
If `open()` ends with zero cameras, or with fewer cameras than i2c detected,
the service exits and systemd retries every 2 s until every attached sensor
streams. Both halves were bought with a real boot each. 2026-07-31: the sidecar
came up seconds after power-on, `discover()` saw an empty bus, and the service
ran blind until a human restarted it. 2026-08-01: i2c saw the front OV5647 but
its open stalled in the ISP (the documented OV5647 flake), and the sidecar
served rear-only for a whole boot — the staleness monitor stayed quiet because
the topic collision (see "Two cameras need two topics") kept the front buffer
fresh on rear frames. An empty connector is still fine — front-only is normal
here. A deliberately camera-less bench will crash-loop visibly — stop the
service instead of running it blind.

**Voice shutdown — "Max，关机".** Arms a 10 s countdown on the board: a
triple beep when armed, a short tick every 2 s, one long low tone, then
`shutdown -h now` — the clean stop, so max-vision finalizes a live recording
and the filesystems unmount instead of another dirty FAT mount. "取消关机"
(also 别关机 / 不要关机) cancels it with a rising tone pair. The tones are
synthesized on the board and go through `playback.write` (limiter, pacing,
AEC reference — never a separate aplay), so they need no TTS credentials and
cannot be faked by model chatter; until `DOUBAO_TTS_*` lands on the relay
they are the only honest channel, since the deterministic "好的，10秒后关机"
line is as inert as every other one. The relay dispatches `system.shutdown`
to the embedded platform only — a phone never receives it. After the final
tone, give the board ~15 s before cutting power.

**Voice volume — "Max，大声一点" / "小声一点".** Moves the ALSA `Playback`
level of the card `RDK_ALSA_PLAYBACK` names: the agent reads it with
`amixer get`, steps it, and writes it back with `amixer sset`. Playback has
seven levels spread evenly from a floor to full — by default the quietest is one
seventh of the range (about 14%) — and the phones keep an audible floor too
(iOS `PlaybackVolumeController`, Android `nextVoiceGain`), so a board at full
takes six "小声一点" to reach the quietest. It never reaches zero: Max,
navigation prompts and spoken hazard alerts all play through this control. One
more step at either end changes nothing and is reported as a failure, so Max
never announces a change nobody can hear, and a mixer that cannot be read is
not stepped. The levels are not matched to the phones by loudness: the codec's
percent-to-decibel curve is not in this repository. Tune the floor by ear on a
real board, with road noise in mind: set `amixer sset Playback 14%` (or
another value), play a navigation prompt in a running helmet, and put the
quietest value a rider can still hear in `MAX_VOLUME_FLOOR` (a percent, 1–90)
in the agent's environment file; the other six levels spread above it.

## Service hardening

Both services run as root. A bug in the HUD (8080), the bench server (8081) or
the vision code would otherwise be a root compromise of a device worn on a
rider's head. `rdk/systemd/max-agent.service.d/hardening.conf` and
`max-vision.service.d/hardening.conf` are systemd drop-ins that narrow that
without touching the units' `Restart=`, watchdog and start-limit settings.
`provision.sh` and `deploy.sh` install them (`--no-hardening` skips them).

None of this could be tested on a board when it was written. The drop-ins
therefore contain only directives justified by the inventory below, and the
acceptance checklist after it is how you prove them on the hardware.

### Service inventory

Derived from the code, not measured on the board. "Unverified" means the
repository cannot answer it and the board must.

**`max-agent`** (`tsx rdk/agent/src/main.ts`, as root)

| Need            | What the code does                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes          | `/var/lib/max` only: `device-id` and its lock/marker files, `hud-wifi-bond.json`, `hud-bluetooth-bond.json` (all `0600` under a `0700` directory). `/tmp` for tsx's cache. `MAX_AEC_DUMP` writes wherever it points, but is off by default. |
| Reads           | `/etc/max/agent.env` (read by systemd), `/opt/max` (code, `node_modules`, `rdk/aec/max-aec`, `rdk/audio/alerts`), `/run/max/vision.sock`, `/proc/<pid>`, `/proc/sys/kernel/random/boot_id`.                                                 |
| Devices         | ALSA via child processes: `arecord`, `aplay`, `amixer`, `max-aec` on `plughw:0,0` (`/dev/snd/*`, group `audio` for a non-root user).                                                                                                        |
| Listens         | TCP `MAX_HUD_PORT` (8080) on all interfaces: the HUD and the phone's `/cast` upload. UDP 5353 multicast (mDNS `_maxhelmet._tcp`).                                                                                                           |
| Connects        | TCP/TLS to the relay; HTTPS to the weather and map services from the HUD cast; the system D-Bus socket (`busctl` to `org.bluez` for phone music); `systemd-notify` for the watchdog.                                                        |
| Other processes | `ps`, `busctl`, `systemd-notify`, and `/usr/sbin/shutdown -h now` for "Max，关机", which needs real privilege.                                                                                                                              |

**`max-vision`** (`python3 service.py` under the TROS environment, as root)

| Need            | What the code does                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes          | `/var/lib/max/gallery` (captures, manifests), `/var/lib/max/corpus` (ride segments and shadow logs, ~3 MB/s), `/run/max` (`RuntimeDirectory=`: `vision.sock`, `roslog/`), `/tmp`. Anything the vendor ROS/DDS and camera libraries write is **unverified**.                                                         |
| Reads           | `/opt/max/rdk/vision`, `/opt/tros/humble` (sourced in `ExecStart`), the BPU model under `/app/multimedia_samples/...`, `/sys/firmware/devicetree/base/soc/cam/vcon@N`, `/etc/max/agent.env` (by systemd).                                                                                                           |
| Devices         | `/dev/vs-isp0_cap` (the ISP node `fuser` reaps orphans from), i2c buses 4 and 6 through `i2cdetect` (`/dev/i2c-*`), and the camera, VIO, ION and BPU nodes that `mipi_cam` and `hobot_dnn` open on its behalf: **their names are not in the repository**. DDS shared memory under `/dev/shm` is likely, unverified. |
| Listens         | TCP `MAX_VISION_PREVIEW_PORT` (8081), `127.0.0.1` unless `MAX_VISION_LISTEN=all`; the unix socket `MAX_VISION_SOCKET`. ROS 2 DDS discovery (UDP, unverified).                                                                                                                                                       |
| Other processes | `ros2 run mipi_cam` (own session), `fuser`, `i2cdetect`; `ffmpeg` only in the replay tools.                                                                                                                                                                                                                         |
| Environment     | `HOME=/root` (ROS wants one), `ROS_LOG_DIR=/run/max/roslog`, `source /opt/tros/humble/setup.bash`.                                                                                                                                                                                                                  |

### What the drop-ins do

| Directive                             | Agent                                     | Vision      | Why it cannot cost the service anything it needs                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoNewPrivileges`                     | yes                                       | yes         | Neither service runs a setuid helper or `sudo`; both already are root.                                                                                                                                          |
| `PrivateTmp`                          | yes                                       | yes         | Nothing in the code shares `/tmp` across the two services or with a person; the socket lives in `/run/max`. rclpy and `mipi_cam` are in the same service, so they share the private `/tmp`.                     |
| `ProtectHome`                         | `true`                                    | `read-only` | Nothing in the agent touches `/root` or `/home`. The sidecar's unit sets `HOME=/root` for ROS, so `/root` stays readable there but not writable: the one vision directive that could bite, see the camera step. |
| `ProtectSystem`                       | `strict` + `ReadWritePaths=-/var/lib/max` | `full`      | The agent writes only `/var/lib/max` (and `/tmp`). The sidecar's unverified vendor writes make `strict` unsafe to assume, so `/usr`, `/boot` and `/etc` go read-only and the rest stays as it was.              |
| `ProtectKernelTunables`               | yes                                       | **no**      | No `/proc/sys` or `/sys` writes in the agent. Vendor camera/ISP libraries may write `/sys`, so the sidecar keeps it.                                                                                            |
| `ProtectControlGroups`                | yes                                       | yes         | Nothing manages cgroups.                                                                                                                                                                                        |
| `RestrictSUIDSGID`, `LockPersonality` | yes                                       | yes         | No setuid files are created; no `personality(2)` use in Node or Python.                                                                                                                                         |
| `MemoryMax=75%`                       | yes                                       | yes         | A runaway ceiling, not a budget: no footprint has been measured. Each service may use three quarters of RAM, far above anything a voice agent or the sidecar plus 1080p buffers should reach.                   |

Left out on purpose, because each could remove access the helmet needs and none
can be proven without the board: `User=`, `DeviceAllow=`/`DevicePolicy=`,
`CapabilityBoundingSet=`, `RestrictAddressFamilies=`, `MemoryDenyWriteExecute=`
(V8 needs a JIT), `ProtectKernelTunables` for vision, `ProtectSystem=strict`
for vision, and `PrivateDevices=` (hides `/dev/snd` and the camera nodes).

### Next step: a non-root user and a device allow-list

Do this only after the acceptance checklist below passes with the current
drop-ins, one service at a time, on a bench board:

1. List what the running service actually has open (cgroup v2):
   ```bash
   for p in $(cat /sys/fs/cgroup/system.slice/max-vision.service/cgroup.procs); do
     ls -l /proc/$p/fd; done | grep -E ' /(dev|sys|proc)/' | awk '{print $NF}' | sort -u
   ```
   Run it during a photo, a recording and a shadow ride, for both services. That
   list, not the guesses above, is the device allow-list.
2. `stat -c '%U:%G %a %n' <each node>` to find the groups (`audio`, `video`,
   `i2c`, vendor groups) a `max` user needs as `SupplementaryGroups=`.
3. Add a trial drop-in `99-user.conf` with `User=max`, the groups, and
   `StateDirectory=`/`RuntimeDirectory=` ownership, then rerun the whole
   checklist. `shutdown` and `busctl` to bluez need polkit rules for that user.
4. Only then add `DevicePolicy=closed` with one `DeviceAllow=<node> rw` per node
   from step 1. A denied device is silent in the journal, so a camera that
   will not open after this step means a node is missing from the list.
5. Measure `systemctl show max-agent max-vision -p MemoryPeak` (or
   `systemd-cgtop -n 1`) after a long ride and set `MemoryMax=` to a few times
   the peak.

### On-board acceptance checklist

Run on the board after `deploy.sh` (or `provision.sh` plus a deploy), on the
bench, with the headset on. Do not accept a release for riding until every step
passes. Record `pass`/`fail` only; never paste tokens or `agent.env`.

```bash
# 1. The drop-ins are applied, and nothing is crash-looping.
systemctl show max-agent max-vision -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p MemoryMax
systemctl is-active max-agent max-vision
systemctl show max-agent max-vision -p NRestarts          # expect NRestarts=0 for both
journalctl -b -u max-agent -u max-vision --no-pager | grep -iE 'read-only file system|permission denied|EROFS|EACCES' || echo 'no sandbox denials'

# 2. Ports: HUD on all interfaces, bench server on loopback unless MAX_VISION_LISTEN=all.
ss -ltn | grep -E ':(8080|8081) '
curl -s -o /dev/null -w 'hud %{http_code}\n' http://127.0.0.1:8080/
curl -s -o /dev/null -w 'bench %{http_code}\n' http://127.0.0.1:8081/gallery   # expect 200
```

3. **Audio in and out.** Say "Max，现在天气怎么样" into the headset and hear a spoken
   reply; interrupt mid-sentence and it stops. This exercises capture, `max-aec`,
   playback and `amixer` under the sandbox. `journalctl -u max-agent | grep -E 'relay\] session ready|max-aec'`.
4. **Camera.** `journalctl -b -u max-vision | grep -E '\[vision\] (front|rear):'`
   shows a line per attached camera, and no `camera unavailable`. Say "拍照": a new
   `pair-*` directory appears under `/var/lib/max/gallery`. If the camera will not
   open only with the drop-in, suspect `ProtectHome=read-only` (a vendor library
   writing under `/root`) first, then `ProtectSystem=full`.
5. **ROS from outside.** `source /opt/tros/humble/setup.bash && ros2 topic list`
   from an ssh session still lists the camera topics (the private `/tmp` must not
   have hidden DDS state from other tools).
6. **HUD.** Open `http://<board>:8080/?t=<token>` from a laptop: the page loads; the
   same URL without `?t=` answers 401. With the default loopback bench server the
   camera and gallery panels need the SSH forward in "On-hardware verification";
   they work from the LAN only with `MAX_VISION_LISTEN=all`.
7. **Watchdog.** Heartbeats still reach systemd under `NoNewPrivileges`:
   ```bash
   sleep 90; systemctl show max-agent max-vision -p NRestarts -p WatchdogTimestamp
   ```
   `NRestarts=0` after 90 s (the watchdog is 30 s) means both are heartbeating. Then,
   on the bench only, prove a wedged process is still restarted:
   ```bash
   old=$(systemctl show -p InvocationID --value max-agent)
   kill -STOP "$(systemctl show -p MainPID --value max-agent)"; sleep 45
   test "$(systemctl show -p InvocationID --value max-agent)" != "$old" && echo 'watchdog restarted it'
   ```
8. **Shutdown.** Say "Max，关机" and let the countdown finish: the board powers off
   cleanly (this is the `ProtectSystem=strict` path of `shutdown -h now`). Power it
   back on and confirm steps 1 and 3 again after the reboot.

**If any step fails, remove the drop-ins with one command and restart:**

```bash
sudo rm -f /etc/systemd/system/max-agent.service.d/hardening.conf /etc/systemd/system/max-vision.service.d/hardening.conf \
  && sudo systemctl daemon-reload && sudo systemctl restart max-vision max-agent
```

That restores the pre-hardening behaviour exactly (the units themselves are
unchanged). `rdk/deploy.sh --no-hardening` does the same on the next deploy. Then
report which step failed and its journal lines; the likely culprit is named in
the step.

## On-hardware verification

With `npm run dev:server` running on the LAN host:

**Voice**

1. `systemctl start max-agent`, then `journalctl -u max-agent -f` — expect
   `[relay] session ready`.
2. Say "Max，现在天气怎么样" into the headset and hear a spoken reply.
3. Interrupt a reply mid-sentence; speech must stop within ~120 ms.
4. Unplug and replug the headset; the service recovers without a restart.

**iPhone companion pairing — discovery and fallback paths**

Unpaired boards broadcast a rotating, secret-free discovery token via mDNS under `_maxhelmet._tcp` (TXT record `dt=<token>`). The iOS app scans Bonjour on the pairing screen, lists nearby helmets by discovery beacon, and pairing completes with a spoken prompt at the helmet ("检测到配对请求，请说"确认"。" — a rider confirms by saying 确认). The HUD's 配对广播 status line shows whether discovery is live; a `discovery: off` line while unpaired means both transports failed — check the journal for `[discovery]` lines. The six-digit code path (HDMI HUD / SSH forward) remains unchanged as fallback, useful when Bonjour is blocked or after network loss.

**iPhone companion navigation**

1. With Helmet Ride stopped, read the six-digit code from the board-local Chromium/HDMI HUD. For
   remote administration, make an authenticated SSH local forward and open `http://127.0.0.1:8080`:

   ```bash
   ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 root@<board>
   ```

   **Forward both ports, onto the same numbers.** The page asks the browser for `<host>:8081`, so
   the earlier `-L 18080:127.0.0.1:8080` gave you the HUD with dead camera and gallery panels —
   the browser went looking for `127.0.0.1:8081` and found nothing. Verified 2026-08-11.

   The forward needs no bench token, because it arrives on the board as loopback, and it is the
   _only_ route that shows the code: redaction keys off the peer address, so a direct LAN browser
   at `http://<board>:8080/?t=<token>` is admitted and still intentionally cannot see the code or
   its expiry. Do not put the code in a terminal command, journal, screenshot, or acceptance
   document.

2. Pair from the signed-in iOS app and confirm the HUD reports ready before starting the ride.
3. Run the locked-screen navigation, loss/resume, ADAS-preemption, second-route, and privacy
   checks in [`../docs/rdk-ios-companion-acceptance.md`](../docs/rdk-ios-companion-acceptance.md).

**Cameras**

1. `systemctl start max-vision` with `MAX_VISION_SHARE=1`, then open
   `http://<board>:8081/preview/front?t=<token>` and `/preview/rear?t=<token>`
   — both show live video. Without the token: `401`. With
   `MAX_VISION_SHARE=0`: `403`, and the HUD's camera panels stay dark.
2. Say "拍照" — a `pair-*` directory appears under `/var/lib/max/gallery` with
   two JPEGs and a manifest.
3. Say "开始录像", wait, then "停止录像" — two `.mjpeg` segments and a manifest
   stamped with the clip's duration and achieved fps.
4. Say "开始录像" twice — Max says "已经在录了。"
5. `systemctl stop max-vision`, then say "拍照" — Max reports a truthful failure
   and the voice session keeps working.
6. In the HUD's captures grid, click the clip — it replays in the page, at
   ½×/1×/2×. Delete a scratch capture and watch the free-space readout move;
   deleting the clip _while_ it records must be refused.

**Dev HUD**

Open `http://<board>:8080/?t=<token>` from a laptop, or Chromium kiosk on the board's HDMI (which is
loopback and needs no token). Start a session and confirm turn state, transcript, navigation,
latency, captures, and both previews update live.

Two independent boundaries apply, and they answer different questions. The **token** decides whether
a peer is served at all: without it a non-loopback browser gets `401` on both the page and the
WebSocket upgrade. **Peer address** decides how much a served client sees: the direct-LAN WebSocket
is deliberately a redacted status surface, receiving the non-secret fields but never `pairingCode` or
`pairingExpiresAt`. Holding the token gets a stranger in; it does not make them local. Only a TCP
peer accepted from the board's IPv4/IPv6 loopback—such as the local kiosk or an authenticated SSH
local forward—receives the full pairing state. `Origin`, `Host`, forwarding headers, URL parameters,
and WebSocket client messages do not change that second decision.

## Known gap

Recordings are concatenated-JPEG `.mjpeg`, not H.264. The recording itself
works — dual 1080p at a measured 9.8 fps (per-side encodes run in parallel;
cv2 releases the GIL, so two ~60–100 ms encodes cost max() rather than sum()) —
but per-frame JPEG cannot exploit inter-frame redundancy, so it costs roughly
10 GB per hour per camera where H.264 would cost ~1.8 GB. The H.264 path needs
the ctypes binding (`camera_binding.py`), and `hbn_camera_create` still returns
-1 for every sensor and VCON tried — that is the actual gap. The recording
state machine, space guard, ten-minute cap, manifest truth (duration + achieved
fps), and per-side accounting are implemented and covered by
`tests/test_camera_policy.py`; if the binding ever opens, switch the segment
writer without changing the state machine.

## Running the Python suite

The hardware-independent vision and ADAS suite runs on macOS, Ubuntu, CI, and
the board. It uses Python 3.10, the same version supplied by Ubuntu 22.04 on the
RDK image. Camera, ROS/ISP, and BPU libraries are not imported by this suite.

Install macOS prerequisites and create the local environment:

```bash
brew install python@3.10 ffmpeg
/opt/homebrew/bin/python3.10 -m venv .venv  # Apple Silicon
# On Intel Homebrew, use /usr/local/bin/python3.10 instead.
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r rdk/vision/requirements-dev.txt
```

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y python3.10-venv ffmpeg
python3.10 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r rdk/vision/requirements-dev.txt
```

Run every hardware-independent test from the repository root:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run test:rdk-vision
```

The command treats missing NumPy, OpenCV, FFmpeg, or `ffprobe` as a failure. It
skips only tests explicitly marked `hardware`, and strict marker checking makes
a misspelled marker fail collection.

The deployed board already has NumPy, OpenCV, pytest, FFmpeg, and Node. After
syncing the checkout to `/opt/max`, run the same gate there:

```bash
cd /opt/max
npm run test:rdk-vision
```

Real camera and BPU validation stays separate because CI cannot emulate the
hardware. `tests/test_hardware_smoke.py` is the on-board smoke test: every test in
it is marked `hardware`, so the command above deselects it (`pytest` reports
`5 deselected`), and on a machine without the vendor stack it skips with the
missing module's name instead of passing. Any other pytest that opens the camera,
ROS/ISP or the BPU must use `@pytest.mark.hardware` too.

On the board, with the TROS environment sourced:

```bash
source /opt/tros/humble/setup.bash
cd /opt/max
systemctl stop max-vision        # one process may hold a camera
python3 -m pytest -c rdk/vision/pytest.ini -m hardware --strict-markers \
  rdk/vision/tests/test_hardware_smoke.py -v -k 'not control_socket'
systemctl start max-vision       # the socket test needs the running sidecar
sleep 30
python3 -m pytest -c rdk/vision/pytest.ini -m hardware --strict-markers \
  rdk/vision/tests/test_hardware_smoke.py -v -k control_socket
```

It checks that a camera opens and yields a full-size NV12 frame and keeps
yielding them, that the model loads with three detection heads, that one inference
returns boxes inside the unit square, and that the control socket answers
(an unknown op is answered `unsupported`; nothing is captured or changed).
`MAX_VISION_MODEL` overrides the model path; a missing model skips rather than
fails. These do not replace `tools/check_anchors.py`, which proves the box decode
is correct against a known image.

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

An alert can carry `segment=""` — SegmentClock's sentinel for "the recorder
had nothing open for that camera at alert time", so there is no video to cut.
`clip.py` says exactly that (fixed 2026-08-01; the bare path join used to
resolve the sentinel to the segments _directory_, and ffmpeg failed on it in
its own words).

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

Preemption is by severity, and voice never preempts (decided 2026-08-01). The
priority hold carries a rank (`caution` = 1 < `critical` = 2): a strictly
higher-severity alert cuts the playing clip's tail — a forward-collision
warning must not queue behind a caution clip, because that tail spends exactly
the seconds the critical alert exists to buy. Equal severity queues, so
back-to-back criticals cannot cut each other's first syllable. A rider saying
"什么?" mid-warning still cannot cancel anything: voice flushes carry no rank,
and an unrecognised severity string sinks to `caution` so it can never outrank
a real critical.

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
- **Anything on a real road.** (As built, 2026-07-26 — since overtaken: both
  cameras now stream, shadow rides have run live, and the first labelled ride
  scored by `tools.evaluate` is the exit into tuning. See the findings table
  and "Recording a tuning corpus".)
- **That the TTS call works.** Unverified — see above.

`rdk/vision/adas/catalog.py` duplicates the spoken strings across the
Python/TypeScript boundary by design (the board must not parse TypeScript at
runtime). Since 2026-07-30 the catalog is aligned with `shared/adas.ts` —
`pedestrian_ahead` and `tailgating` included — and
`tests/test_catalog_drift.py` fails the board suite if either side drifts, so
this is no longer kept in step by hand.

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

**Stop the sidecar first:** `systemctl stop max-vision`. Exactly one process
may hold a given camera, so a recorder and a running max-vision cannot both
have the same sensors.

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
preview lives there, that image bytes never pass through the agent. Clicking a
tile opens a viewer: photos full-size, recordings replayed in the page, both
sides when both recorded, with download links, ½×/1×/2× playback speed,
older/newer navigation, and delete. The captures header shows free space
against the `MAX_GALLERY_MIN_FREE_MB` floor, because deletion is how space
comes back.

| Route                              | Returns                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /gallery`                     | every capture, newest first by capture time (the manifest's mtime, not the pair id), with sizes, capture time, video duration, and disk space against the floor                                                                                                                                                       |
| `GET /gallery/<pair>/<file>`       | the bytes; a `.mjpeg` downloads as an attachment                                                                                                                                                                                                                                                                      |
| `GET /gallery/<pair>/<file>/thumb` | the first frame of a recording                                                                                                                                                                                                                                                                                        |
| `GET /gallery/<pair>/<file>/play`  | the recording replayed as `multipart/x-mixed-replace` — the stream preview already uses, so a plain `<img>` plays it. Default pace is the clip's own recorded rate (the manifest's `fps` stamp); `?speed=` (0–4, default 1) multiplies it, capped at 30 fps; `?fps=` (1–30, float) remains an exact absolute override |
| `POST /gallery/<pair>/delete`      | removes the whole pair; `409` while it is still being written, `404` for anything that is not a capture                                                                                                                                                                                                               |

Playback re-streams the file rather than transcoding it: an ffmpeg pass per
view is heat and RAM this board does not have (a shadow ride plateaus near
90 °C), and the multipart walk holds one frame in memory at a time however
large the clip — the same rule that keeps a thumbnail from costing 835 MB.
The stream simply ends with the file; a clip still being written plays what is
on disk so far and stops.

**The gallery does not trust the boot clock** (fixed 2026-08-01, after a clip
recorded one minute after power-on filed itself at the bottom of the grid
dated 01-01 08:01). This board has no RTC, so a capture started before NTP
lands gets a `pair-20000101-…` id; NTP steps the clock before the manifest is
finalised, so the file's mtime carries the truth the id lost. Two rules
follow: the listing orders by the **manifest's mtime** (`Gallery.list_pairs`),
and the tile's capture-time label falls back to that mtime whenever the id's
stamp predates `ID_CLOCK_FLOOR` (2026 — nothing in this gallery is older).
The floor is deliberate where an id-vs-mtime comparison would be wrong:
copying a gallery resets mtimes, and a sane id must keep naming the copied
capture's true start rather than its copy date. The directory name keeps its
fake-epoch spelling — `reconcile()` and copies tolerate it, and renaming a
capture under a live gallery is risk with no payoff.

**Delete trusts the LAN, and that is a decision, not an oversight.** An
earlier version of this section kept the page read-only because the surface is
unauthenticated on `0.0.0.0`, and clearing space meant `rm` over SSH. That
traded the wrong way: a ten-minute clip is ~1.7 GB against a 1 GB floor, so
deletion is routine, and the one client with the gallery in front of it could
not do it.

This route used to be unauthenticated, on the reasoning that a token would be
theater: the page embedding it was itself served to anyone on the LAN who
asked, so the token was never a secret. That reasoning ended with its premise —
**as of 2026-08-11 the whole bench surface authenticates at once**, the page
included, which is exactly the condition the old note said would be required
(see "Bench access — `MAX_VISION_TOKEN`"). Without the token a delete is a
`401` and nothing is removed; that closes the drive-by case, where a plain
cross-origin `POST` from any page the rider visited on the same network needed
no token, no header, and no reply it could read in order to destroy a capture.

What the route guarantees beyond that: the unit is the whole pair directory
(deleting one side would leave a manifest claiming media that is gone — the
broken-tile state `reconcile()` exists to repair), only a directory holding a
manifest directly under the gallery root can be named (the same resolved-path
rule as reads), a live recording is refused with `409` until it is stopped, and
a capture is the _only_ thing the route can remove.

Any path resolving outside the gallery root is a `404`. The sidecar runs as
root, so that check is a security boundary, not tidiness — see
`bench_server.safe_path`. Verify it with `--path-as-is`, or curl normalises the
`..` away client-side and proves nothing:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --path-as-is \
  "http://<board>:8081/gallery/../../../etc/shadow?t=<token>"   # must be 404
```

Run it _with_ the token: without one the answer is `401`, which proves the
token gate and says nothing about `safe_path`. Two boundaries, two checks.

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
since exactly one process may hold a given camera, `tools/record_ride.py`
cannot supply that while the sidecar has the cameras. The sidecar records instead.

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
enough that a second camera or a warm day should be measured, not assumed. The
encode-sharing fix measured this same single-camera shadow-ride plateau at
~87.6 °C on 2026-07-30 (see the findings table); the pre-fix ~94 °C figure
above still stands as the conservative planning number until it too is
re-measured with two cameras.

### The board dies hard, and it is not the software

Reported as "the RDK crashes very often". Investigated 2026-07-29; what the
board's own records say:

- **Nothing is logged.** The journal for each short boot simply stops
  mid-sentence. Across the last four boots there is not one shutdown marker
  (`Reached target Shutdown`, `Powering off`, `systemd-shutdown`), and the next
  boot reports `FAT-fs (mmcblk0p1): Volume was not properly unmounted`. That is
  power loss or a hard hang, not a clean reboot.
- **Not a panic.** `/sys/fs/pstore` is empty and no `Kernel panic` /
  `Unable to handle` appears in any retained boot.
- **Not the OOM killer.** No `oom-kill` or `Killed process` in any boot;
  ~2.2 GB of 3 GB stays available with a recording running.
- **Not thermal.** The CPU zone's critical trip is 110 °C. A 5-minute recording
  peaked at **53.6 °C** with the throttle state at 0 the whole time — nowhere
  near the 94 °C a shadow ride reaches, let alone the trip.
- **Not the watchdog.** `dw_wdt` exists but nothing holds `/dev/watchdog`, and
  systemd's `RuntimeWatchdogUSec` is 0.
- **Not the storage.** eMMC `life_time` is `0x01 0x01`, `pre_eol_info` `0x01`,
  and no I/O errors are logged.

**Recording alone does not do it.** A 5 min 13 s / 890 MB clip ran past the
~4.5-minute mark where earlier boots died, and the board stayed up and cool.

What the dead boots had that this test did not is a **live voice session**: the
last lines before boot −2 stopped are `max-aec` frames and
`[audio] barge-in confirmed by the mic`, i.e. mic capture, speaker playback and
AEC all running while the 835 MB clip was being written.

So the evidence points at **power**, not code: the amplifier driving a speaker,
plus sustained ~3 MB/s eMMC writes, plus the camera ISP and Wi-Fi, on a supply
that cannot hold up. Confirm it on the bench before changing anything else —
a USB power meter inline with the supply, or simply a known-good 5 V/4 A brick
and a short, thick cable, will settle it in one ride. Nothing in this repo can
fix a brown-out; what the software now guarantees is that a clip interrupted by
one is still in the gallery afterwards.

**The deaths are current, and they track load.** After a quiet stretch that
briefly implicated the old power path, the board hard-died during a live voice
session on 2026-07-30, three more times in ~13 minutes on 2026-07-31, and again
on 2026-08-01 under full board pytest + both cameras + agent — every one the
same signature (journal stops mid-sentence, dirty FAT mount on the next boot).
The meter A/B stays the definitive step and a beefier supply is overdue. Until
then, "Max，关机" (see "Voice shutdown") makes clean power-off the easy path.
One unrelated find from the 2026-08-01 post-mortem: the board's desktop session
had a Firefox content process holding ~900 MB — on a 4 GB board, close the
desktop browser before benching anything heavy.

**Reading the journal on this board is its own trap.** There is no RTC: every
boot starts with the clock months wrong and NTP steps it later, so early-boot
entries are stamped with a bogus date, `journalctl --since` windows silently
miss them, `-u <unit> -b` can return nothing for a running service, and
`systemctl status` shows nonsense start times. Query by boot id
(`journalctl --list-boots`), stream live with `journalctl -f`, or grep the
whole journal for `\[vision\]` / `max-aec` instead of trusting timestamps.

A ride that logs no alerts is not evidence of a broken pipeline. Replay the
ride's own segment (`python3 -m tools.replay <segment> --camera front`) — if it
also reports 0 alerts, the scene simply had no hazards. That is how the first
live ride was verified: 237 frames, 0 alerts, both live and on replay.

Because `mipi_cam` publishes decoded frames (on `/<camera>/image_raw` — see
"Two cameras need two topics"), the recorder JPEG-encodes them, so a segment is
concatenated JPEG rather than an H.264 stream. `corpus/library.py` accepts both.

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

Board-verified:

- `cam-service` survives a failed camera open (previously any open crashed it)
- both cameras report unavailable with a specific reason and the CLI exits cleanly
- a per-node rclpy executor, without which two cameras raise
  `ValueError: generator already executing`
- **a recording that actually captures frames** (2026-07-29): a 5 min 13 s clip
  wrote 890 MB at a measured **2.84 MB/s**, front camera only, and stopped
  cleanly into a listable gallery entry.

**The OV5647 does stream.** An earlier note here said it produced zero frames
under the vendor's own `mipi_cam` and that no source could record from it. That
is no longer true of this board: on 2026-07-29 `max-vision` was running
`video_device:=OV5647` on channel 0 and served both photos and a multi-minute
recording from it. IMX219 remains the better-characterised part; OV5647 is not a
blocker.

### A recording is described from its first frame, not from its stop

`stop_recording()` used to be the only place a `manifest.json` was written, and
`Gallery.list_pairs()` skips a directory that has no manifest. So a clip the
board died partway through was invisible in the gallery **forever** — the rider
heard "开始录像。", the bytes were on disk, and nothing ever listed them.

Measured on the board: `pair-20000101-080114/front.mjpeg` held **835 MB** with no
manifest, last written at 21:11 on 2026-07-28, which is the minute the boot it
belonged to ended. A second directory held nothing at all.

The manifest is now written when recording starts, carrying `"recording": true`,
and finalised on stop — stamped with a wall-clock `duration_s`, because the
writer measurably falls behind the nominal 10 fps and frames ÷ fps would
understate how long the rider actually recorded.

The stop also stamps **`fps`, the rate the writer actually achieved** (frames
written ÷ duration), and playback paces from it. This closed a real
discrepancy: an 8 m 19 s ride (498.5 s, 1820 frames — 3.65 fps under the
flicker-era CPU load) played back in ~3 minutes at the assumed nominal 10 fps,
so the rider saw "8 minutes" in the gallery label and ~3 minutes of timelapse
on screen — both describing the same file. With the stamp, 1× is real time for
every clip, the viewer's ½×/2× multiply the clip's own rate, and clips from
before the stamp (or reconciled ones, which have no trustworthy clock) fall
back to the nominal rate. A reconciled clip likewise carries no duration
rather than a guessed one. `Gallery.reconcile()` runs once at service start — before
anything can record, so a manifest still flagged `recording` can only belong to a
dead process — and it:

- finalises a clip whose writer never got to stop it,
- adopts media left by an older build that wrote no manifest at all,
- rebuilds a manifest that a power cut left unparseable,
- drops a side the manifest claims but whose file never landed,
- removes a directory holding no media, rather than listing a broken tile.

It recovered both stragglers on first run:

```
[vision] recovered 2 interrupted capture(s): pair-20000101-080114, pair-20260727-114223
```

Free space is also re-checked **while** recording, not only at the start. At
2.84 MB/s the ten-minute cap is ~1.7 GB, against a `MAX_GALLERY_MIN_FREE_MB`
floor of 1 GB — a clip that started with just enough room would write straight
through it and fill the disk. It now stops itself cleanly, keeping the frames it
already has.

Serving a clip no longer reads it whole, either: the thumbnail walks the file a
chunk at a time and stops at frame two, and the download streams. Slicing a
thumbnail out of that 835 MB clip previously cost 835 MB of RAM on a 3 GB board.

The two modules are visually near-identical (they are Raspberry Pi Camera v1 vs
v2). Identify one in seconds by plugging it in alone and scanning:

```bash
for b in 4 6; do echo "bus $b:"; i2cdetect -y -r $b | sed -n '3p'; done
# 0x10 => IMX219  (works)
# 0x36 => OV5647  (does not stream on this image)
```

### Recording a tuning corpus — the ride protocol

Shadow mode on (`MAX_ADAS_SHADOW=1` in `/etc/max/agent.env`, restart
`max-vision`), then ride normally — but deliberately include, front camera
unless noted:

1. **A pull-up-behind at a stop.** The ego gate's defining case: a car
   arriving behind you at a light must produce **zero** rear alerts while you
   are stationary. This single scenario validates the moving/stopped gate.
2. **A steady follow** above tailgate height for more than ten seconds
   (rear camera) — the tailgating dwell case.
3. **Being overtaken, and overtaking** — closing-rate discrimination.
4. **A pedestrian crossing ahead at low speed** — the pedestrian TTC case.

A good first corpus is at least 30 minutes of riding with several stops and
one of each scenario. Afterwards, copy the ride off the board and label the
genuine hazards:

```bash
python3 -m tools.label add --ride ./corpus/ride-... \
  rear_approach:rear:12000:15000:"car closed fast at the light"
python3 -m tools.evaluate ./corpus/ride-...
```

`evaluate` prints the ride's false-alerts-per-hour, false criticals, and
missed hazards per threat — the measured half of the M1 gate — stamped with
the tuning fingerprint from the ride's own shadow log. Alert audio stays
locked until those numbers meet the gate; see "ADAS M2".

## Wi-Fi navigation HUD casting (bench prototype)

Phone-owned navigation can now be sent from either development app to the RDK
display. Open `/cast` on the board-local HUD server, then use **投屏到 HUD**
in the phone’s navigation details. See [setup, limits and acceptance checks](../docs/rdk-hud-casting.md).
