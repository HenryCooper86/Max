# Real ADAS on the BPU — Embedded Hazard Detection Design

## Summary

Make Max's hazard alerts real. Today every `hazard.alert` comes from
`server/hazard-injector.ts`, which cycles the catalog on a timer — the delivery
pipeline is production-shaped but the detections are simulated. This spec
replaces that simulation, **on the embedded platform only**, with genuine
detections from the RDK X5's BPU over the helmet's cameras.

Four threats in v1, all falling out of one object detector plus
bounding-box-expansion time-to-contact: `forward_collision` and
`pedestrian_ahead` from the front camera, `rear_approach` and `tailgating` from
the rear. The rear pair is the differentiator — no bar-mounted phone can see
behind the rider.

Two properties govern the whole design. **The threat decision is a pure
function**, so the thresholds tuned against recorded rides are literally the code
that fires on the bike. And **a false alert is worse than a missed one** — a
spurious "立即减速" at 100 km/h can cause the crash it was meant to prevent, so
nothing reaches a rider's ears until a measured false-alarm rate says it may.

Builds on `docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`:
the Python vision sidecar, its bidirectional NDJSON control socket (shaped from
the start to carry hazard events upward), and the agent's `playback.flush()`
barge-in path are all reused unchanged.

## Scope

### Goals

- Real BPU detection driving `forward_collision`, `pedestrian_ahead`,
  `rear_approach`, and `tailgating` on the embedded platform.
- A pure, unit-testable threat engine shared byte-for-byte between the offline
  replay harness and the on-bike runtime.
- Alert audio that plays locally with **no network dependency** and preempts
  Max mid-sentence.
- A measured false-alarm rate, gating whether audio is ever enabled.
- Degraded operation: front-only and rear-only are valid modes.

### Non-goals

- **Any actuation.** No braking, no throttle. Advisory only, permanently.
- The other five catalog threats — `lane_departure`, cross-traffic (×2),
  blind-spot (×2). Different algorithms, worse false-alarm profiles, and
  `lane_departure` is questionable for a motorcycle in China where lane-splitting
  is normal riding.
- Night and heavy-rain validation. Needs its own corpus.
- Changing web/iOS/Android. They keep the simulated injector for demos.
- Training a custom detector. The stock model is the v1 baseline.
- Safety/liability sign-off. A business decision, not an engineering task.

## Hardware baseline

Verified against the board on 2026-07-25 (see `rdk/README.md`).

| Element  | Status                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| BPU      | present, idle 500–1000 MHz, `hobot_dnn.pyeasy_dnn` available                                                       |
| Detector | **already on the board**: `/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin` |
| Scaler   | VSE hardware channels already configured by the camera pipeline                                                    |
| Camera   | **IMX219** streams 1920×1080 @ 30 fps on VCON 2. **OV5647 does not work** — fails at video-flow start              |
| Thermal  | idles at ~71 °C with the BPU at 0%                                                                                 |

Two hardware facts are unresolved and affect this spec:

- **No camera streams today.** Both modules on the bench are OV5647, which
  produce zero frames even under the vendor's own `mipi_cam`. IMX219 is the
  working module. The design treats cameras as independently optional regardless,
  which is good practice and not merely a workaround.
  (Corrected 2026-07-25: an earlier draft claimed front+rear was blocked by an
  i2c address collision. It is not — the two connectors sit on **different**
  buses, `vcon@0/@1` on bus 6 and `vcon@2/@3` on bus 4, so a front+rear pair uses
  channels 0 and 2 with no GPIO multiplexing.)
- **Thermal headroom is unmeasured.** 71 °C idle means sustained dual-camera
  inference could throttle. M1 measures it rather than assuming.

The stock model taking **NV12** input matters more than it sounds: NV12 is
exactly what the VIN/ISP pipeline emits, so there is no colour conversion between
camera and BPU, and no calibration dataset needed to start.

## Architecture

`threat.py` is a pure function from tracks plus ego state to alerts. No camera,
no BPU, no I/O. The offline harness and the on-bike runtime call the same module,
which is what makes an offline-tuned threshold trustworthy on the road.

```text
rdk/vision/  (the sidecar from the previous spec)
  camera.py ──NV12 frames──► perception/detector.py    BPU yolov5s, NV12 in
                                   │ detections (COCO subset)
                                   ▼
                             perception/tracker.py     IoU + constant velocity
                                   │ tracks
        adas/ego_motion.py ────────┤ moving? speed scale  (front-camera flow)
                                   ▼
                      ┌───── adas/threat.py ─────┐   PURE — no I/O
                      │  scale-expansion TTC      │      ▲
                      │  four threat rules        │      │ same module,
                      └───────────┬───────────────┘      │ both paths
                                  ▼                      │
                      adas/suppress.py   6-stage gate     │
                                  │                      │
              {"event":"hazard"} up the NDJSON socket    │
                                  ▼                      │
    agent: playback.flush() → play pre-rendered WAV      │
                    └─► hazard.report to relay (best-effort, upward only)
                                                          │
  tools/replay.py: recorded clip → detector → tracker ────┘
                   → alerts vs labels → false-alarms/hour
```

### Units

- **`perception/detector.py`** — loads the `.bin`, runs inference on an NV12
  frame, returns boxes filtered to `{person, bicycle, car, motorcycle, bus,
truck}`.
- **`perception/tracker.py`** — IoU association plus constant-velocity
  prediction; assigns stable track ids and per-track box history. Pure given a
  detection list.
- **`adas/ego_motion.py`** — global optical flow on the front camera; returns
  moving/stopped plus a coarse speed scale. Pure given two frames.
- **`adas/threat.py`** — the four rules and the TTC math. Pure.
- **`adas/suppress.py`** — the six-stage gate, cooldowns, severity preemption.
  Pure given a clock value.
- **`tools/replay.py`** — offline harness; clip in, alert sequence out.
- **`tools/label.py`** — writes and validates hazard-window labels for a clip.

### Reused unchanged

The vision sidecar and its NDJSON control socket, the agent's `playback.flush()`
barge-in, `shared/adas.ts` (threat ids, directions, severities, labels, spoken
strings), and the generated protocol pipeline.

## Perception

Per camera, per frame:

```
NV12 1920×1080 ──VSE──► 672×672 ──BPU yolov5s──► boxes
  → filter to {person, bicycle, car, motorcycle, bus, truck}
  → tracker: IoU association + constant-velocity prediction
  → per-track TTC
```

Target **10 fps per camera** (20 inferences/s with both). The VSE does the
resize in hardware, so the CPU never touches pixels.

**Time to contact** comes from scale expansion, which is what makes this work
with one lens and no calibration:

```
τ  =  h / (dh/dt)          h = box height, exponentially smoothed
```

Box **height**, not area or width: it degrades most gracefully under partial
occlusion and lane-splitting, where vehicles routinely clip each other
horizontally but rarely vertically. A box that is not growing is not closing, at
any distance — no depth, no baseline, no intrinsics.

`dh/dt` is estimated over a short window rather than frame-to-frame, because
single-frame box jitter would otherwise dominate the derivative.

**Cameras are independently optional.** Front-only yields
`forward_collision` + `pedestrian_ahead`; rear-only yields `rear_approach` +
`tailgating`. A missing camera degrades the threat set, never the process.

## Threat logic

| Threat              | Camera | Fires when                                                                            |
| ------------------- | ------ | ------------------------------------------------------------------------------------- |
| `forward_collision` | front  | vehicle track in the path corridor, TTC < 2.0 s, closing                              |
| `pedestrian_ahead`  | front  | class `person` in corridor, TTC < 2.5 s                                               |
| `rear_approach`     | rear   | vehicle behind, TTC < 3.0 s **and** `dh/dt` > `CLOSING_RATE_MIN`                      |
| `tailgating`        | rear   | box height > `TAILGATE_HEIGHT_FRAC` for > 4.0 s **with** `dh/dt` ≤ `CLOSING_RATE_MIN` |

Starting values, tuned in M1: `CLOSING_RATE_MIN` = 0.08 (box-height fraction per
second), `TAILGATE_HEIGHT_FRAC` = 0.45 of frame height.

`rear_approach` and `tailgating` are separated by **closing rate, not distance**.
Distance alone would make every normally-following car trigger the critical
alert, which is exactly how a rider learns to ignore the system.

Emitted alerts reuse the existing catalog entries in `shared/adas.ts`, so the
spoken strings, labels, directions and severities are identical to the simulated
ones. Only `ttcSeconds` is replaced with the measured value.

## Suppression stack

Every candidate clears all six stages, in order, before becoming an alert. Each
is a named constant, not a number buried in a conditional. The values below are
**starting points that M1 tunes**, not measured results — but they are concrete
so the engine is implementable and testable on day one.

| #   | Stage               | Constant              | Start                       | Rationale                      |
| --- | ------------------- | --------------------- | --------------------------- | ------------------------------ |
| 1   | Ego moving          | `MIN_EGO_SPEED`       | moving/stopped flag         | Stopped → nothing fires        |
| 2   | Track maturity      | `MIN_TRACK_FRAMES`    | 3 frames (≈300 ms @10 fps)  | Kills detector flicker         |
| 3   | TTC stability       | `MIN_TTC_FRAMES`      | 3 consecutive               | One noisy sample must not fire |
| 4   | Path corridor       | `CORRIDOR_WIDTH_FRAC` | 0.5 of frame width, centred | Adjacent lane ≠ collision      |
| 5   | Per-threat cooldown | `THREAT_COOLDOWN_S`   | 8 s                         | No machine-gunning one threat  |
| 6   | Global rate limit   | `GLOBAL_ALERT_GAP_S`  | 4 s                         | A rider can act on one thing   |

Stage 1 is the highest-value gate: it alone kills the most common false alarm
there is — a car pulling up behind you at a light, which is visually
indistinguishable from a rear approach.

Stage 4 is load-bearing in China specifically, where lane-splitting puts adjacent
traffic routinely close to the rider.

On stage 6, a `critical` may preempt a `caution` cooldown; a `caution` may never
preempt a `critical`.

**Governing principle: prefer a missed alert to a false one.** Every threshold
starts conservative and loosens only against measured M1 data, never a hunch.

## Alert delivery

The catalog is a fixed set of strings, so the audio is **pre-rendered**: generate
each clip once through Doubao in the same voice Max speaks with, and ship the
WAVs on the board.

That beats on-device TTS on every axis that matters here — zero synthesis
latency against a 2-second TTC budget, identical wording every time so the rider
learns the sound, and **no network dependency at all**. An ADAS alert that needs
WiFi is not an ADAS alert.

```
threat fires → sidecar pushes {"event":"hazard", …} up the NDJSON socket
             → agent: playback.flush()      (the shipped barge-in path)
             → play the clip for that threat  (absolute audio priority)
             → hazard.report to relay         (best-effort, never blocking)
```

**Audio priority is absolute.** An alert preempts Max mid-sentence and cannot
itself be preempted. If a resumed reply talked over a collision warning the
feature would be worse than useless.

**Latency is a requirement, not telemetry.** Frame-capture → sound-out is logged
per alert and has a budget, because the whole value proposition is bounded by it.

## Protocol and relay changes

1. **New client→server `hazard.report`.** Carries the same fields as
   `hazard.alert` but flows upward, so real alerts still land in the transcript,
   QA evidence, and ride pulse. Added to
   `protocol/agent-events.schema.json` and generated into TypeScript, Kotlin and
   Swift by `scripts/generate-agent-protocol.ts`.

   The relay **must not** echo it back as `hazard.alert` — the board has already
   played the audio, and an echo would make Max speak the warning a second time,
   seconds late.

2. **Suppress the simulated injector for embedded sessions.**
   `createHazardInjector` (`server/hazard-injector.ts`) currently runs for the
   mock provider always, and for Doubao when `scenario === "adas"`. Gate it on
   `platform === "embedded"` so simulated and genuine hazards can never
   interleave — a rider could not tell them apart, and the QA record would be
   worthless.

No changes to the existing three clients beyond the generated contract.

## Milestones

**M2 is gated on M1's numbers. This is the point of the whole structure.**

**Each milestone gets its own implementation plan.** They are not one plan: M0 is
a recording and labelling tool, M1 is an offline measurement pipeline, M2 is an
on-bike runtime — different code, different verification, and M1's exit criteria
decide whether M2 is written at all. Planning them together would pretend to a
certainty the data has not yet earned.

### M0 — Collect

Continuous paired recording using the capture path already shipped, plus
per-frame metadata (timestamp, camera, ego-motion estimate). Ride, build a clip
library, label hazard windows with `tools/label.py`.

Front-only collection may begin immediately; it does not wait on the rear-camera
hardware question.

### M1 — Measure

Detector on the BPU, tracker, threat engine, suppression stack, replay harness.
Tune against the labelled corpus. Measure the thermal ceiling for sustained
dual-camera inference.

**Exit criteria — all three:**

- **< 1 false alert per hour** of recorded riding
- **zero false `critical` alerts** in the corpus
- no regression in caught-hazard rate on labelled events

### M2 — Ride

On-device runtime and alert delivery, **starting in shadow mode**: the full
pipeline runs on the bike and logs every alert it _would_ have fired, with a
video clip around each, and **plays no audio**. This measures the real-world
false-alarm rate without ever startling a rider on a real motorcycle.

Audio is enabled only once shadow-mode numbers agree with the offline harness.

## Verification

### Automated (no hardware)

- **`threat.py` from track literals** — all four rules, boundary TTC values,
  closing-rate separation of `rear_approach` from `tailgating`.
- **`suppress.py`** — each of the six stages independently, cooldown expiry,
  severity preemption in both directions, global rate limiting.
- **TTC math** — smoothing, derivative windowing, non-closing tracks yielding no
  alert, division-by-zero and negative-growth cases.
- **Tracker** — association across frames, id stability, track loss and
  reacquisition.
- **Ego-motion gate** — moving/stopped classification from synthetic flow fields.
- **Replay harness** — a fixture clip with known labels produces a known alert
  sequence.

### Bench (board, no bike)

- **Offline/online parity.** Replay a clip through the real BPU on-board and
  assert the same alert sequence as the offline harness. The two paths share code
  but differ in timing and frame drops; divergence here is a bug that would
  otherwise only appear on a bike.
- **Thermal soak.** Sustained dual-camera inference; record the throttle point.
- **Latency.** Frame-capture → sound-out, measured per alert.

### Road

- Shadow mode only, until the M1 gate and shadow numbers agree.

## Acceptance criteria

- Real detections drive all four threats on the embedded platform, with the
  simulated injector suppressed for those sessions.
- `threat.py` and `suppress.py` are pure and fully unit-tested without hardware.
- The offline harness and on-board runtime produce identical alert sequences for
  the same clip.
- Alert audio plays with the relay disconnected.
- An alert preempts Max mid-sentence and is never preempted.
- Losing one camera degrades the threat set and nothing else.
- Measured false-alarm rate meets the M1 gate before audio is enabled.
- `npm run check` passes; web, iOS and Android behaviour is unchanged.

## Follow-on

1. **Front+rear hardware.** Two IMX219 modules on channels 0 and 2 — the wiring
   is not the obstacle it was thought to be, but `rear_approach` and `tailgating`
   still cannot ship until modules that actually stream are fitted to both
   connectors.
2. **Rider-perspective model.** Fine-tune on the M0 corpus; the stock COCO
   detector is a baseline, not a destination.
3. **The remaining five threats**, each with its own false-alarm study.
4. **Night and adverse weather**, with a dedicated corpus.
