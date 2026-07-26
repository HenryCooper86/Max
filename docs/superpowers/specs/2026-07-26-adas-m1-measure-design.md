# ADAS M1 — Measurement Pipeline Design

## Summary

M1 builds the pipeline that turns camera frames into hazard alerts, and the
offline harness that measures it: detector on the BPU, tracker, threat engine,
suppression stack, replay tool. It is the milestone that produces evidence.

**M1 emits nothing to the rider.** No audio, no `hazard.report`, no protocol
changes — those are M2. M1's only outputs are files. Every failure mode here is
a measurement problem rather than a safety one, which is precisely why the risky
work belongs in this milestone.

Parent spec: `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md`.
That document owns the threat definitions, the suppression stages and the
milestone structure; this one owns how M1 is built and what it proves.

## The corpus constraint

The parent spec's M1 exit criteria are all _per hour of recorded riding_:

- under 1 false alert per hour
- zero false `critical` alerts
- no regression in caught-hazard rate

**None of them can be reached today.** Verified on the board on 2026-07-26:
both camera connectors present `0x36` on i2c (bus 4 and bus 6), which is
**OV5647** — the sensor the vendor ISP cannot drive. `0x10`, the IMX219 address,
is absent on both buses. M0 corpus recording is therefore still hard-blocked,
and so is tuning.

The response is to split M1 rather than stall it. Almost all of M1 is
camera-independent: the detector can be fed NV12 from files, and the tracker,
threat engine and suppression stack are pure functions by design.

**M1 ships the pipeline with its constants at the parent spec's conservative
starting values, explicitly untuned.** The suppression stack is implemented and
tested; it is not validated. A green test suite must not be read as evidence
that the thresholds are right — it is evidence that the code does what the
thresholds say.

The false-alarm gate itself remains an open decision. It is not needed until
there is a corpus to measure against, so it does not block M1.

## What M1 must prove

Four pieces of evidence, agreed as M1's definition of done:

1. **The detector works on real video.** Does stock yolov5s find vehicles at
   useful range? Without this, M2 is built on an assumption.
2. **Offline and online agree.** The same clip through the file path and the
   camera path yields an identical alert sequence.
3. **The board can sustain it.** Thermal ceiling and achievable fps for
   dual-stream inference, measured with the voice pipeline running.
4. **The decision layer is exhaustively tested.** Tracker, TTC, all four threat
   rules, all six suppression stages, against synthetic fixtures.

## Hardware facts, verified 2026-07-26

Measured on the board, not taken from documentation.

| Element        | Finding                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| Model          | `/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin` |
| Input          | **NV12**, `(1,3,672,672)`, NCHW — no colour conversion from the ISP                      |
| Outputs        | three **float32** tensors: `(1,84,84,255)`, `(1,42,42,255)`, `(1,21,21,255)`             |
| Strides        | 8, 16, 32 (672/84, 672/42, 672/21)                                                       |
| Head           | 255 = 3 anchors × (5 + 80 classes) — anchor-based YOLOv5                                 |
| Dequantization | **not required** — `scale_data` empty, outputs already float32                           |
| Cameras        | **none usable**: OV5647 (`0x36`) on both buses, IMX219 (`0x10`) absent                   |
| Thermal idle   | **75.5 °C** with the voice pipeline running (the parent spec's 71 °C predates AEC)       |
| Tooling        | `ffmpeg` present; `bus.jpg` sample image available for anchor validation                 |

The float32 outputs are a genuine simplification against the parent spec's
assumption: the dequantization step the vendor samples carry is unnecessary
here.

## Architecture

The parent spec fixes the large structure. M1's own architectural decision is
narrower and load-bearing: **how the offline harness and the on-bike runtime
stay byte-identical**, since that is what makes an offline-tuned threshold
trustworthy at 100 km/h.

```text
rdk/vision/
  perception/
    frame_source.py   FrameSource protocol; CameraSource | FileSource
    detector.py       pyeasy_dnn load + infer; NV12 in, Detection[] out
    postprocess.py    anchor decode + NMS. Pure, numpy only.
    tracker.py        IoU association + constant velocity. Pure.
  adas/
    ego_motion.py     moving/stopped + coarse speed. Pure given two frames.
    threat.py         four rules + TTC. Pure.        <- shared byte-for-byte
    suppress.py       six-stage gate. Pure given a clock.
  tools/
    replay.py         clip -> alerts; caches detections
```

### The seam

`FrameSource` yields `(nv12_bytes, timestamp_ms, camera)` and nothing else.

- `CameraSource` wraps M0's `recorder/mipi_source.py`.
- `FileSource` decodes H.264 to NV12 via ffmpeg.

Everything below the seam is reached by exactly one code path. Parity is
therefore structural, not something maintained by discipline.

Two alternatives were considered and rejected. Replaying only cached detections
(skipping the detector offline) makes every detector-dependent constant —
which is every TTC threshold — untunable without a bike. Pre-converting clips
to raw NV12 frame dumps costs 3.1 MB/frame, about 110 GB per hour of corpus.

### Detection cache

`replay.py` caches detections to `.jsonl` on first pass. Tuning means many
passes over one corpus, and re-running BPU inference each time would make the
loop unusable. The cache is an optimisation over the same code path, not a
second path, so parity is unaffected.

The key is `(clip_id, model_hash, conf_threshold)`. Changing the detector or its
threshold invalidates the cache automatically. A stale cache silently tuning
against detections from a different model is the kind of self-deceiving
measurement worth making impossible rather than remembering to avoid.

## Data flow

Per frame, per camera:

```text
FrameSource -> (nv12, t_ms, camera)
  -> detector.infer(nv12)                    BPU, 672x672
  -> postprocess: logit-threshold -> anchor decode -> NMS
  -> filter to {person, bicycle, car, motorcycle, bus, truck}
  -> tracker.update(detections, t_ms)        -> Track[] with box history
  -> ego_motion (front only)                 -> moving? speed scale
  -> threat.evaluate(tracks, ego, t_ms)      -> Candidate[]
  -> suppress.admit(candidates, t_ms)        -> Alert[]
```

### Time comes from the frame, never from a frame counter

Every track carries `(t_ms, height)` samples, and `dh/dt` is a least-squares
slope over a ~300 ms window of actual timestamps.

At 10 fps nominal, a single dropped frame makes a counter-based derivative wrong
by 10 percent — and dropped frames are exactly what distinguishes the on-bike
path from the offline one. Real timestamps are what let parity hold when the
board is thermally throttled.

### TTC

`tau = h / (dh/dt)` on an EMA-smoothed box height, emitted only when `dh/dt` is
positive.

A non-closing track produces **no TTC at all**, not a large one. A zero or
negative denominator is a category difference rather than a big number, and
treating it as a big number is how a division-by-zero becomes an alert at
100 km/h.

Box height rather than area or width, per the parent spec: it degrades most
gracefully under the partial horizontal occlusion that lane-splitting produces.

### Postprocessing cost

The three output tensors total about 2.36M floats per frame. Sigmoid over all of
them at 20 inferences/s is roughly 47M transcendental operations per second on a
Cortex-A55 — plausibly more expensive than the BPU inference it is
postprocessing.

`postprocess.py` therefore thresholds on **raw objectness logits** first,
comparing against `logit(conf_threshold)` with no sigmoid, and decodes only the
surviving cells. Typical traffic frames leave tens rather than thousands.

The optimisation must be provably equivalent: a test asserts it selects exactly
the same cells as a naive sigmoid pass. An optimisation that changes results is
a bug.

### Anchors

Standard YOLOv5 COCO anchors are assumed:

| Stride | Anchors                      |
| ------ | ---------------------------- |
| 8      | (10,13) (16,30) (33,23)      |
| 16     | (30,61) (62,45) (59,119)     |
| 32     | (116,90) (156,198) (373,326) |

This is near-certain for a vendor-compiled yolov5s, but if it is wrong, boxes
land in plausible-looking wrong places and every downstream TTC number is
quietly garbage.

**Validation is on frame one:** run `bus.jpg` through the real BPU and assert
the bus box lands on the bus. This gates every other number M1 produces.

## Outputs

`replay.py` emits three artifacts per clip:

| Artifact           | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `detections.jsonl` | cache; skips the BPU on re-runs                                 |
| `alerts.jsonl`     | the alert sequence, for parity and scoring                      |
| `summary.json`     | counts, false-alarms/hour, latency percentiles, throttle events |

## Failure behaviour

| Failure                   | Behaviour                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera absent             | Degrade the threat set, never the process. Front-only gives `forward_collision` + `pedestrian_ahead`; rear-only gives `rear_approach` + `tailgating`. Both absent is a valid idle state. |
| Model load fails          | Sidecar logs and runs without ADAS. Voice unaffected.                                                                                                                                    |
| Decode error or frame gap | Tracks age out by timestamp. A 500 ms gap ends tracks rather than fabricating a jump in `dh/dt`.                                                                                         |
| BPU throttles             | fps drops, timestamps stay honest, TTC stays correct. Recorded in `summary.json` — throttling is a measurement, not an error.                                                            |
| Detector returns nothing  | No tracks, no candidates. Silence is the correct output.                                                                                                                                 |

### ADAS must never be able to take down the voice path

ADAS runs in the vision sidecar, a separate process from the agent, so a numpy
exception or a BPU fault costs hazard detection and nothing else. The agent
already treats the sidecar as optional and reconnects on a timer.

This is an existing property, stated here so that a later change does not
"simplify" ADAS into the agent process.

### The ffmpeg NV12 layout gate

Before any parity claim, one frame from the ISP and one decoded by ffmpeg from
the same scene are compared for plane layout, stride and size.

A mismatch would make offline and online detections diverge subtly, and it would
present as a threat-engine bug — sending debugging to the wrong module. The
check costs one assertion. The AEC milestone lost a full cycle to an unverified
assumption of exactly this shape, when a stale binary produced plausible
numbers.

## Verification

### Automated, no hardware

- **`postprocess.py`** — anchor decode against hand-computed boxes; NMS with
  overlapping and nested boxes; the logit-threshold shortcut selects exactly the
  cells a naive sigmoid pass would.
- **`tracker.py`** — association across frames, id stability, track loss and
  reacquisition, and a 500 ms timestamp gap ending a track.
- **TTC math** — smoothing, least-squares slope over irregular timestamps,
  non-closing tracks yielding no TTC, zero and negative denominators.
- **`threat.py`** — all four rules from track literals, both sides of every
  boundary (TTC 2.0, 2.5, 3.0), closing-rate separation of `rear_approach` from
  `tailgating`.
- **`suppress.py`** — each of the six stages in isolation, cooldown expiry,
  `critical` preempting `caution` and never the reverse, global rate limiting.
- **`ego_motion.py`** — moving/stopped from synthetic flow fields.
- **`replay.py`** — a fixture clip with known labels produces a known alert
  sequence.

### Bench, on the board

- **Anchor validation** — `bus.jpg` through the real BPU; the bus box lands on
  the bus. Gates every downstream number.
- **Detector on real traffic** — a supplied clip; detection rate, usable range,
  per-frame latency.
- **Parity** — one clip through `FileSource` and through the camera path,
  identical alert sequence.
- **Thermal and throughput soak** — sustained dual-stream with voice running;
  throttle point and achievable fps, against the 75.5 °C idle baseline.

### Deferred to the tuning phase

The three exit criteria in the parent spec, all of which need a labelled corpus
and therefore working camera hardware.

## Acceptance criteria

M1 is complete when:

1. All automated tests pass in the existing pytest suite.
2. `bus.jpg` produces correctly placed boxes on the real BPU.
3. A real traffic clip yields a measured detection rate, range and latency.
4. Offline and online produce identical alert sequences for one clip.
5. The thermal and throughput ceiling is recorded in `rdk/README.md`.
6. The suppression constants are documented as **untuned starting values**.

M1 is explicitly **not** a claim that the alerts are correct. That claim needs
the corpus, and the corpus needs an IMX219.

## Open items

- **IMX219 hardware.** One module unblocks front-only recording and tuning; two
  unblock the front+rear corpus. Everything in "Deferred" waits on this.
- **The false-alarm gate.** Still an open decision, needed at tuning time rather
  than now.
- **Rear-camera viewpoint.** No public corpus resembles a helmet's rear view,
  which is the differentiator and therefore the least de-riskable part of the
  design.
