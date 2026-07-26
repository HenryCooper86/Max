# ADAS M2 — On-Bike Runtime and Alert Delivery

## Summary

M2 puts the M1 pipeline on the bike. A runtime drives the cameras through the
detector, tracker, threat engine and suppression stack, and every alert it
produces is logged with enough context to explain itself. Alert audio is built,
tested, and **shipped locked**.

Parent spec: `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md`.
Depends on: `docs/superpowers/specs/2026-07-26-adas-m1-measure-design.md`.

## The gate, stated plainly

The parent spec says, in bold: **M2 is gated on M1's numbers.** Those numbers —
under 1 false alert per hour, zero false `critical` alerts, no regression in
caught-hazard rate — are **all unmet**, because they need a labelled corpus and
the bench cameras are OV5647, which the vendor ISP cannot drive.

M2 is still the right work, because the parent spec defines M2 as _starting in
shadow mode_: the full pipeline runs and logs every alert it would have fired,
and plays nothing. The gate is on **enabling audio**, not on building the
runtime. Shadow mode is the instrument that produces the missing numbers.

So:

- `MAX_ADAS_AUDIO` defaults to `0`. The runtime logs and emits; the agent is
  silent.
- Arming requires shadow-mode false-alarm numbers meeting the M1 gate. That is
  a human decision made against recorded evidence, not a code change.
- **M1's suppression constants remain untuned.** Nothing in M2 changes that.

## Architecture

The ADAS loop runs **inside the vision sidecar**, on its own thread per camera.

The sidecar already owns the cameras, so frames never cross a process boundary —
at 3.1 MB per frame that is the difference between free and 31 MB/s of IPC on a
board already sitting at ~90 °C under load. It also already carries an NDJSON
`event` channel, added in the embedded-client spec for exactly this purpose.

A separate `max-adas` process was considered and rejected: it buys isolation for
the component whose failure is least costly, and pays for it in the one resource
measured to be scarce. An ADAS crash takes camera preview and gallery with it;
it cannot touch voice, which is a different process, and that is the boundary
that matters.

```text
rdk/vision/
  adas/runtime.py           per-camera loop: FrameSource -> M1 pipeline -> Alert
  adas/shadow.py            append-only alert log, keyed to ride and segment
  service.py                owns the runtime; emits {"event":"hazard"} on NDJSON
  tools/clip.py             extract a clip around an alert from M0 segments
  tools/render_alerts.py    Doubao TTS -> the alert WAVs, run once

rdk/agent/src/
  audio/alert-player.ts     play a WAV at absolute priority
  hazard.ts                 vision hazard event -> preempt -> play -> report
```

The runtime is a **thin driver**. It owns cameras, threads and timing; every
decision belongs to M1's pure modules, imported unchanged. A threshold changes
in `threat.py` and both the offline harness and the bike get it — the property
M1 was built to have.

## Data flow

```text
cameras ──► runtime.py (one thread per camera)
              │ M1 pipeline, unchanged
              ▼
           Alert ──► shadow.py            always: append to the log
              │
              └────► NDJSON {"event":"hazard", …} ──► agent
                                                        │
                                     MAX_ADAS_AUDIO=1 ? │
                                      no ──► log only ◄─┤
                                     yes ──► playback.flush()
                                             → play WAV (absolute priority)
                                             → hazard.report to relay
```

**The event is emitted in both modes.** Shadow does not mean "do not tell the
agent"; it means the agent makes no sound. Emitting always means the shadow path
exercises the same code the armed path will, so arming later flips one branch
rather than activating a path nobody has run.

**`hazard.report` flows upward only.** The relay must not echo it back as
`hazard.alert`: the board has already played the audio, and an echo would have
Max speak the warning a second time, seconds late, over a rider already braking.

## Alert delivery

### Audio source

Pre-rendered WAVs, generated once by `tools/render_alerts.py` calling Doubao's
TTS API directly with each catalog string from `shared/adas.ts`.

Pre-rendering beats on-device synthesis on every axis that matters here: zero
synthesis latency against a 2-second TTC budget, identical wording every time so
the rider learns the sound, and no network dependency at all. An ADAS alert that
needs WiFi is not an ADAS alert.

Direct TTS rather than capturing a realtime session, because the model
paraphrases: wording would drift between clips and between regenerations, and a
sound the rider is supposed to learn cannot drift.

### Priority

Two properties, both absolute in the parent spec.

**An alert preempts Max.** That is `playback.flush()`, the barge-in path already
shipped.

**An alert cannot itself be preempted.** This needs a lock in `playback.ts`:
while an alert is playing, `flush()` is a no-op. Without it, a rider saying
"什么?" mid-warning trips Doubao's VAD and cuts the collision alert in half. A
warning a startled rider can accidentally cancel is worse than no warning.

### The AEC integration

Alert audio **must** feed the AEC reference sink, exactly like Max's speech.

It leaves the same speaker and enters the same microphone. If APM is not told
about it, the mic hears an uncancelled alert, Doubao's VAD fires on it, and the
echo loop returns — triggered by our own safety warning. See the AEC section of
`rdk/README.md` for what that failure cost.

Routing alerts through `playback.write()` rather than a separate `aplay` gets
this for free: the soft limiter, the pacing and the reference tap all already sit
on that path.

The cost is that an alert inherits playback's 80 ms queue cap — 4% of a 2.0 s TTC
budget, and the price of the reference staying time-aligned.

### Latency

**Frame-capture → sound-out is measured per alert**, not sampled. The parent spec
makes latency a requirement rather than telemetry, because the entire value
proposition is bounded by it. The measurement is written to the shadow log
alongside the alert.

## Shadow mode

### The log is the deliverable

One JSONL per ride under the corpus root. Each record carries:

- the alert: threat id, severity, camera, measured TTC, wall time
- provenance: ride id, segment file, offset within the segment
- the pipeline's own view at that instant: track id, box height, closing rate,
  frames tracked, ego state
- latency, when armed

That third group is what makes a false alarm fixable. "Why did it fire" must be
answerable from the log alone, without re-running anything, because the ride is
over and the road has moved on.

### Clips come from the recorder, not a buffer

The obvious implementation keeps a rolling window of frames around each alert. At
10 fps that is ~310 MB of NV12 for ±5 s, on a board where memory and thermal
headroom are both tight.

Instead, M0 already writes continuous encoded segments with per-frame timestamp
metadata. Shadow mode logs the alert with its timestamp; `tools/clip.py` extracts
the window afterwards. Zero runtime cost, no buffer, and the clip is the same
H.264 the corpus is made of — so **shadow clips are corpus material**, feeding
the tuning that unlocks audio.

### Shadow mode requires recording

If recording is off, the runtime refuses to start rather than degrading to
alerts-without-evidence.

A false-alarm rate whose evidence was never written is exactly the number that
misleads. This project has been burned by that shape of measurement twice — the
2026-07-25 AEC sweep, and an acoustic bench that measured a room instead of an
echo. Silence is a safe failure; an unreviewable number is not.

## Relay and protocol changes

1. **New client→server `hazard.report`**, carrying the same fields as
   `hazard.alert` and flowing upward, so real alerts reach the transcript, QA
   evidence and ride pulse. Added to `protocol/agent-events.schema.json` and
   generated into TypeScript, Kotlin and Swift by
   `scripts/generate-agent-protocol.ts`. The relay must **not** echo it.

2. **Suppress the simulated injector for embedded sessions.**
   `createHazardInjector` is constructed at two call sites —
   `server/providers/mock.ts` and `server/providers/doubao.ts` — and both are
   gated on `platform === "embedded"`, so simulated and genuine hazards can
   never interleave. A rider could not tell them apart and the QA record would
   be worthless. Gating one provider and not the other would leave the
   simulation live on exactly the path a real board uses.

No changes to web, iOS or Android beyond the generated contract.

## Failure behaviour

Every mode favours silence.

| Failure                      | Behaviour                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- |
| One camera lost              | Threat set degrades; the other camera continues                               |
| Both cameras lost            | Runtime idles; sidecar keeps serving preview and gallery                      |
| BPU fault or numpy exception | ADAS thread logs and exits; no auto-restart; voice untouched                  |
| Disk full                    | Shadow logging stops and the runtime stops — no alerts without evidence       |
| Missing WAV while armed      | That threat logs and stays silent; never falls back to network TTS            |
| Agent restarts mid-alert     | The playback lock clears with the process; the next alert is normal           |
| Sidecar dies                 | Agent keeps running; it already treats the sidecar as optional and reconnects |

ADAS must never be able to take down the voice path. It runs in the vision
sidecar, a separate process from the agent, so a fault costs hazard detection and
nothing else.

## Verification

### Automated, no hardware

- **Runtime driver** — a clip through `FileSource` produces an expected shadow
  log; no cameras needed.
- **Shadow log** — record shape, provenance fields present, append-only across
  restarts.
- **Playback priority lock** — an alert suppresses a concurrent `flush()`; a
  normal reply does not.
- **Alert player** — missing WAV logs and stays silent rather than raising.
- **AEC reference** — an alert written through playback reaches the reference
  sink, not just the DAC.
- **`hazard.report`** — schema round-trip through the generator; the relay does
  not echo it.
- **Injector gate** — `platform === "embedded"` suppresses simulated hazards and
  leaves the other platforms unchanged.
- **`tools/clip.py`** — extracts the right window given a segment and offset.

### Bench, on the board

- Latency per alert, frame-capture → sound-out, armed.
- Soak with ADAS and voice both live, against the ~90 °C plateau M1 measured.
- Alert audio plays with the relay disconnected.
- An alert preempts Max mid-sentence and survives a barge-in attempt.

### Road

**Shadow only.** No audio until shadow numbers meet the M1 gate.

## Acceptance criteria

M2 is complete when:

1. The runtime drives all four threats from real detections on the embedded
   platform, with the simulated injector suppressed for those sessions.
2. Shadow mode records alerts with provenance, and `tools/clip.py` extracts a
   viewable clip for any of them.
3. Alert audio plays with the relay disconnected, preempts Max, and cannot be
   preempted.
4. Alert audio reaches the AEC reference sink.
5. Latency is measured per alert and recorded.
6. Losing one camera degrades the threat set and nothing else.
7. `npm run check` passes; web, iOS and Android behaviour is unchanged.
8. `MAX_ADAS_AUDIO` defaults to `0` and the README states what arming requires.

M2 is **not** a claim that the alerts are correct. Shadow mode measures the
false-alarm rate; it cannot measure missed hazards without labels.

## Open items

- **Cameras.** Shadow mode collects nothing without them. OV5647 is unsupported;
  IMX219 is the working module.
- **Doubao TTS credentials.** The relay's realtime-session credentials may not
  cover the standalone TTS API `render_alerts.py` needs.
- **The false-alarm gate value.** Still an open decision, needed when shadow data
  exists rather than now.
- **Arming.** Requires a human decision against recorded evidence. Nothing in
  this spec automates it, and nothing should.
