# Max on RDK X5 — Embedded Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a D-Robotics RDK X5 board a fourth client of the existing `/agent` relay — hands-free voice through a headset on the board's 3.5 mm jack, plus voice-triggered capture from two IMX219 cameras.

**Architecture:** Two systemd services. `max-agent` (Node 22 under `tsx`, importing `shared/` directly) owns the WebSocket, ALSA audio, device-action dispatch, and a bench dev HUD. `max-vision` (Python) owns the cameras, captures, gallery storage, and MJPEG preview. They speak bidirectional NDJSON over a unix socket, shaped so a future BPU ADAS loop can push hazard events up the same channel.

**Tech Stack:** TypeScript on Node 22 (`tsx`, `ws`), Vitest, Python 3.10 + `libsrcampy`, pytest, ALSA (`arecord`/`aplay`), systemd.

**Spec:** `docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`

## Global Constraints

- Node **22.13 or newer** on the board (Ubuntu 22.04 ships Node 12 — NodeSource is a provisioning step).
- Uplink PCM is **16 kHz PCM16 mono, 320-sample (640-byte) 20 ms frames** — byte-identical to what `public/pcm-worklet.js` emits.
- Downlink voice audio is **24 kHz PCM16 mono**.
- ALSA capture and playback run at **48 kHz**; conversion is explicit in Node, never delegated to `plughw:` resampling.
- Outbound PCM is gated on `session.started` — never transmit before it.
- `IDLE_CLOSE_CODE` (4001, `shared/agent.ts:358`) is an intentional close. Do **not** blind-reconnect; re-arm through the local voice gate.
- Exactly **one** `device.result` per `device.command`. Silence past the relay's `DEVICE_RESULT_TIMEOUT_MS` (8 s, `server/device-actions.ts`) is treated as failure.
- Never report success for an action that did not happen. Refusals use existing reason codes where they exist.
- `REQUIRED_TESTING_PLATFORMS` (`shared/testing.ts:342`) must **not** gain `"embedded"` — it drives release-gate coverage and would fail every existing run.
- `npm run check` must pass at the end of every task that touches TypeScript.
- All Chinese copy is written exactly as given in this plan; do not paraphrase.

---

## File Structure

**Created**

| Path                                                  | Responsibility                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `rdk/README.md`                                       | Provisioning, hardware checklist, recorded bench findings       |
| `rdk/agent/tsconfig.json`                             | TS config for the board client (extends root, no DOM lib)       |
| `rdk/agent/src/audio/dsp.ts`                          | Pure DSP: FIR design, decimation, upsampling, limiting, framing |
| `rdk/agent/src/audio/voice-gate.ts`                   | Pure RMS + hysteresis gate for re-arming after idle close       |
| `rdk/agent/src/audio/capture.ts`                      | `arecord` process lifecycle → 16 kHz frames                     |
| `rdk/agent/src/audio/playback.ts`                     | 24 kHz → `aplay`, barge-in flush                                |
| `rdk/agent/src/vision-client.ts`                      | NDJSON codec + request correlation over the unix socket         |
| `rdk/agent/src/device/capabilities.ts`                | The embedded capability matrix                                  |
| `rdk/agent/src/device/dispatch.ts`                    | `device.command` → handler or `unsupported`                     |
| `rdk/agent/src/relay.ts`                              | `/agent` WebSocket, session lifecycle, reconnect                |
| `rdk/agent/src/hud/state.ts`                          | Serializable dev-HUD state snapshot                             |
| `rdk/agent/src/hud/server.ts`                         | Dev HUD HTTP + WebSocket                                        |
| `rdk/agent/src/hud/index.html`                        | Dev HUD page                                                    |
| `rdk/agent/src/config.ts`                             | Env resolution and validation                                   |
| `rdk/agent/src/main.ts`                               | Wiring and process entry                                        |
| `rdk/vision/rpc.py`                                   | NDJSON framing and dispatch loop                                |
| `rdk/vision/gallery.py`                               | Storage rules: space guard, pair naming, manifests              |
| `rdk/vision/camera.py`                                | `libsrcampy` lifecycle, capture, MJPEG frames                   |
| `rdk/vision/service.py`                               | Sidecar entry point                                             |
| `rdk/vision/tests/test_rpc.py`, `test_gallery.py`     | pytest, camera-free                                             |
| `rdk/systemd/max-agent.service`, `max-vision.service` | Unit files                                                      |
| `tests/rdk-*.test.ts`                                 | Vitest suites (flat, matching repo convention)                  |

**Modified**

| Path                                   | Change                                      |
| -------------------------------------- | ------------------------------------------- |
| `shared/testing.ts:6`                  | `TestingPlatform` gains `"embedded"`        |
| `server/testing-store.ts:620`, `:1136` | Platform validator + `inferTestingPlatform` |
| `server/index.ts:385`                  | Query-param platform validator              |
| `server/device-actions.ts`             | Three new `FAILURE_SPEECH` entries          |
| `knip.json`                            | Ignore `rdk/**` (see Task 2, Step 6)        |

**Milestones.** Tasks 0–8 deliver working hands-free voice on the board and are a natural review/stop point. Tasks 9–12 add cameras and the dev HUD.

---

## Task 0: Hardware bring-up and the AEC spike

No production code. This task exists because the audio design rests on two facts nobody has measured yet, and discovering them in week three would be expensive.

**Files:**

- Create: `rdk/README.md`

- [ ] **Step 1: Write the provisioning and checklist document**

Create `rdk/README.md`:

````markdown
# Max on RDK X5

Embedded client for the Max helmet assistant. See
`docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`.

## Provisioning

```bash
# Node 22 (Ubuntu 22.04 ships Node 12)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs alsa-utils python3-pip
node --version   # expect v22.13+

sudo mkdir -p /var/lib/max/gallery /run/max
sudo chown -R "$USER" /var/lib/max /run/max
```

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
   Compare the RMS of `/tmp/echo.wav` against a silent reference recording. The
   difference is the coupling. Then try the WebRTC canceller:
   ```bash
   pactl load-module module-echo-cancel aec_method=webrtc source_name=maxmic sink_name=maxspk
   ```
   Repeat the measurement against `-D pulse:maxmic`.
5. **Cameras** — confirm both IMX219 sensors enumerate and note their VIN port
   indices for `RDK_CAMERA_FRONT` / `RDK_CAMERA_REAR`.

## Bench findings

| Item                               | Value | Date |
| ---------------------------------- | ----- | ---- |
| ALSA capture device                |       |      |
| ALSA playback device               |       |      |
| Headset wiring (CTIA/OMTP)         |       |      |
| Raw echo coupling                  |       |      |
| Coupling with `module-echo-cancel` |       |      |
| AEC path chosen                    |       |      |
| Camera front / rear port index     |       |      |
````

- [ ] **Step 2: Run the checklist on the board and fill in "Bench findings"**

Every row must have a value. If step 4 shows `module-echo-cancel` does not
suppress the echo adequately, stop and escalate before Task 7 — the fallback
(half-duplex ducking) costs barge-in, which is a shipped feature on the other
three clients and a product decision, not an implementation detail.

- [ ] **Step 3: Commit**

```bash
git add rdk/README.md
git commit -m "docs(rdk): add board provisioning and hardware bring-up checklist"
```

---

## Task 1: Server-side platform value and failure speech

**Files:**

- Modify: `shared/testing.ts:6`
- Modify: `server/testing-store.ts:620-621`, `server/testing-store.ts:1136-1142`
- Modify: `server/index.ts:385-386`
- Modify: `server/device-actions.ts` (the `FAILURE_SPEECH` map)
- Test: `tests/rdk-platform.test.ts`

**Interfaces:**

- Produces: `TestingPlatform` includes `"embedded"`; `FAILURE_SPEECH` keys
  `"device.noScreen"`, `"device.noPhone"`, `"device.notYet"` usable as
  `DeviceResultEvent.reason` values.

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inferTestingPlatform } from "../server/testing-store";
import { deviceFailureSpeech } from "../server/device-actions";
import { REQUIRED_TESTING_PLATFORMS } from "../shared/testing";

describe("embedded platform", () => {
  it("accepts an explicit embedded platform", () => {
    expect(inferTestingPlatform("embedded")).toBe("embedded");
  });

  it("infers embedded from an RDK device label", () => {
    expect(inferTestingPlatform(undefined, "RDK X5")).toBe("embedded");
  });

  it("still infers the existing platforms", () => {
    expect(inferTestingPlatform("web")).toBe("web");
    expect(inferTestingPlatform(undefined, "iPhone 15")).toBe("ios");
    expect(inferTestingPlatform(undefined, "Pixel 8 android")).toBe("android");
    expect(inferTestingPlatform(undefined, "nothing useful")).toBe("unknown");
  });

  it("does not add embedded to the release-gate platforms", () => {
    expect(REQUIRED_TESTING_PLATFORMS).toEqual(["web", "ios", "android"]);
  });
});

describe("embedded failure speech", () => {
  it("explains a missing screen without naming the gallery", () => {
    expect(deviceFailureSpeech("destination.show", "unsupported", "device.noScreen")).toBe("头盔上没有屏幕，看不了。");
  });

  it("explains missing phone features", () => {
    expect(deviceFailureSpeech("call.dial", "unsupported", "device.noPhone")).toBe(
      "头盔上没有手机功能，这个我做不了。"
    );
  });

  it("explains a not-yet-built feature", () => {
    expect(deviceFailureSpeech("navigation.start", "unsupported", "device.notYet")).toBe("这个功能头盔上还没上线。");
  });
});
```

`REQUIRED_TESTING_PLATFORMS` is currently not exported. Add `export` to it at
`shared/testing.ts:342` as part of this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-platform.test.ts`
Expected: FAIL — `inferTestingPlatform("embedded")` returns `"unknown"`, and the
three speech assertions get the generic `"…操作没成功。"` fallback.

- [ ] **Step 3: Add the platform value**

`shared/testing.ts:6`:

```ts
export type TestingPlatform = "web" | "ios" | "android" | "embedded" | "unknown";
```

`shared/testing.ts:342` — export it, leave the contents alone:

```ts
export const REQUIRED_TESTING_PLATFORMS: TestingPlatform[] = ["web", "ios", "android"];
```

- [ ] **Step 4: Update the three validators**

`server/testing-store.ts:1136` — note `rdk` is checked **before** `web`, since a
device label may contain both:

```ts
export function inferTestingPlatform(value: unknown, deviceLabel?: string, networkType?: string): TestingPlatform {
  if (value === "web" || value === "ios" || value === "android" || value === "embedded") return value;
  const haystack = `${String(deviceLabel ?? "")} ${String(networkType ?? "")}`.toLowerCase();
  if (haystack.includes("ios") || haystack.includes("iphone") || haystack.includes("ipad")) return "ios";
  if (haystack.includes("android")) return "android";
  if (haystack.includes("rdk")) return "embedded";
  if (haystack.includes("browser") || haystack.includes("web")) return "web";
  return "unknown";
}
```

`server/testing-store.ts:620-621`:

```ts
(platform: unknown): platform is TestingPlatform =>
  platform === "web" || platform === "ios" || platform === "android" || platform === "embedded";
```

`server/index.ts:385-386`:

```ts
      platform:
        platform === "web" ||
        platform === "ios" ||
        platform === "android" ||
        platform === "embedded" ||
        platform === "unknown"
          ? (platform as TestingPlatform)
          : undefined,
```

- [ ] **Step 5: Add the three failure lines**

In `server/device-actions.ts`, inside `FAILURE_SPEECH`, after
`"permission.location"`:

```ts
  "device.noScreen": "头盔上没有屏幕，看不了。",
  "device.noPhone": "头盔上没有手机功能，这个我做不了。",
  "device.notYet": "这个功能头盔上还没上线。"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-platform.test.ts`
Expected: PASS, 7 tests.

Run: `npm run check`
Expected: all stages pass. `tsc` will surface any switch or map that must now
handle `"embedded"` exhaustively — fix each by treating embedded like the other
native platforms.

- [ ] **Step 7: Commit**

```bash
git add shared/testing.ts server/testing-store.ts server/index.ts server/device-actions.ts tests/rdk-platform.test.ts
git commit -m "feat(testing): add the embedded platform and helmet refusal speech"
```

---

## Task 2: Pure audio DSP

**Files:**

- Create: `rdk/agent/tsconfig.json`, `rdk/agent/src/audio/dsp.ts`
- Modify: `knip.json`
- Test: `tests/rdk-dsp.test.ts`

**Interfaces:**

- Produces:
  - `CAPTURE_RATE = 48000`, `UPLINK_RATE = 16000`, `DOWNLINK_RATE = 24000`
  - `FRAME_SAMPLES = 320`, `FRAME_BYTES = 640`
  - `designLowPass(taps: number, cutoffHz: number, sampleRate: number): Float32Array`
  - `LOW_PASS_48K: Float32Array`
  - `createDecimator(factor: number, taps: Float32Array): (input: Int16Array) => Int16Array`
  - `createUpsampler2x(): (input: Int16Array) => Int16Array`
  - `softLimitSample(x: number, gain: number, threshold: number): number`
  - `applySoftLimit(input: Int16Array, gain?: number, threshold?: number): Int16Array`
  - `createFramer(frameSamples?: number): (input: Int16Array) => Int16Array[]`
  - `rms(frame: Int16Array): number`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-dsp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FRAME_BYTES,
  FRAME_SAMPLES,
  LOW_PASS_48K,
  applySoftLimit,
  createDecimator,
  createFramer,
  createUpsampler2x,
  designLowPass,
  rms,
  softLimitSample
} from "../rdk/agent/src/audio/dsp";

function tone(hz: number, sampleRate: number, samples: number, amplitude = 0.5): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767);
  }
  return out;
}

describe("designLowPass", () => {
  it("produces an odd-length kernel with unity DC gain", () => {
    const taps = designLowPass(31, 7500, 48000);
    expect(taps.length).toBe(31);
    const sum = taps.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("is symmetric, so the filter has linear phase", () => {
    const taps = designLowPass(31, 7500, 48000);
    for (let i = 0; i < 15; i += 1) {
      expect(taps[i]).toBeCloseTo(taps[30 - i]!, 10);
    }
  });
});

describe("createDecimator", () => {
  it("outputs one sample per factor input samples", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(440, 48000, 4800));
    expect(out.length).toBe(1600);
  });

  it("passes a 440 Hz tone through largely intact", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(440, 48000, 48000));
    // Skip the filter warm-up, then compare energy against the input.
    expect(rms(out.subarray(200))).toBeGreaterThan(0.35 * 32767);
  });

  it("rejects a 20 kHz tone that would otherwise alias to 4 kHz", () => {
    const decimate = createDecimator(3, LOW_PASS_48K);
    const out = decimate(tone(20000, 48000, 48000));
    expect(rms(out.subarray(200))).toBeLessThan(0.02 * 32767);
  });

  it("keeps filter state across chunk boundaries", () => {
    const whole = createDecimator(3, LOW_PASS_48K)(tone(440, 48000, 4800));
    const split = createDecimator(3, LOW_PASS_48K);
    const first = split(tone(440, 48000, 4800).subarray(0, 2400));
    const rest = tone(440, 48000, 4800).subarray(2400);
    const second = split(rest);
    expect(first.length + second.length).toBe(whole.length);
    expect(Array.from(second.subarray(0, 20))).toEqual(Array.from(whole.subarray(first.length, first.length + 20)));
  });
});

describe("createUpsampler2x", () => {
  it("doubles the sample count", () => {
    const up = createUpsampler2x();
    expect(up(tone(440, 24000, 240)).length).toBe(480);
  });

  it("places the original samples on odd indices", () => {
    const up = createUpsampler2x();
    const input = Int16Array.from([1000, 2000, 3000]);
    const out = up(input);
    expect(out[1]).toBe(1000);
    expect(out[3]).toBe(2000);
    expect(out[5]).toBe(3000);
  });

  it("interpolates across chunk boundaries", () => {
    const up = createUpsampler2x();
    up(Int16Array.from([1000]));
    const out = up(Int16Array.from([3000]));
    expect(out[0]).toBe(2000);
  });
});

describe("softLimitSample", () => {
  it("is linear below the threshold", () => {
    expect(softLimitSample(0.2, 1.6, 0.7)).toBeCloseTo(0.32, 6);
  });

  it("never exceeds full scale", () => {
    for (const x of [0.8, 0.95, 1, -1, -0.95]) {
      expect(Math.abs(softLimitSample(x, 4, 0.7))).toBeLessThanOrEqual(1);
    }
  });

  it("is sign-symmetric", () => {
    expect(softLimitSample(-0.9, 1.6, 0.7)).toBeCloseTo(-softLimitSample(0.9, 1.6, 0.7), 10);
  });

  it("is monotonic", () => {
    let previous = -Infinity;
    for (let x = -1; x <= 1; x += 0.05) {
      const value = softLimitSample(x, 1.6, 0.7);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe("applySoftLimit", () => {
  it("clamps a loud buffer inside int16 range", () => {
    const loud = tone(440, 24000, 240, 0.99);
    for (const sample of applySoftLimit(loud, 4, 0.7)) {
      expect(sample).toBeLessThanOrEqual(32767);
      expect(sample).toBeGreaterThanOrEqual(-32768);
    }
  });
});

describe("createFramer", () => {
  it("emits only whole frames and buffers the remainder", () => {
    const frame = createFramer();
    expect(frame(new Int16Array(100))).toEqual([]);
    const out = frame(new Int16Array(600));
    expect(out.length).toBe(2);
    expect(out[0]!.length).toBe(FRAME_SAMPLES);
    expect(out[0]!.byteLength).toBe(FRAME_BYTES);
  });

  it("preserves sample order across calls", () => {
    const frame = createFramer(4);
    frame(Int16Array.from([1, 2, 3]));
    const out = frame(Int16Array.from([4, 5, 6, 7, 8]));
    expect(Array.from(out[0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(out[1]!)).toEqual([5, 6, 7, 8]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-dsp.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/audio/dsp`.

- [ ] **Step 3: Write the implementation**

Create `rdk/agent/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `rdk/agent/src/audio/dsp.ts`:

```ts
/**
 * Pure DSP for the embedded audio path. The board captures and plays at 48 kHz
 * while the relay protocol is 16 kHz up / 24 kHz down; both are exact integer
 * ratios, so conversion is cheap and lossless to specify. We do it here rather
 * than letting ALSA's `plughw:` plug layer resample, because the plug layer
 * hides the rate mismatch, resamples at mediocre quality, and costs us exact
 * frame alignment.
 */

export const CAPTURE_RATE = 48_000;
export const UPLINK_RATE = 16_000;
export const DOWNLINK_RATE = 24_000;

/** 20 ms at 16 kHz — byte-identical to `public/pcm-worklet.js`. */
export const FRAME_SAMPLES = 320;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * Windowed-sinc low-pass. `taps` must be odd so the kernel is symmetric about a
 * whole sample, which gives linear phase.
 */
export function designLowPass(taps: number, cutoffHz: number, sampleRate: number): Float32Array {
  if (taps % 2 === 0) throw new Error("designLowPass requires an odd tap count");
  const kernel = new Float32Array(taps);
  const middle = (taps - 1) / 2;
  const fc = cutoffHz / sampleRate;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - middle;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i]!;
  }
  for (let i = 0; i < taps; i += 1) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/**
 * Anti-alias filter for 48 kHz → 16 kHz. The cutoff sits below the 8 kHz Nyquist
 * of the decimated rate: without it, naive ÷3 decimation folds everything above
 * 8 kHz back into the speech band and degrades ASR.
 */
export const LOW_PASS_48K = designLowPass(31, 7_500, CAPTURE_RATE);

function clampPcm(value: number): number {
  const scaled = Math.round(value * 32768);
  if (scaled > 32767) return 32767;
  if (scaled < -32768) return -32768;
  return scaled;
}

/**
 * Streaming decimator. Retains `taps.length - 1` samples of history and the
 * decimation phase across calls, so chunk boundaries are invisible in the
 * output.
 */
export function createDecimator(factor: number, taps: Float32Array): (input: Int16Array) => Int16Array {
  const width = taps.length;
  let history = new Float32Array(width - 1);
  let phase = 0;

  return (input: Int16Array): Int16Array => {
    const total = history.length + input.length;
    const buffer = new Float32Array(total);
    buffer.set(history, 0);
    for (let i = 0; i < input.length; i += 1) {
      buffer[history.length + i] = input[i]! / 32768;
    }

    const out: number[] = [];
    for (let i = width - 1; i < total; i += 1) {
      if (phase === 0) {
        let accumulator = 0;
        for (let k = 0; k < width; k += 1) accumulator += taps[k]! * buffer[i - k]!;
        out.push(clampPcm(accumulator));
      }
      phase = (phase + 1) % factor;
    }

    history = buffer.slice(total - (width - 1));
    return Int16Array.from(out);
  };
}

/**
 * Linear 2× interpolation for 24 kHz → 48 kHz. Original samples land on odd
 * indices; the midpoint between the previous and current sample lands on even
 * ones. The previous sample is retained so chunk boundaries interpolate.
 */
export function createUpsampler2x(): (input: Int16Array) => Int16Array {
  let previous = 0;
  return (input: Int16Array): Int16Array => {
    const out = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i]!;
      out[i * 2] = Math.round((previous + current) / 2);
      out[i * 2 + 1] = current;
      previous = current;
    }
    return out;
  };
}

/**
 * Per-sample soft limiter, matching the iOS/Android behavior: the helmet speaker
 * needs real gain, but a hard clip sounds harsh. Below the threshold this is
 * plain gain; above it the excess is compressed with a tanh knee that
 * asymptotically approaches full scale without ever crossing it.
 */
export function softLimitSample(x: number, gain: number, threshold: number): number {
  const boosted = x * gain;
  const magnitude = Math.abs(boosted);
  if (magnitude <= threshold) return boosted;
  const range = 1 - threshold;
  const shaped = threshold + range * Math.tanh((magnitude - threshold) / range);
  return boosted < 0 ? -shaped : shaped;
}

export function applySoftLimit(input: Int16Array, gain = 1.6, threshold = 0.7): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = clampPcm(softLimitSample(input[i]! / 32768, gain, threshold));
  }
  return out;
}

/** Buffers a sample stream into fixed-size frames, retaining any remainder. */
export function createFramer(frameSamples = FRAME_SAMPLES): (input: Int16Array) => Int16Array[] {
  let pending = new Int16Array(0);
  return (input: Int16Array): Int16Array[] => {
    const merged = new Int16Array(pending.length + input.length);
    merged.set(pending, 0);
    merged.set(input, pending.length);

    const frames: Int16Array[] = [];
    let offset = 0;
    while (merged.length - offset >= frameSamples) {
      frames.push(merged.slice(offset, offset + frameSamples));
      offset += frameSamples;
    }
    pending = merged.slice(offset);
    return frames;
  };
}

/** Root-mean-square of a PCM16 frame, in int16 units. */
export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-dsp.test.ts`
Expected: PASS, 15 tests. The alias-rejection test is the one that matters — if
it fails, the kernel is wrong, not the test.

- [ ] **Step 5: Keep the dead-code gate green**

`knip` has no entry point for `rdk/agent/src/main.ts` and would report the whole
tree as unused. Add `rdk/**` to the ignore list in `knip.json`:

```json
{
  "ignore": ["public/pcm-worklet.js", "rdk/**"]
}
```

The board client's dead-code coverage comes from its own tests and review
instead. The alternative — adding an explicit `entry` array — replaces knip's
inferred defaults for the whole repo and risks false positives in existing code.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: all stages pass.

- [ ] **Step 7: Commit**

```bash
git add rdk/agent/tsconfig.json rdk/agent/src/audio/dsp.ts tests/rdk-dsp.test.ts knip.json
git commit -m "feat(rdk): add pure audio DSP for the embedded capture and playback paths"
```

---

## Task 3: Local voice gate

The helmet has no button. When the relay idle-closes with code 4001, web/iOS/Android
just stay offline until the rider taps something — here there is nothing to tap.
This gate answers only "is anyone talking at all", so a parked helmet stops
holding a Doubao upstream slot but a speaking rider gets a session back.

This is **not** wake-word detection; that stays server-side in `shared/wake.ts`.

**Files:**

- Create: `rdk/agent/src/audio/voice-gate.ts`
- Test: `tests/rdk-voice-gate.test.ts`

**Interfaces:**

- Consumes: `rms`, `FRAME_SAMPLES` from `rdk/agent/src/audio/dsp`
- Produces:
  - `type VoiceGateConfig = { rmsThreshold: number; sustainMs: number; releaseMs: number; frameMs: number }`
  - `DEFAULT_VOICE_GATE: VoiceGateConfig`
  - `createVoiceGate(config?: Partial<VoiceGateConfig>): (frame: Int16Array) => boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-voice-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES } from "../rdk/agent/src/audio/dsp";
import { DEFAULT_VOICE_GATE, createVoiceGate } from "../rdk/agent/src/audio/voice-gate";

function frameAt(amplitude: number): Int16Array {
  const out = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    out[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return out;
}

const LOUD = frameAt(4000);
const QUIET = frameAt(100);

describe("createVoiceGate", () => {
  it("starts closed", () => {
    const gate = createVoiceGate();
    expect(gate(QUIET)).toBe(false);
  });

  it("stays closed for a single loud frame", () => {
    const gate = createVoiceGate();
    expect(gate(LOUD)).toBe(false);
  });

  it("opens once speech is sustained", () => {
    const gate = createVoiceGate({ sustainMs: 100, frameMs: 20 });
    let open = false;
    for (let i = 0; i < 5; i += 1) open = gate(LOUD);
    expect(open).toBe(true);
  });

  it("resets the sustain counter when speech stops early", () => {
    const gate = createVoiceGate({ sustainMs: 100, frameMs: 20 });
    gate(LOUD);
    gate(LOUD);
    gate(QUIET);
    let open = false;
    for (let i = 0; i < 4; i += 1) open = gate(LOUD);
    expect(open).toBe(false);
  });

  it("holds open through brief gaps, then releases", () => {
    const gate = createVoiceGate({ sustainMs: 40, releaseMs: 100, frameMs: 20 });
    gate(LOUD);
    expect(gate(LOUD)).toBe(true);
    expect(gate(QUIET)).toBe(true);
    expect(gate(QUIET)).toBe(true);
    expect(gate(QUIET)).toBe(true);
    expect(gate(QUIET)).toBe(true);
    expect(gate(QUIET)).toBe(false);
  });

  it("uses a lower close threshold than open threshold", () => {
    // Hysteresis: a level between the two thresholds must not reopen the gate,
    // but must keep an already-open gate open.
    const between = frameAt(Math.round(DEFAULT_VOICE_GATE.rmsThreshold * 0.8));
    const opening = createVoiceGate();
    for (let i = 0; i < 50; i += 1) opening(between);
    expect(opening(between)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-voice-gate.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/audio/voice-gate`.

- [ ] **Step 3: Write the implementation**

Create `rdk/agent/src/audio/voice-gate.ts`:

```ts
import { rms } from "./dsp";

export type VoiceGateConfig = {
  /** Int16 RMS above which a frame counts as speech. */
  rmsThreshold: number;
  /** How long speech must persist before the gate opens. */
  sustainMs: number;
  /** How long quiet must persist before an open gate closes. */
  releaseMs: number;
  /** Duration of one frame, used to convert the millisecond budgets to counts. */
  frameMs: number;
};

/**
 * Defaults for a helmet at speed. These are a starting point, not a measured
 * result — wind noise raises the floor and the bench will move them.
 */
export const DEFAULT_VOICE_GATE: VoiceGateConfig = {
  rmsThreshold: 900,
  sustainMs: 400,
  releaseMs: 800,
  frameMs: 20
};

/** Below this fraction of the open threshold, an open gate starts releasing. */
const CLOSE_RATIO = 0.6;

/**
 * RMS gate with hysteresis. Returns the gate state after each frame: `true`
 * means "someone is talking, a session is warranted".
 */
export function createVoiceGate(config: Partial<VoiceGateConfig> = {}): (frame: Int16Array) => boolean {
  const { rmsThreshold, sustainMs, releaseMs, frameMs } = { ...DEFAULT_VOICE_GATE, ...config };
  const sustainFrames = Math.max(1, Math.ceil(sustainMs / frameMs));
  const releaseFrames = Math.max(1, Math.ceil(releaseMs / frameMs));
  const closeThreshold = rmsThreshold * CLOSE_RATIO;

  let open = false;
  let loudRun = 0;
  let quietRun = 0;

  return (frame: Int16Array): boolean => {
    const level = rms(frame);

    if (open) {
      if (level < closeThreshold) {
        quietRun += 1;
        if (quietRun >= releaseFrames) {
          open = false;
          loudRun = 0;
          quietRun = 0;
        }
      } else {
        quietRun = 0;
      }
      return open;
    }

    if (level >= rmsThreshold) {
      loudRun += 1;
      if (loudRun >= sustainFrames) {
        open = true;
        quietRun = 0;
      }
    } else {
      loudRun = 0;
    }
    return open;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-voice-gate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/audio/voice-gate.ts tests/rdk-voice-gate.test.ts
git commit -m "feat(rdk): add the local voice gate that re-arms a session after idle close"
```

---

## Task 4: Vision IPC codec and client

**Files:**

- Create: `rdk/agent/src/vision-client.ts`
- Test: `tests/rdk-vision-client.test.ts`

**Interfaces:**

- Produces:
  - `type VisionStatus = "ok" | "failed" | "denied" | "unsupported"`
  - `type VisionRequest = { id: string; op: string; args: Record<string, unknown> }`
  - `type VisionResponse = { id: string; status: VisionStatus; reason?: string; detail?: string }`
  - `type VisionEvent = { event: string; [key: string]: unknown }`
  - `encodeRequest(request: VisionRequest): string`
  - `createLineDecoder(): (chunk: string) => (VisionResponse | VisionEvent)[]`
  - `isVisionResponse(message: VisionResponse | VisionEvent): message is VisionResponse`
  - `createVisionClient(options: VisionClientOptions): VisionClient`
  - `type VisionClient = { request(op: string, args?: Record<string, unknown>): Promise<VisionResponse>; handleChunk(chunk: string): void; failAllPending(reason: string): void }`
  - `type VisionClientOptions = { send(line: string): void; onEvent(event: VisionEvent): void; timeoutMs?: number; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-vision-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createLineDecoder,
  createVisionClient,
  encodeRequest,
  isVisionResponse,
  type VisionEvent
} from "../rdk/agent/src/vision-client";

describe("encodeRequest", () => {
  it("emits one newline-terminated JSON object", () => {
    const line = encodeRequest({ id: "c7", op: "camera.photo", args: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({ id: "c7", op: "camera.photo", args: {} });
  });
});

describe("createLineDecoder", () => {
  it("decodes whole lines", () => {
    const decode = createLineDecoder();
    const out = decode('{"id":"a","status":"ok"}\n{"event":"hazard"}\n');
    expect(out.length).toBe(2);
    expect(isVisionResponse(out[0]!)).toBe(true);
    expect(isVisionResponse(out[1]!)).toBe(false);
  });

  it("buffers a partial line until it completes", () => {
    const decode = createLineDecoder();
    expect(decode('{"id":"a","sta')).toEqual([]);
    const out = decode('tus":"ok"}\n');
    expect(out).toEqual([{ id: "a", status: "ok" }]);
  });

  it("skips malformed lines rather than throwing", () => {
    const decode = createLineDecoder();
    const out = decode('not json\n{"id":"b","status":"failed"}\n');
    expect(out).toEqual([{ id: "b", status: "failed" }]);
  });

  it("ignores blank lines", () => {
    const decode = createLineDecoder();
    expect(decode("\n\n")).toEqual([]);
  });
});

describe("createVisionClient", () => {
  it("correlates a response to its request", async () => {
    const sent: string[] = [];
    const client = createVisionClient({ send: (line) => sent.push(line), onEvent: () => {} });
    const pending = client.request("camera.photo");
    const id = JSON.parse(sent[0]!.trim()).id as string;
    client.handleChunk(`${JSON.stringify({ id, status: "ok", detail: "pair-1" })}\n`);
    await expect(pending).resolves.toEqual({ id, status: "ok", detail: "pair-1" });
  });

  it("issues distinct ids", () => {
    const sent: string[] = [];
    const client = createVisionClient({ send: (line) => sent.push(line), onEvent: () => {} });
    void client.request("camera.photo");
    void client.request("camera.photo");
    const first = JSON.parse(sent[0]!.trim()).id;
    const second = JSON.parse(sent[1]!.trim()).id;
    expect(first).not.toBe(second);
  });

  it("routes unsolicited events to onEvent", () => {
    const events: VisionEvent[] = [];
    const client = createVisionClient({ send: () => {}, onEvent: (event) => events.push(event) });
    client.handleChunk('{"event":"hazard","threat":"rear_approach"}\n');
    expect(events).toEqual([{ event: "hazard", threat: "rear_approach" }]);
  });

  it("resolves as failed when the sidecar does not answer in time", async () => {
    vi.useFakeTimers();
    const client = createVisionClient({ send: () => {}, onEvent: () => {}, timeoutMs: 5000 });
    const pending = client.request("camera.record", { start: true });
    vi.advanceTimersByTime(5000);
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "capture.failed" });
    vi.useRealTimers();
  });

  it("fails every pending request when the socket dies", async () => {
    const client = createVisionClient({ send: () => {}, onEvent: () => {} });
    const pending = client.request("camera.photo");
    client.failAllPending("capture.failed");
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "capture.failed" });
  });

  it("ignores a response for an unknown id", () => {
    const client = createVisionClient({ send: () => {}, onEvent: () => {} });
    expect(() => client.handleChunk('{"id":"ghost","status":"ok"}\n')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-vision-client.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/vision-client`.

- [ ] **Step 3: Write the implementation**

Create `rdk/agent/src/vision-client.ts`:

```ts
/**
 * Control-plane client for the Python vision sidecar.
 *
 * The transport is newline-delimited JSON over a unix socket, deliberately
 * bidirectional: requests carry an `id` and get exactly one response with the
 * same `id`, while the sidecar may also push unsolicited messages carrying
 * `event`. That second channel is how a future BPU ADAS loop will report
 * hazards without redrawing this boundary.
 *
 * Preview frames never travel here — the sidecar serves those as MJPEG over
 * local HTTP, straight to the dev HUD, so this socket stays small and readable.
 */

export type VisionStatus = "ok" | "failed" | "denied" | "unsupported";

export type VisionRequest = {
  id: string;
  op: string;
  args: Record<string, unknown>;
};

export type VisionResponse = {
  id: string;
  status: VisionStatus;
  reason?: string;
  detail?: string;
};

export type VisionEvent = {
  event: string;
  [key: string]: unknown;
};

export type VisionClientOptions = {
  send(line: string): void;
  onEvent(event: VisionEvent): void;
  /** Must stay below the relay's DEVICE_RESULT_TIMEOUT_MS (8 s) so we always
   *  answer the relay ourselves rather than letting it time us out. */
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type VisionClient = {
  request(op: string, args?: Record<string, unknown>): Promise<VisionResponse>;
  handleChunk(chunk: string): void;
  failAllPending(reason: string): void;
};

export function encodeRequest(request: VisionRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function isVisionResponse(message: VisionResponse | VisionEvent): message is VisionResponse {
  return typeof (message as VisionResponse).id === "string";
}

/**
 * Splits a byte stream into JSON messages. A malformed line is skipped rather
 * than thrown: one bad frame from the sidecar must not take the voice path down.
 */
export function createLineDecoder(): (chunk: string) => (VisionResponse | VisionEvent)[] {
  let buffer = "";
  return (chunk: string): (VisionResponse | VisionEvent)[] => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    const messages: (VisionResponse | VisionEvent)[] = [];
    for (const part of parts) {
      const line = part.trim();
      if (line === "") continue;
      try {
        messages.push(JSON.parse(line) as VisionResponse | VisionEvent);
      } catch {
        // Skip: a corrupt line is not worth dropping the connection over.
      }
    }
    return messages;
  };
}

const DEFAULT_TIMEOUT_MS = 6_000;

export function createVisionClient(options: VisionClientOptions): VisionClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const decode = createLineDecoder();

  type Pending = {
    resolve(response: VisionResponse): void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  let counter = 0;

  function settle(id: string, response: VisionResponse): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimer(entry.timer);
    entry.resolve(response);
  }

  return {
    request(op: string, args: Record<string, unknown> = {}): Promise<VisionResponse> {
      counter += 1;
      const id = `v${counter}`;
      return new Promise<VisionResponse>((resolve) => {
        const timer = setTimer(() => {
          settle(id, { id, status: "failed", reason: "capture.failed" });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        options.send(encodeRequest({ id, op, args }));
      });
    },

    handleChunk(chunk: string): void {
      for (const message of decode(chunk)) {
        if (isVisionResponse(message)) {
          settle(message.id, message);
        } else {
          options.onEvent(message);
        }
      }
    },

    failAllPending(reason: string): void {
      for (const id of [...pending.keys()]) {
        settle(id, { id, status: "failed", reason });
      }
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-vision-client.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/vision-client.ts tests/rdk-vision-client.test.ts
git commit -m "feat(rdk): add the NDJSON vision control-socket client"
```

---

## Task 5: Capability matrix and device dispatch

**Files:**

- Create: `rdk/agent/src/device/capabilities.ts`, `rdk/agent/src/device/dispatch.ts`
- Test: `tests/rdk-device-dispatch.test.ts`

**Interfaces:**

- Consumes: `VisionClient`, `VisionResponse` from `rdk/agent/src/vision-client`;
  `DeviceActionName`, `DeviceActionStatus` from `server/device-actions`;
  `DeviceResultEvent` from `shared/agent`
- Produces:
  - `type EmbeddedCapability = { supported: boolean; reason?: string }`
  - `EMBEDDED_CAPABILITIES: Record<DeviceActionName, EmbeddedCapability>`
  - `capabilityFor(action: DeviceActionName): EmbeddedCapability`
  - `createDeviceDispatcher(options: DispatcherOptions): (command: DeviceCommand) => Promise<DeviceResultEvent>`
  - `type DeviceCommand = { commandId: string; action: DeviceActionName; args: Record<string, unknown> }`
  - `type DispatcherOptions = { vision: VisionClient; setVolume(level: number): Promise<boolean> }`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-device-dispatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DeviceActionName } from "../server/device-actions";
import { deviceFailureSpeech } from "../server/device-actions";
import { EMBEDDED_CAPABILITIES, capabilityFor } from "../rdk/agent/src/device/capabilities";
import { createDeviceDispatcher } from "../rdk/agent/src/device/dispatch";
import type { VisionClient, VisionResponse } from "../rdk/agent/src/vision-client";

function fakeVision(response: VisionResponse): VisionClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async (op: string) => {
      calls.push(op);
      return response;
    },
    handleChunk: () => {},
    failAllPending: () => {}
  };
}

describe("EMBEDDED_CAPABILITIES", () => {
  it("covers every device action the relay can send", () => {
    const actions: DeviceActionName[] = [
      "torch.set",
      "volume.set",
      "music.control",
      "sms.compose",
      "call.dial",
      "destination.show",
      "camera.photo",
      "camera.record",
      "gallery.open",
      "navigation.start",
      "navigation.stop"
    ];
    for (const action of actions) {
      expect(EMBEDDED_CAPABILITIES[action]).toBeDefined();
    }
  });

  it("supports only the actions the helmet hardware can actually perform", () => {
    const supported = Object.entries(EMBEDDED_CAPABILITIES)
      .filter(([, capability]) => capability.supported)
      .map(([action]) => action)
      .sort();
    expect(supported).toEqual(["camera.photo", "camera.record", "volume.set"]);
  });

  it("gives every refusal a reason that maps to real speech", () => {
    for (const [action, capability] of Object.entries(EMBEDDED_CAPABILITIES)) {
      if (capability.supported) continue;
      expect(capability.reason).toBeTruthy();
      const speech = deviceFailureSpeech(action as DeviceActionName, "unsupported", capability.reason);
      expect(speech.endsWith("操作没成功。")).toBe(false);
    }
  });

  it("does not blame a missing phone for unbuilt navigation", () => {
    expect(capabilityFor("navigation.start").reason).toBe("device.notYet");
    expect(capabilityFor("gallery.open").reason).toBe("device.noScreen");
    expect(capabilityFor("call.dial").reason).toBe("device.noPhone");
  });
});

describe("createDeviceDispatcher", () => {
  it("refuses an unsupported action without touching the sidecar", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c1", action: "gallery.open", args: {} });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c1",
      status: "unsupported",
      reason: "device.noScreen"
    });
    expect(vision.calls).toEqual([]);
  });

  it("forwards a photo to the sidecar and echoes the command id", async () => {
    const vision = fakeVision({ id: "v1", status: "ok", detail: "pair-20260725-142233" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c2", action: "camera.photo", args: {} });
    expect(vision.calls).toEqual(["camera.photo"]);
    expect(result).toEqual({
      type: "device.result",
      commandId: "c2",
      status: "ok",
      detail: "pair-20260725-142233"
    });
  });

  it("passes a sidecar refusal through verbatim", async () => {
    const vision = fakeVision({ id: "v1", status: "failed", reason: "storage.full" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c3", action: "camera.record", args: { start: true } });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("storage.full");
  });

  it("handles volume locally", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    let applied = -1;
    const dispatch = createDeviceDispatcher({
      vision,
      setVolume: async (level) => {
        applied = level;
        return true;
      }
    });
    const result = await dispatch({ commandId: "c4", action: "volume.set", args: { level: 0.5 } });
    expect(applied).toBe(0.5);
    expect(result.status).toBe("ok");
    expect(vision.calls).toEqual([]);
  });

  it("reports failure when the mixer will not move", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => false });
    const result = await dispatch({ commandId: "c5", action: "volume.set", args: { level: 0.5 } });
    expect(result.status).toBe("failed");
  });

  it("never lets a thrown handler swallow the result", async () => {
    const vision: VisionClient = {
      request: async () => {
        throw new Error("socket gone");
      },
      handleChunk: () => {},
      failAllPending: () => {}
    };
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c6", action: "camera.photo", args: {} });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c6",
      status: "failed",
      reason: "capture.failed"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-device-dispatch.test.ts`
Expected: FAIL — cannot resolve the two new modules.

- [ ] **Step 3: Write the capability matrix**

Create `rdk/agent/src/device/capabilities.ts`:

```ts
import type { DeviceActionName } from "../../../../server/device-actions";

export type EmbeddedCapability = {
  supported: boolean;
  /** A `FAILURE_SPEECH` key from server/device-actions.ts. Required when
   *  `supported` is false, so the rider hears why rather than "没成功". */
  reason?: string;
};

/**
 * What the helmet can honestly do.
 *
 * `gallery.open` is deliberately unsupported: the dev HUD can display the
 * gallery, but it is a bench instrument the rider cannot see, and replying `ok`
 * would have Max claim the rider is looking at photos that are not in front of
 * them.
 *
 * Navigation gets `device.notYet` rather than `device.noPhone` because
 * audio-only turn-by-turn needs neither a phone nor a screen — it simply is not
 * built yet, and claiming otherwise would be a false explanation.
 */
export const EMBEDDED_CAPABILITIES: Record<DeviceActionName, EmbeddedCapability> = {
  "camera.photo": { supported: true },
  "camera.record": { supported: true },
  "volume.set": { supported: true },
  "gallery.open": { supported: false, reason: "device.noScreen" },
  "destination.show": { supported: false, reason: "device.noScreen" },
  "torch.set": { supported: false, reason: "torch.unavailable" },
  "music.control": { supported: false, reason: "device.noPhone" },
  "sms.compose": { supported: false, reason: "device.noPhone" },
  "call.dial": { supported: false, reason: "device.noPhone" },
  "navigation.start": { supported: false, reason: "device.notYet" },
  "navigation.stop": { supported: false, reason: "device.notYet" }
};

export function capabilityFor(action: DeviceActionName): EmbeddedCapability {
  return EMBEDDED_CAPABILITIES[action] ?? { supported: false, reason: "device.notYet" };
}
```

Note the relative depth: `rdk/agent/src/device/` → four levels up to the repo
root.

- [ ] **Step 4: Write the dispatcher**

Create `rdk/agent/src/device/dispatch.ts`:

```ts
import type { DeviceActionName } from "../../../../server/device-actions";
import type { DeviceResultEvent } from "../../../../shared/agent";
import type { VisionClient } from "../vision-client";
import { capabilityFor } from "./capabilities";

export type DeviceCommand = {
  commandId: string;
  action: DeviceActionName;
  args: Record<string, unknown>;
};

export type DispatcherOptions = {
  vision: VisionClient;
  /** Applies playback volume on the ES8326B mixer. Resolves false if the mixer
   *  did not move, so Max never claims a volume change that did not happen. */
  setVolume(level: number): Promise<boolean>;
};

/**
 * Turns one `device.command` into exactly one `device.result`. Every path —
 * including a thrown handler — produces a result, because the relay treats
 * silence past DEVICE_RESULT_TIMEOUT_MS as failure and would then speak a
 * failure line we could have made specific.
 */
export function createDeviceDispatcher(
  options: DispatcherOptions
): (command: DeviceCommand) => Promise<DeviceResultEvent> {
  return async (command: DeviceCommand): Promise<DeviceResultEvent> => {
    const capability = capabilityFor(command.action);
    if (!capability.supported) {
      return {
        type: "device.result",
        commandId: command.commandId,
        status: "unsupported",
        reason: capability.reason
      };
    }

    try {
      if (command.action === "volume.set") {
        const level = typeof command.args["level"] === "number" ? (command.args["level"] as number) : NaN;
        const applied = Number.isFinite(level) ? await options.setVolume(level) : false;
        return applied
          ? { type: "device.result", commandId: command.commandId, status: "ok" }
          : { type: "device.result", commandId: command.commandId, status: "failed" };
      }

      const response = await options.vision.request(command.action, command.args);
      const result: DeviceResultEvent = {
        type: "device.result",
        commandId: command.commandId,
        status: response.status
      };
      if (response.reason !== undefined) result.reason = response.reason;
      if (response.detail !== undefined) result.detail = response.detail;
      return result;
    } catch {
      return {
        type: "device.result",
        commandId: command.commandId,
        status: "failed",
        reason: "capture.failed"
      };
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-device-dispatch.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/device tests/rdk-device-dispatch.test.ts
git commit -m "feat(rdk): add the embedded capability matrix and device dispatcher"
```

---

## Task 6: Relay client

**Files:**

- Create: `rdk/agent/src/config.ts`, `rdk/agent/src/relay.ts`
- Test: `tests/rdk-relay.test.ts`

**Interfaces:**

- Consumes: `AgentEvent`, `SessionStartEvent`, `DeviceResultEvent`,
  `SessionMemorySnapshot`, `IDLE_CLOSE_CODE` from `shared/agent`
- Produces:
  - `type RdkConfig` and `loadConfig(env?: NodeJS.ProcessEnv): RdkConfig`
  - `buildSessionStart(config: RdkConfig, memory?: SessionMemorySnapshot): SessionStartEvent`
  - `nextBackoffMs(attempt: number): number`
  - `type RelayHandlers = { onEvent(event: AgentEvent): void; onVoice(pcm: Int16Array): void; onReady(): void; onClosed(idle: boolean): void }`
  - `createRelayClient(config: RdkConfig, handlers: RelayHandlers): RelayClient`
  - `type RelayClient = { connect(): void; disconnect(): void; sendFrame(frame: Int16Array): void; sendEvent(event: unknown): void; isReady(): boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-relay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import { buildSessionStart, loadConfig, nextBackoffMs } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("requires a relay URL", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/MAX_RELAY_URL/);
  });

  it("defaults the audio and gallery settings", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.alsaCapture).toBe("plughw:0,0");
    expect(config.alsaPlayback).toBe("plughw:0,0");
    expect(config.galleryMinFreeMb).toBe(1024);
    expect(config.hudPort).toBe(8080);
    expect(config.insecureTls).toBe(false);
  });

  it("keeps insecure TLS off unless explicitly enabled", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "0" }).insecureTls).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "yes" }).insecureTls).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "1" }).insecureTls).toBe(true);
  });

  it("rejects a non-numeric port rather than silently using NaN", () => {
    expect(() => loadConfig({ ...BASE_ENV, MAX_HUD_PORT: "abc" })).toThrow(/MAX_HUD_PORT/);
  });
});

describe("buildSessionStart", () => {
  it("declares the embedded platform and the uplink format", () => {
    const event = buildSessionStart(loadConfig(BASE_ENV));
    expect(event.type).toBe("session.start");
    expect(event.sampleRate).toBe(16000);
    expect(event.channels).toBe(1);
    expect(event.platform).toBe("embedded");
    expect(event.deviceLabel).toBe("RDK X5");
  });

  it("echoes a session-memory snapshot when one is known", () => {
    const event = buildSessionStart(loadConfig(BASE_ENV), {
      language: "zh",
      destination: "杭州",
      responseMode: "normal"
    });
    expect(event.memory).toEqual({ language: "zh", destination: "杭州", responseMode: "normal" });
  });

  it("omits memory entirely on a cold start", () => {
    expect(buildSessionStart(loadConfig(BASE_ENV)).memory).toBeUndefined();
  });
});

describe("nextBackoffMs", () => {
  it("grows exponentially from one second", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
  });

  it("caps so a parked helmet does not back off forever", () => {
    expect(nextBackoffMs(20)).toBe(30000);
  });
});

describe("idle close contract", () => {
  it("uses the shared code the relay actually sends", () => {
    expect(IDLE_CLOSE_CODE).toBe(4001);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-relay.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/relay`.

- [ ] **Step 3: Write the config module**

Create `rdk/agent/src/config.ts`:

```ts
export type RdkConfig = {
  relayUrl: string;
  insecureTls: boolean;
  alsaCapture: string;
  alsaPlayback: string;
  cameraFront: string;
  cameraRear: string;
  galleryDir: string;
  galleryMinFreeMb: number;
  hudPort: number;
  visionPreviewPort: number;
  visionSocket: string;
  voiceGateRms: number;
  voiceGateMs: number;
};

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function optionalNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got ${value}`);
  return parsed;
}

/** Only the exact string "1" enables the self-signed escape hatch. Anything
 *  vaguer ("yes", "true") is treated as off, so a typo cannot quietly disable
 *  certificate validation. */
function optionalFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key]?.trim() === "1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RdkConfig {
  return {
    relayUrl: requireString(env, "MAX_RELAY_URL"),
    insecureTls: optionalFlag(env, "MAX_RELAY_INSECURE_TLS"),
    alsaCapture: optionalString(env, "RDK_ALSA_CAPTURE", "plughw:0,0"),
    alsaPlayback: optionalString(env, "RDK_ALSA_PLAYBACK", "plughw:0,0"),
    cameraFront: optionalString(env, "RDK_CAMERA_FRONT", "0"),
    cameraRear: optionalString(env, "RDK_CAMERA_REAR", "1"),
    galleryDir: optionalString(env, "MAX_GALLERY_DIR", "/var/lib/max/gallery"),
    galleryMinFreeMb: optionalNumber(env, "MAX_GALLERY_MIN_FREE_MB", 1024),
    hudPort: optionalNumber(env, "MAX_HUD_PORT", 8080),
    visionPreviewPort: optionalNumber(env, "MAX_VISION_PREVIEW_PORT", 8081),
    visionSocket: optionalString(env, "MAX_VISION_SOCKET", "/run/max/vision.sock"),
    voiceGateRms: optionalNumber(env, "MAX_VOICE_GATE_RMS", 900),
    voiceGateMs: optionalNumber(env, "MAX_VOICE_GATE_MS", 400)
  };
}
```

- [ ] **Step 4: Write the relay client**

Create `rdk/agent/src/relay.ts`:

```ts
import WebSocket from "ws";
import {
  IDLE_CLOSE_CODE,
  type AgentEvent,
  type SessionMemorySnapshot,
  type SessionStartEvent
} from "../../../shared/agent";
import { UPLINK_RATE } from "./audio/dsp";
import { loadConfig, type RdkConfig } from "./config";

export { loadConfig };
export type { RdkConfig };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export function nextBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

export function buildSessionStart(config: RdkConfig, memory?: SessionMemorySnapshot): SessionStartEvent {
  const event: SessionStartEvent = {
    type: "session.start",
    sampleRate: UPLINK_RATE,
    channels: 1,
    platform: "embedded",
    deviceLabel: "RDK X5",
    networkType: "wifi"
  };
  if (memory) event.memory = memory;
  void config;
  return event;
}

export type RelayHandlers = {
  onEvent(event: AgentEvent): void;
  onVoice(pcm: Int16Array): void;
  onReady(): void;
  /** `idle` is true when the relay closed us with IDLE_CLOSE_CODE, which must
   *  NOT trigger an automatic reconnect — the local voice gate re-arms instead. */
  onClosed(idle: boolean): void;
};

export type RelayClient = {
  connect(): void;
  disconnect(): void;
  sendFrame(frame: Int16Array): void;
  sendEvent(event: unknown): void;
  isReady(): boolean;
};

export function createRelayClient(config: RdkConfig, handlers: RelayHandlers): RelayClient {
  let socket: WebSocket | null = null;
  let ready = false;
  let memory: SessionMemorySnapshot | undefined;
  let intentional = false;

  function open(): void {
    ready = false;
    intentional = false;
    socket = new WebSocket(config.relayUrl, { rejectUnauthorized: !config.insecureTls });
    socket.binaryType = "nodebuffer";

    socket.on("open", () => {
      socket?.send(JSON.stringify(buildSessionStart(config, memory)));
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Downlink voice is 24 kHz PCM16; Buffer may not be 2-byte aligned in
        // its parent ArrayBuffer, so copy rather than view.
        const copy = Buffer.from(data);
        handlers.onVoice(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2));
        return;
      }
      let event: AgentEvent;
      try {
        event = JSON.parse(data.toString("utf8")) as AgentEvent;
      } catch {
        return;
      }
      if (event.type === "session.started") {
        ready = true;
        socket?.send(JSON.stringify({ type: "audio.start" }));
        handlers.onReady();
      }
      if (event.type === "session.memory") {
        memory = {
          language: event.language,
          destination: event.destination,
          lastIntent: event.lastIntent,
          responseMode: event.responseMode
        };
      }
      handlers.onEvent(event);
    });

    socket.on("close", (code: number) => {
      ready = false;
      socket = null;
      handlers.onClosed(code === IDLE_CLOSE_CODE || intentional);
    });

    socket.on("error", () => {
      // `close` always follows; recovery is handled there.
    });
  }

  return {
    connect: open,
    disconnect(): void {
      intentional = true;
      ready = false;
      socket?.close();
      socket = null;
    },
    sendFrame(frame: Int16Array): void {
      // Gate on session.started: transmitting earlier produces the startup
      // burst the other clients were changed to avoid.
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), { binary: true });
    },
    sendEvent(event: unknown): void {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    },
    isReady(): boolean {
      return ready;
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-relay.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/config.ts rdk/agent/src/relay.ts tests/rdk-relay.test.ts
git commit -m "feat(rdk): add relay config, session start, and the /agent websocket client"
```

---

## Task 7: ALSA capture and playback

`arecord`/`aplay` child processes are used rather than a native addon so the
board needs no `node-gyp` toolchain. Both modules take an injectable `spawn`, so
the process lifecycle is testable without ALSA.

**Files:**

- Create: `rdk/agent/src/audio/capture.ts`, `rdk/agent/src/audio/playback.ts`
- Test: `tests/rdk-audio-io.test.ts`

**Interfaces:**

- Consumes: `createDecimator`, `createFramer`, `createUpsampler2x`, `applySoftLimit`,
  `LOW_PASS_48K`, `CAPTURE_RATE` from `./dsp`
- Produces:
  - `type SpawnLike = (command: string, args: string[]) => ChildProcessLike`
  - `type ChildProcessLike = { stdout: NodeJS.ReadableStream | null; stdin: NodeJS.WritableStream | null; kill(signal?: string): void; on(event: "exit", listener: () => void): void }`
  - `captureArgs(device: string): string[]`
  - `playbackArgs(device: string): string[]`
  - `createCapture(options: CaptureOptions): { start(): void; stop(): void }`
  - `createPlayback(options: PlaybackOptions): { write(pcm: Int16Array): void; flush(): void; stop(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-audio-io.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { FRAME_SAMPLES } from "../rdk/agent/src/audio/dsp";
import { captureArgs, createCapture } from "../rdk/agent/src/audio/capture";
import { createPlayback, playbackArgs } from "../rdk/agent/src/audio/playback";

function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const kill = vi.fn();
  return {
    child: { stdout, stdin, kill, on: () => {} },
    stdout,
    stdin,
    kill
  };
}

describe("captureArgs", () => {
  it("captures raw 48 kHz mono PCM16 from the configured device", () => {
    const args = captureArgs("plughw:1,0");
    expect(args).toContain("-D");
    expect(args).toContain("plughw:1,0");
    expect(args).toContain("48000");
    expect(args).toContain("S16_LE");
    expect(args.join(" ")).toContain("-t raw");
  });
});

describe("playbackArgs", () => {
  it("caps the ALSA buffer so barge-in leaves at most ~120 ms of tail", () => {
    const args = playbackArgs("plughw:1,0");
    const index = args.indexOf("--buffer-size");
    expect(index).toBeGreaterThanOrEqual(0);
    // 48 kHz × 0.12 s = 5760 frames.
    expect(Number(args[index + 1])).toBeLessThanOrEqual(5760);
  });
});

describe("createCapture", () => {
  it("emits 320-sample frames from a 48 kHz byte stream", () => {
    const fake = fakeChild();
    const frames: Int16Array[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: (frame) => frames.push(frame)
    });
    capture.start();

    // 2880 samples at 48 kHz decimate to 960 at 16 kHz = exactly 3 frames.
    const pcm = new Int16Array(2880);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin(i / 20) * 8000);
    fake.stdout.write(Buffer.from(pcm.buffer));

    expect(frames.length).toBe(3);
    expect(frames[0]!.length).toBe(FRAME_SAMPLES);
  });

  it("tolerates a chunk with an odd byte count", () => {
    const fake = fakeChild();
    const capture = createCapture({ device: "plughw:0,0", spawn: () => fake.child, onFrame: () => {} });
    capture.start();
    expect(() => fake.stdout.write(Buffer.from([1, 2, 3]))).not.toThrow();
  });

  it("kills the child on stop", () => {
    const fake = fakeChild();
    const capture = createCapture({ device: "plughw:0,0", spawn: () => fake.child, onFrame: () => {} });
    capture.start();
    capture.stop();
    expect(fake.kill).toHaveBeenCalled();
  });
});

describe("createPlayback", () => {
  it("upsamples 24 kHz to 48 kHz before writing", () => {
    const fake = fakeChild();
    const written: Buffer[] = [];
    fake.stdin.on("data", (chunk: Buffer) => written.push(chunk));
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    const total = written.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBe(240 * 2 * 2); // doubled samples, 2 bytes each
  });

  it("respawns aplay on flush so barge-in drops the queued tail", () => {
    let spawns = 0;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        spawns += 1;
        return fakeChild().child;
      }
    });
    playback.write(new Int16Array(240));
    expect(spawns).toBe(1);
    playback.flush();
    playback.write(new Int16Array(240));
    expect(spawns).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: FAIL — cannot resolve the two new modules.

- [ ] **Step 3: Write the capture module**

Create `rdk/agent/src/audio/capture.ts`:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { CAPTURE_RATE, LOW_PASS_48K, createDecimator, createFramer } from "./dsp";

export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: string): void;
  on(event: "exit", listener: () => void): void;
};

export type SpawnLike = (command: string, args: string[]) => ChildProcessLike;

export type CaptureOptions = {
  device: string;
  onFrame(frame: Int16Array): void;
  spawn?: SpawnLike;
};

export function captureArgs(device: string): string[] {
  return ["-D", device, "-f", "S16_LE", "-r", String(CAPTURE_RATE), "-c", "1", "-t", "raw", "-q"];
}

/**
 * Streams microphone audio as 16 kHz PCM16 frames.
 *
 * The device name is the AEC seam: point `RDK_ALSA_CAPTURE` at the raw card for
 * a bare pipeline, or at an echo-cancelled virtual source, and nothing here
 * changes.
 */
export function createCapture(options: CaptureOptions): { start(): void; stop(): void } {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  let child: ChildProcessLike | null = null;
  let leftover = Buffer.alloc(0);

  return {
    start(): void {
      if (child) return;
      const decimate = createDecimator(3, LOW_PASS_48K);
      const frame = createFramer();
      leftover = Buffer.alloc(0);

      child = spawn("arecord", captureArgs(options.device));
      child.stdout?.on("data", (chunk: Buffer) => {
        // ALSA hands us bytes, not samples: a chunk can split a sample in half.
        const merged = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = merged.length - (merged.length % 2);
        leftover = merged.subarray(usable);

        const samples = new Int16Array(usable / 2);
        for (let i = 0; i < samples.length; i += 1) samples[i] = merged.readInt16LE(i * 2);

        for (const output of frame(decimate(samples))) options.onFrame(output);
      });
    },
    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
```

- [ ] **Step 4: Write the playback module**

Create `rdk/agent/src/audio/playback.ts`:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { CAPTURE_RATE, applySoftLimit, createUpsampler2x } from "./dsp";
import type { ChildProcessLike, SpawnLike } from "./capture";

/**
 * 120 ms at 48 kHz. `aplay`'s ALSA buffer cannot be drained from outside the
 * process, so this cap is what bounds the residual tail when the rider barges
 * in — the default (~500 ms) would leave Max talking over them for half a
 * second, which the other three clients never do.
 */
const BUFFER_FRAMES = 5_760;

export type PlaybackOptions = {
  device: string;
  spawn?: SpawnLike;
  gain?: number;
  threshold?: number;
};

export function playbackArgs(device: string): string[] {
  return [
    "-D",
    device,
    "-f",
    "S16_LE",
    "-r",
    String(CAPTURE_RATE),
    "-c",
    "1",
    "-t",
    "raw",
    "--buffer-size",
    String(BUFFER_FRAMES),
    "-q"
  ];
}

export function createPlayback(options: PlaybackOptions): {
  write(pcm: Int16Array): void;
  flush(): void;
  stop(): void;
} {
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args) as unknown as ChildProcessLike);
  let child: ChildProcessLike | null = null;
  let upsample = createUpsampler2x();

  function ensure(): ChildProcessLike {
    if (!child) {
      child = spawn("aplay", playbackArgs(options.device));
      upsample = createUpsampler2x();
    }
    return child;
  }

  return {
    /** Accepts 24 kHz PCM16 from the relay. */
    write(pcm: Int16Array): void {
      const target = ensure();
      const limited = applySoftLimit(upsample(pcm), options.gain, options.threshold);
      target.stdin?.write(Buffer.from(limited.buffer, limited.byteOffset, limited.byteLength));
    },

    /** Barge-in. Killing the child is what actually discards the queued tail;
     *  the next write respawns it. */
    flush(): void {
      child?.kill("SIGKILL");
      child = null;
    },

    stop(): void {
      child?.kill("SIGTERM");
      child = null;
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/audio/capture.ts rdk/agent/src/audio/playback.ts tests/rdk-audio-io.test.ts
git commit -m "feat(rdk): add ALSA capture and playback with bounded barge-in latency"
```

---

## Task 8: Wire the voice path and ship it as a service

This completes the voice milestone: the board boots, connects, listens, and
answers.

**Files:**

- Create: `rdk/agent/src/main.ts`, `rdk/systemd/max-agent.service`
- Modify: `rdk/README.md` (run instructions)
- Test: `tests/rdk-session-policy.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–7
- Produces: `decideReconnect(reason: CloseReason, gateOpen: boolean): "now" | "wait-for-voice" | "never"`
  and `type CloseReason = "idle" | "dropped" | "intentional"`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-session-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideReconnect } from "../rdk/agent/src/main";

describe("decideReconnect", () => {
  it("reconnects immediately after an unexpected drop", () => {
    expect(decideReconnect("dropped", false)).toBe("now");
  });

  it("waits for the rider's voice after an idle close", () => {
    expect(decideReconnect("idle", false)).toBe("wait-for-voice");
  });

  it("reconnects after an idle close once the gate opens", () => {
    expect(decideReconnect("idle", true)).toBe("now");
  });

  it("stays offline after an intentional shutdown", () => {
    expect(decideReconnect("intentional", true)).toBe("never");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-session-policy.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/main`.

- [ ] **Step 3: Write main.ts**

Create `rdk/agent/src/main.ts`:

```ts
import { spawn } from "node:child_process";
import { createCapture } from "./audio/capture";
import { createPlayback } from "./audio/playback";
import { createVoiceGate } from "./audio/voice-gate";
import { loadConfig } from "./config";
import { createDeviceDispatcher } from "./device/dispatch";
import { createRelayClient, nextBackoffMs } from "./relay";
import { createVisionClient } from "./vision-client";

export type CloseReason = "idle" | "dropped" | "intentional";

/**
 * Reconnect policy. The idle case is the embedded-only one: the relay frees the
 * upstream slot on purpose, and blindly reconnecting would immediately re-open
 * what the idle timeout just closed. With no button on the helmet, the local
 * voice gate is what brings the session back.
 */
export function decideReconnect(reason: CloseReason, gateOpen: boolean): "now" | "wait-for-voice" | "never" {
  if (reason === "intentional") return "never";
  if (reason === "dropped") return "now";
  return gateOpen ? "now" : "wait-for-voice";
}

/** Applies playback volume on the ES8326B mixer. Resolves false if amixer did
 *  not exit cleanly, so Max never claims a volume change that did not happen. */
function setAlsaVolume(device: string, level: number): Promise<boolean> {
  return new Promise((resolve) => {
    const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
    const card = device.includes(":") ? (device.split(":")[1]?.split(",")[0] ?? "0") : "0";
    const child = spawn("amixer", ["-c", card, "sset", "Playback", `${percent}%`]);
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function start(): void {
  const config = loadConfig();
  let closeReason: CloseReason = "dropped";
  let attempt = 0;
  let waitingForVoice = false;

  const gate = createVoiceGate({ rmsThreshold: config.voiceGateRms, sustainMs: config.voiceGateMs });
  const playback = createPlayback({ device: config.alsaPlayback });

  const vision = createVisionClient({
    send: () => {
      // Wired to the unix socket in Task 9; camera actions fail truthfully
      // until then.
    },
    onEvent: (event) => console.log("[vision]", JSON.stringify(event))
  });

  const dispatch = createDeviceDispatcher({
    vision,
    setVolume: (level) => setAlsaVolume(config.alsaPlayback, level)
  });

  const relay = createRelayClient(config, {
    onReady: () => {
      attempt = 0;
      waitingForVoice = false;
      console.log("[relay] session ready");
    },
    onVoice: (pcm) => playback.write(pcm),
    onEvent: (event) => {
      if (event.type === "status" && event.state === "hearing") {
        // Barge-in: the rider started talking, so drop the queued reply.
        playback.flush();
      }
      if (event.type === "hazard.alert" && event.interrupt) {
        playback.flush();
      }
      if (event.type === "device.command") {
        void dispatch({ commandId: event.commandId, action: event.action, args: event.args }).then((result) =>
          relay.sendEvent(result)
        );
      }
    },
    onClosed: (idle) => {
      playback.flush();
      closeReason = idle ? "idle" : "dropped";
      const decision = decideReconnect(closeReason, false);
      if (decision === "never") return;
      if (decision === "wait-for-voice") {
        waitingForVoice = true;
        console.log("[relay] idle close; waiting for the rider to speak");
        return;
      }
      const delay = nextBackoffMs(attempt);
      attempt += 1;
      console.log(`[relay] reconnecting in ${delay} ms`);
      setTimeout(() => relay.connect(), delay);
    }
  });

  const capture = createCapture({
    device: config.alsaCapture,
    onFrame: (frame) => {
      const speaking = gate(frame);
      if (waitingForVoice && speaking) {
        waitingForVoice = false;
        console.log("[relay] rider spoke; reopening the session");
        relay.connect();
      }
      relay.sendFrame(frame);
    }
  });

  capture.start();
  relay.connect();

  const shutdown = (): void => {
    closeReason = "intentional";
    capture.stop();
    playback.stop();
    relay.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start when executed directly, so the tests can import decideReconnect.
if (process.argv[1]?.endsWith("main.ts")) start();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-session-policy.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the systemd unit**

Create `rdk/systemd/max-agent.service`:

```ini
[Unit]
Description=Max helmet agent (RDK X5)
After=network-online.target max-vision.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/max/agent.env
WorkingDirectory=/opt/max
ExecStart=/usr/bin/npx tsx rdk/agent/src/main.ts
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`After=` names `max-vision.service` but does not `Require=` it: if vision is
down, the agent still runs and camera actions fail truthfully rather than taking
the voice path down with them.

- [ ] **Step 6: Add run instructions to the board README**

Append to `rdk/README.md`:

````markdown
## Running

```bash
sudo mkdir -p /etc/max
sudo tee /etc/max/agent.env >/dev/null <<'ENV'
MAX_RELAY_URL=ws://<lan-ip>:8787/agent
MAX_RELAY_INSECURE_TLS=0
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
MAX_VISION_SOCKET=/run/max/vision.sock
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
ENV

sudo cp rdk/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now max-agent
journalctl -u max-agent -f
```

Only the exact string `1` enables `MAX_RELAY_INSECURE_TLS`; anything else leaves
certificate validation on.
````

- [ ] **Step 7: Verify on hardware**

With `npm run dev:server` running on the LAN host:

1. `systemctl start max-agent`, then `journalctl -u max-agent -f` — expect
   `[relay] session ready`.
2. Say "Max，现在天气怎么样" into the headset and hear a spoken reply.
3. Interrupt a reply mid-sentence; speech must stop within ~120 ms.
4. Unplug and replug the headset; the service recovers without a restart.

- [ ] **Step 8: Run the full gate and commit**

Run: `npm run check`
Expected: all stages pass.

```bash
git add rdk/agent/src/main.ts rdk/systemd/max-agent.service rdk/README.md tests/rdk-session-policy.test.ts
git commit -m "feat(rdk): wire the embedded voice path and run it as a systemd service"
```

**Milestone A complete** — hands-free voice works on the board. Good place to
stop and review before cameras.

---

## Task 9: Vision sidecar RPC skeleton

**Files:**

- Create: `rdk/vision/rpc.py`, `rdk/vision/service.py`, `rdk/vision/tests/test_rpc.py`
- Create: `rdk/systemd/max-vision.service`

**Interfaces:**

- Produces:
  - `decode_lines(buffer: str) -> tuple[list[dict], str]`
  - `encode_response(request_id: str, status: str, reason: str | None = None, detail: str | None = None) -> str`
  - `encode_event(name: str, **fields) -> str`
  - `dispatch(message: dict, handlers: dict[str, Callable[[dict], dict]]) -> str`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_rpc.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rpc import decode_lines, dispatch, encode_event, encode_response


def test_decode_lines_returns_whole_messages_and_remainder():
    messages, rest = decode_lines('{"id":"a","op":"ping","args":{}}\n{"id":"b"')
    assert messages == [{"id": "a", "op": "ping", "args": {}}]
    assert rest == '{"id":"b"'


def test_decode_lines_skips_malformed_lines():
    messages, rest = decode_lines('garbage\n{"id":"a"}\n')
    assert messages == [{"id": "a"}]
    assert rest == ""


def test_encode_response_is_one_newline_terminated_object():
    line = encode_response("c7", "ok", detail="pair-1")
    assert line.endswith("\n")
    assert json.loads(line) == {"id": "c7", "status": "ok", "detail": "pair-1"}


def test_encode_response_omits_empty_fields():
    assert json.loads(encode_response("c7", "ok")) == {"id": "c7", "status": "ok"}


def test_encode_event_has_no_id():
    payload = json.loads(encode_event("hazard", threat="rear_approach"))
    assert payload == {"event": "hazard", "threat": "rear_approach"}
    assert "id" not in payload


def test_dispatch_routes_to_the_handler():
    handlers = {"camera.photo": lambda args: {"status": "ok", "detail": "pair-1"}}
    line = dispatch({"id": "c1", "op": "camera.photo", "args": {}}, handlers)
    assert json.loads(line) == {"id": "c1", "status": "ok", "detail": "pair-1"}


def test_dispatch_reports_an_unknown_op_as_unsupported():
    line = dispatch({"id": "c2", "op": "nope", "args": {}}, {})
    assert json.loads(line)["status"] == "unsupported"


def test_dispatch_converts_a_raised_handler_into_a_failure():
    def boom(args):
        raise RuntimeError("camera exploded")

    line = dispatch({"id": "c3", "op": "camera.photo", "args": {}}, {"camera.photo": boom})
    payload = json.loads(line)
    assert payload["status"] == "failed"
    assert payload["reason"] == "capture.failed"


def test_dispatch_ignores_a_message_with_no_id():
    assert dispatch({"op": "camera.photo", "args": {}}, {}) == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_rpc.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'rpc'`.

- [ ] **Step 3: Write the RPC module**

Create `rdk/vision/rpc.py`:

```python
"""Newline-delimited JSON control protocol for the Max vision sidecar.

Requests carry an ``id`` and receive exactly one response with the same ``id``.
The sidecar may also push unsolicited messages carrying ``event`` — that channel
is how a future BPU ADAS loop reports hazards without changing this boundary.

Preview frames never travel here; they are served as MJPEG over local HTTP.
"""

from __future__ import annotations

import json
from typing import Callable

Handler = Callable[[dict], dict]


def decode_lines(buffer: str) -> tuple[list[dict], str]:
    """Split a byte-stream fragment into whole messages plus the remainder.

    A malformed line is skipped rather than raised: one bad frame must not take
    the control socket down.
    """
    parts = buffer.split("\n")
    rest = parts.pop()
    messages: list[dict] = []
    for part in parts:
        line = part.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return messages, rest


def encode_response(
    request_id: str,
    status: str,
    reason: str | None = None,
    detail: str | None = None,
) -> str:
    payload: dict = {"id": request_id, "status": status}
    if reason:
        payload["reason"] = reason
    if detail:
        payload["detail"] = detail
    return json.dumps(payload, ensure_ascii=False) + "\n"


def encode_event(name: str, **fields) -> str:
    return json.dumps({"event": name, **fields}, ensure_ascii=False) + "\n"


def dispatch(message: dict, handlers: dict[str, Handler]) -> str:
    """Run one request and return the line to write back.

    Returns an empty string for a message with no ``id`` — the agent correlates
    on it, so a response without one could never be matched.
    """
    request_id = message.get("id")
    if not isinstance(request_id, str):
        return ""

    handler = handlers.get(message.get("op", ""))
    if handler is None:
        return encode_response(request_id, "unsupported", reason="device.notYet")

    try:
        result = handler(message.get("args") or {})
    except Exception:  # noqa: BLE001 - any handler fault must still answer
        return encode_response(request_id, "failed", reason="capture.failed")

    return encode_response(
        request_id,
        result.get("status", "ok"),
        reason=result.get("reason"),
        detail=result.get("detail"),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_rpc.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the service entry point and unit file**

Create `rdk/vision/service.py`:

```python
"""Max vision sidecar: owns the cameras, captures, gallery, and MJPEG preview."""

from __future__ import annotations

import os
import socketserver
import threading

from camera import CameraPair
from gallery import Gallery
from rpc import decode_lines, dispatch

SOCKET_PATH = os.environ.get("MAX_VISION_SOCKET", "/run/max/vision.sock")
GALLERY_DIR = os.environ.get("MAX_GALLERY_DIR", "/var/lib/max/gallery")
MIN_FREE_MB = int(os.environ.get("MAX_GALLERY_MIN_FREE_MB", "1024"))
PREVIEW_PORT = int(os.environ.get("MAX_VISION_PREVIEW_PORT", "8081"))

gallery = Gallery(GALLERY_DIR, MIN_FREE_MB)
cameras = CameraPair(
    front_port=os.environ.get("RDK_CAMERA_FRONT", "0"),
    rear_port=os.environ.get("RDK_CAMERA_REAR", "1"),
)

HANDLERS = {
    "camera.photo": lambda args: cameras.capture_photo(gallery),
    "camera.record": lambda args: (
        cameras.start_recording(gallery) if args.get("start") else cameras.stop_recording(gallery)
    ),
}


class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        buffer = ""
        while True:
            chunk = self.rfile.readline()
            if not chunk:
                return
            buffer += chunk.decode("utf-8", errors="replace")
            messages, buffer = decode_lines(buffer)
            for message in messages:
                line = dispatch(message, HANDLERS)
                if line:
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True


def main() -> None:
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

    cameras.open()
    threading.Thread(target=cameras.serve_preview, args=(PREVIEW_PORT,), daemon=True).start()

    with ControlServer(SOCKET_PATH, ControlHandler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    main()
```

Create `rdk/systemd/max-vision.service`:

```ini
[Unit]
Description=Max helmet vision sidecar (RDK X5)

[Service]
Type=simple
EnvironmentFile=/etc/max/agent.env
WorkingDirectory=/opt/max/rdk/vision
ExecStart=/usr/bin/python3 service.py
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`service.py` imports `camera` and `gallery`, which arrive in Tasks 10 and 11. Do
not run it until Task 11 is complete.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/rpc.py rdk/vision/service.py rdk/vision/tests/test_rpc.py rdk/systemd/max-vision.service
git commit -m "feat(rdk): add the vision sidecar NDJSON control protocol"
```

---

## Task 10: Gallery storage rules

**Files:**

- Create: `rdk/vision/gallery.py`, `rdk/vision/tests/test_gallery.py`

**Interfaces:**

- Produces:
  - `MAX_RECORDING_SECONDS = 600`
  - `class Gallery(root: str, min_free_mb: int)` with `has_space() -> bool`,
    `new_pair_id(now: datetime) -> str`, `pair_dir(pair_id: str) -> Path`,
    `write_manifest(pair_id: str, front: str | None, rear: str | None, kind: str) -> Path`,
    `list_pairs() -> list[dict]`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_gallery.py`:

```python
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from gallery import MAX_RECORDING_SECONDS, Gallery


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


def test_recording_cap_matches_the_ios_rule():
    assert MAX_RECORDING_SECONDS == 600


def test_pair_id_is_sortable_and_timestamped(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    assert pair_id == "pair-20260725-142233"


def test_pair_ids_do_not_collide_within_a_second(gallery):
    now = datetime(2026, 7, 25, 14, 22, 33)
    first = gallery.new_pair_id(now)
    second = gallery.new_pair_id(now)
    assert first != second


def test_has_space_refuses_when_below_the_floor(tmp_path):
    huge = Gallery(str(tmp_path), min_free_mb=10**9)
    assert huge.has_space() is False


def test_has_space_allows_when_the_floor_is_met(gallery):
    assert gallery.has_space() is True


def test_write_manifest_records_both_sides(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    path = gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    payload = json.loads(path.read_text())
    assert payload["front"] == "front.jpg"
    assert payload["rear"] == "rear.jpg"
    assert payload["kind"] == "photo"


def test_write_manifest_records_a_degraded_pair(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    path = gallery.write_manifest(pair_id, "front.jpg", None, "photo")
    payload = json.loads(path.read_text())
    assert payload["rear"] is None
    assert payload["degraded"] is True


def test_manifest_write_is_atomic(gallery):
    pair_id = gallery.new_pair_id(datetime(2026, 7, 25, 14, 22, 33))
    gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    # No temp file survives a completed write.
    assert list(gallery.pair_dir(pair_id).glob("*.tmp")) == []


def test_list_pairs_is_newest_first(gallery):
    for stamp in [
        datetime(2026, 7, 25, 10, 0, 0),
        datetime(2026, 7, 25, 12, 0, 0),
        datetime(2026, 7, 25, 11, 0, 0),
    ]:
        pair_id = gallery.new_pair_id(stamp)
        gallery.write_manifest(pair_id, "front.jpg", "rear.jpg", "photo")
    ids = [pair["id"] for pair in gallery.list_pairs()]
    assert ids == sorted(ids, reverse=True)


def test_list_pairs_ignores_a_directory_with_no_manifest(gallery):
    (Path(gallery.root) / "pair-garbage").mkdir(parents=True)
    assert gallery.list_pairs() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_gallery.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gallery'`.

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/gallery.py`:

```python
"""Keep-until-deleted capture storage for the helmet.

Storage rules mirror the iOS gallery: nothing auto-deletes, captures are refused
when free space runs low, and a recording stops itself at ten minutes.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

#: Matches the iOS recording cap.
MAX_RECORDING_SECONDS = 600


class Gallery:
    def __init__(self, root: str, min_free_mb: int) -> None:
        self.root = root
        self.min_free_mb = min_free_mb
        Path(self.root).mkdir(parents=True, exist_ok=True)
        self._counter = 0

    def has_space(self) -> bool:
        free_mb = shutil.disk_usage(self.root).free / (1024 * 1024)
        return free_mb >= self.min_free_mb

    def new_pair_id(self, now: datetime) -> str:
        """Sortable identifier. A monotonic suffix is appended after the first
        capture in a given second, so two fast captures cannot collide."""
        base = f"pair-{now:%Y%m%d-%H%M%S}"
        self._counter += 1
        return base if self._counter == 1 else f"{base}-{self._counter}"

    def pair_dir(self, pair_id: str) -> Path:
        return Path(self.root) / pair_id

    def write_manifest(self, pair_id: str, front: str | None, rear: str | None, kind: str) -> Path:
        """Write the pair manifest atomically, so a reader never sees a partial
        record if power is cut mid-write."""
        directory = self.pair_dir(pair_id)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": pair_id,
            "kind": kind,
            "front": front,
            "rear": rear,
            "degraded": front is None or rear is None,
        }
        final = directory / "manifest.json"
        temporary = directory / "manifest.json.tmp"
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, final)
        return final

    def list_pairs(self) -> list[dict]:
        pairs: list[dict] = []
        for directory in sorted(Path(self.root).iterdir(), reverse=True):
            manifest = directory / "manifest.json"
            if not directory.is_dir() or not manifest.exists():
                continue
            try:
                pairs.append(json.loads(manifest.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        return pairs
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/test_gallery.py -v`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/gallery.py rdk/vision/tests/test_gallery.py
git commit -m "feat(rdk): add gallery storage rules with a space guard and atomic manifests"
```

---

## Task 11: Camera capture and preview

The `libsrcampy` calls are the one part of this plan that cannot be verified
off-board. Keep the module thin so the untestable surface stays small: all
policy lives in `gallery.py` and `rpc.py`, which are covered by pytest.

**Files:**

- Create: `rdk/vision/camera.py`
- Test: `rdk/vision/tests/test_camera_policy.py`

**Interfaces:**

- Consumes: `Gallery`, `MAX_RECORDING_SECONDS` from `gallery`
- Produces: `class CameraPair(front_port: str, rear_port: str)` with `open()`,
  `capture_photo(gallery) -> dict`, `start_recording(gallery) -> dict`,
  `stop_recording(gallery) -> dict`, `serve_preview(port: int)`

- [ ] **Step 1: Write the failing test**

Create `rdk/vision/tests/test_camera_policy.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera import CameraPair
from gallery import Gallery


class FakeSensor:
    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def get_img(self):
        if not self.works:
            raise RuntimeError("sensor offline")
        self.frames += 1
        return b"\xff\xd8fake-jpeg\xff\xd9"


@pytest.fixture()
def pair(tmp_path):
    cameras = CameraPair(front_port="0", rear_port="1")
    cameras.front = FakeSensor()
    cameras.rear = FakeSensor()
    cameras.opened = True
    return cameras


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


def test_photo_captures_both_cameras(pair, gallery):
    result = pair.capture_photo(gallery)
    assert result["status"] == "ok"
    assert pair.front.frames == 1
    assert pair.rear.frames == 1


def test_photo_is_refused_when_space_is_low(pair, tmp_path):
    full = Gallery(str(tmp_path), min_free_mb=10**9)
    result = pair.capture_photo(full)
    assert result["status"] == "failed"
    assert result["reason"] == "storage.full"


def test_photo_survives_one_dead_camera(pair, gallery):
    pair.rear = FakeSensor(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "ok"
    assert "degraded" in result["detail"]


def test_photo_fails_when_both_cameras_are_dead(pair, gallery):
    pair.front = FakeSensor(works=False)
    pair.rear = FakeSensor(works=False)
    result = pair.capture_photo(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "capture.failed"


def test_double_start_is_refused(pair, gallery):
    assert pair.start_recording(gallery)["status"] == "ok"
    result = pair.start_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.recording"


def test_stop_without_start_is_refused(pair, gallery):
    result = pair.stop_recording(gallery)
    assert result["status"] == "failed"
    assert result["reason"] == "camera.notRecording"


def test_start_then_stop_succeeds(pair, gallery):
    pair.start_recording(gallery)
    assert pair.stop_recording(gallery)["status"] == "ok"


def test_recording_is_refused_when_space_is_low(pair, tmp_path):
    full = Gallery(str(tmp_path), min_free_mb=10**9)
    result = pair.start_recording(full)
    assert result["status"] == "failed"
    assert result["reason"] == "storage.full"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rdk/vision && python3 -m pytest tests/test_camera_policy.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'camera'`.

- [ ] **Step 3: Write the implementation**

Create `rdk/vision/camera.py`:

```python
"""Front and rear IMX219 cameras on the RDK X5 VIN/ISP pipeline.

Both sensors stay open for the life of the service. The relay's
DEVICE_RESULT_TIMEOUT_MS is 8 s, and cold-starting the VIN pipeline inside a
capture could exceed it — which would have Max tell the rider the capture failed
when it had not. Keeping the sensors streaming reduces a capture to a frame grab.

`libsrcampy` is only available on the board, so it is imported lazily: the policy
tests run anywhere, and only `open()` needs real hardware.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

from gallery import MAX_RECORDING_SECONDS, Gallery

WIDTH = 1920
HEIGHT = 1080


class CameraPair:
    def __init__(self, front_port: str, rear_port: str) -> None:
        self.front_port = front_port
        self.rear_port = rear_port
        self.front = None
        self.rear = None
        self.opened = False
        self.recording_id: str | None = None
        self.recording_started_at: float | None = None
        self._lock = threading.Lock()
        self._stop_timer: threading.Timer | None = None

    def open(self) -> None:
        from hobot_vio import libsrcampy  # noqa: PLC0415 - board-only import

        self.front = libsrcampy.Camera()
        self.front.open_cam(int(self.front_port), -1, 30, WIDTH, HEIGHT)
        self.rear = libsrcampy.Camera()
        self.rear.open_cam(int(self.rear_port), -1, 30, WIDTH, HEIGHT)
        self.opened = True

    def _grab(self, sensor) -> bytes | None:
        try:
            return sensor.get_img()
        except Exception:  # noqa: BLE001 - one dead sensor must not fail the pair
            return None

    def capture_photo(self, gallery: Gallery) -> dict:
        if not gallery.has_space():
            return {"status": "failed", "reason": "storage.full"}

        pair_id = gallery.new_pair_id(datetime.now())
        directory = gallery.pair_dir(pair_id)
        directory.mkdir(parents=True, exist_ok=True)

        front_name = None
        rear_name = None
        for name, sensor in (("front.jpg", self.front), ("rear.jpg", self.rear)):
            data = self._grab(sensor)
            if data is None:
                continue
            (directory / name).write_bytes(data)
            if name.startswith("front"):
                front_name = name
            else:
                rear_name = name

        if front_name is None and rear_name is None:
            return {"status": "failed", "reason": "capture.failed"}

        gallery.write_manifest(pair_id, front_name, rear_name, "photo")
        degraded = front_name is None or rear_name is None
        return {"status": "ok", "detail": f"{pair_id}{' degraded' if degraded else ''}"}

    def start_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            if self.recording_id is not None:
                return {"status": "failed", "reason": "camera.recording"}
            if not gallery.has_space():
                return {"status": "failed", "reason": "storage.full"}

            pair_id = gallery.new_pair_id(datetime.now())
            gallery.pair_dir(pair_id).mkdir(parents=True, exist_ok=True)
            self.recording_id = pair_id
            self.recording_started_at = time.monotonic()

        # Hard stop at the cap, so a forgotten recording cannot fill the disk.
        self._stop_timer = threading.Timer(MAX_RECORDING_SECONDS, lambda: self.stop_recording(gallery))
        self._stop_timer.daemon = True
        self._stop_timer.start()
        return {"status": "ok", "detail": pair_id}

    def stop_recording(self, gallery: Gallery) -> dict:
        with self._lock:
            pair_id = self.recording_id
            if pair_id is None:
                return {"status": "failed", "reason": "camera.notRecording"}
            self.recording_id = None
            self.recording_started_at = None

        if self._stop_timer is not None:
            self._stop_timer.cancel()
            self._stop_timer = None

        gallery.write_manifest(pair_id, "front.h264", "rear.h264", "video")
        return {"status": "ok", "detail": pair_id}

    def serve_preview(self, port: int) -> None:
        """MJPEG preview for the dev HUD. Deliberately served over HTTP rather
        than the control socket, so image bytes never pass through the agent."""
        pair = self

        class PreviewHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                sensor = pair.front if self.path.endswith("front") else pair.rear
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.end_headers()
                while True:
                    data = pair._grab(sensor)
                    if data is None:
                        time.sleep(0.5)
                        continue
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    time.sleep(1 / 10)

            def log_message(self, *args) -> None:
                return

        HTTPServer(("0.0.0.0", port), PreviewHandler).serve_forever()
```

The H.264 encoder wiring inside `start_recording` / `stop_recording` is the
board-only part: attach `libsrcampy.Encoder` to each sensor when starting and
release it when stopping, writing to `front.h264` / `rear.h264` in the pair
directory. The state machine, space guard, and cap above are what the tests
cover and must not change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rdk/vision && python3 -m pytest tests/ -v`
Expected: PASS, 27 tests across all three files.

- [ ] **Step 5: Connect the agent to the socket**

In `rdk/agent/src/main.ts`, replace the placeholder `createVisionClient` call
with a real unix-socket connection:

```ts
import { Socket } from "node:net";

function connectVision(socketPath: string) {
  const socket = new Socket();
  const client = createVisionClient({
    send: (line) => socket.write(line),
    onEvent: (event) => console.log("[vision]", JSON.stringify(event))
  });
  socket.on("data", (chunk: Buffer) => client.handleChunk(chunk.toString("utf8")));
  // A dead sidecar must not leave the relay waiting: fail everything in flight
  // so each command still gets exactly one device.result.
  socket.on("error", () => client.failAllPending("capture.failed"));
  socket.on("close", () => {
    client.failAllPending("capture.failed");
    setTimeout(() => socket.connect(socketPath), 2000);
  });
  socket.connect(socketPath);
  return client;
}
```

and use `const vision = connectVision(config.visionSocket);`.

- [ ] **Step 6: Verify on hardware**

1. `systemctl start max-vision max-agent`.
2. Open `http://<board>:8081/preview/front` and `/preview/rear` — both show live video.
3. Say "拍照" — a `pair-*` directory appears under `/var/lib/max/gallery` with
   two JPEGs and a manifest.
4. Say "开始录像", wait, then "停止录像" — two `.h264` files and a manifest.
5. Say "开始录像" twice — Max says "已经在录了。"
6. `systemctl stop max-vision`, then say "拍照" — Max reports a truthful failure
   and the voice session keeps working.

- [ ] **Step 7: Run the full gate and commit**

Run: `npm run check`
Expected: all stages pass.

```bash
git add rdk/vision/camera.py rdk/vision/tests/test_camera_policy.py rdk/agent/src/main.ts
git commit -m "feat(rdk): add paired camera capture, recording, and MJPEG preview"
```

---

## Task 12: Dev HUD

**Files:**

- Create: `rdk/agent/src/hud/state.ts`, `rdk/agent/src/hud/server.ts`, `rdk/agent/src/hud/index.html`
- Modify: `rdk/agent/src/main.ts`
- Test: `tests/rdk-hud-state.test.ts`

**Interfaces:**

- Consumes: `AgentEvent` from `shared/agent`
- Produces:
  - `type HudState = { connection: string; turnState: string; transcript: HudTurn[]; latencyMs: number | null; lastError: string | null }`
  - `type HudTurn = { speaker: "rider" | "agent"; text: string; final: boolean; turnId: string }`
  - `initialHudState(): HudState`
  - `reduceHud(state: HudState, event: AgentEvent): HudState`
  - `createHudServer(port: number, previewPort: number): { publish(state: HudState): void; close(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-hud-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialHudState, reduceHud } from "../rdk/agent/src/hud/state";

describe("reduceHud", () => {
  it("starts offline and idle", () => {
    const state = initialHudState();
    expect(state.connection).toBe("offline");
    expect(state.turnState).toBe("idle");
    expect(state.transcript).toEqual([]);
  });

  it("tracks connection state", () => {
    const state = reduceHud(initialHudState(), { type: "connection", state: "ready", detail: "" });
    expect(state.connection).toBe("ready");
  });

  it("tracks turn state from status events", () => {
    const state = reduceHud(initialHudState(), { type: "status", state: "thinking", detail: "" });
    expect(state.turnState).toBe("thinking");
  });

  it("appends a new transcript turn", () => {
    const state = reduceHud(initialHudState(), {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "rider",
      text: "你好",
      final: false
    });
    expect(state.transcript).toEqual([{ speaker: "rider", text: "你好", final: false, turnId: "t1" }]);
  });

  it("updates a partial turn in place rather than duplicating it", () => {
    let state = reduceHud(initialHudState(), {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "agent",
      text: "今天",
      final: false
    });
    state = reduceHud(state, {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "agent",
      text: "今天天气不错",
      final: true
    });
    expect(state.transcript.length).toBe(1);
    expect(state.transcript[0]).toEqual({
      speaker: "agent",
      text: "今天天气不错",
      final: true,
      turnId: "t1"
    });
  });

  it("records latency and errors", () => {
    let state = reduceHud(initialHudState(), { type: "metric", latencyMs: 420 });
    expect(state.latencyMs).toBe(420);
    state = reduceHud(state, { type: "error", message: "relay exploded" });
    expect(state.lastError).toBe("relay exploded");
  });

  it("does not mutate the previous state", () => {
    const before = initialHudState();
    reduceHud(before, { type: "status", state: "speaking", detail: "" });
    expect(before.turnState).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-hud-state.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/hud/state`.

- [ ] **Step 3: Write the state reducer**

Create `rdk/agent/src/hud/state.ts`:

```ts
import type { AgentEvent } from "../../../../shared/agent";

export type HudTurn = {
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  turnId: string;
};

export type HudState = {
  connection: string;
  turnState: string;
  transcript: HudTurn[];
  latencyMs: number | null;
  lastError: string | null;
};

export function initialHudState(): HudState {
  return { connection: "offline", turnState: "idle", transcript: [], latencyMs: null, lastError: null };
}

/**
 * Pure reducer for the bench HUD. Partial transcripts update in place by
 * `turnId`, matching how the other clients merge streaming captions.
 */
export function reduceHud(state: HudState, event: AgentEvent): HudState {
  switch (event.type) {
    case "connection":
      return { ...state, connection: event.state };
    case "status":
      return { ...state, turnState: event.state };
    case "metric":
      return { ...state, latencyMs: event.latencyMs };
    case "error":
      return { ...state, lastError: event.message };
    case "transcript": {
      const turn: HudTurn = {
        speaker: event.speaker,
        text: event.text,
        final: event.final === true,
        turnId: event.turnId
      };
      const index = state.transcript.findIndex((item) => item.turnId === event.turnId);
      const transcript =
        index === -1
          ? [...state.transcript, turn]
          : state.transcript.map((item, position) => (position === index ? turn : item));
      return { ...state, transcript };
    }
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-hud-state.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the HUD server and page**

Create `rdk/agent/src/hud/server.ts`:

```ts
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import type { HudState } from "./state";

/**
 * Bench instrument, not a rider surface. It costs nothing when nobody has it
 * open, which is the normal case in a helmet.
 */
export function createHudServer(port: number, previewPort: number): { publish(state: HudState): void; close(): void } {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "index.html"), "utf8").replace("__PREVIEW_PORT__", String(previewPort));

  const http = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  const sockets = new WebSocketServer({ server: http });
  let latest: HudState | null = null;

  sockets.on("connection", (socket) => {
    if (latest) socket.send(JSON.stringify(latest));
  });

  http.listen(port);

  return {
    publish(state: HudState): void {
      latest = state;
      const payload = JSON.stringify(state);
      for (const socket of sockets.clients) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    close(): void {
      sockets.close();
      http.close();
    }
  };
}
```

Create `rdk/agent/src/hud/index.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Max · RDK X5 bench</title>
<style>
  body {
    margin: 0;
    background: #0b0d10;
    color: #e6edf3;
    font:
      14px/1.5 ui-monospace,
      monospace;
    padding: 16px;
  }
  h1 {
    font-size: 15px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #7d8590;
  }
  .row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .card {
    background: #12161b;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 12px;
    flex: 1 1 320px;
  }
  img {
    width: 100%;
    border-radius: 6px;
    background: #000;
  }
  .rider {
    color: #7ee787;
  }
  .agent {
    color: #79c0ff;
  }
  .partial {
    opacity: 0.6;
  }
  dt {
    color: #7d8590;
    float: left;
    width: 96px;
  }
</style>
<h1>Max · RDK X5 bench</h1>
<div class="row">
  <div class="card">
    <dl>
      <dt>connection</dt>
      <dd id="connection">–</dd>
      <dt>turn</dt>
      <dd id="turn">–</dd>
      <dt>latency</dt>
      <dd id="latency">–</dd>
      <dt>error</dt>
      <dd id="error">–</dd>
    </dl>
  </div>
  <div class="card"><img id="front" alt="front camera" /></div>
  <div class="card"><img id="rear" alt="rear camera" /></div>
</div>
<div class="card" style="margin-top: 16px"><div id="transcript"></div></div>
<script>
  const host = location.hostname;
  document.getElementById("front").src = `http://${host}:__PREVIEW_PORT__/preview/front`;
  document.getElementById("rear").src = `http://${host}:__PREVIEW_PORT__/preview/rear`;

  const socket = new WebSocket(`ws://${location.host}`);
  socket.onmessage = (message) => {
    const state = JSON.parse(message.data);
    document.getElementById("connection").textContent = state.connection;
    document.getElementById("turn").textContent = state.turnState;
    document.getElementById("latency").textContent = state.latencyMs === null ? "–" : `${state.latencyMs} ms`;
    document.getElementById("error").textContent = state.lastError ?? "–";
    document.getElementById("transcript").innerHTML = state.transcript
      .map((turn) => `<div class="${turn.speaker} ${turn.final ? "" : "partial"}">${turn.speaker}: ${turn.text}</div>`)
      .join("");
  };
</script>
```

- [ ] **Step 6: Wire the HUD into main.ts**

In `rdk/agent/src/main.ts`, inside `start()`:

```ts
import { createHudServer } from "./hud/server";
import { initialHudState, reduceHud } from "./hud/state";

// ...
const hud = createHudServer(config.hudPort, config.visionPreviewPort);
let hudState = initialHudState();
```

and at the top of the relay's `onEvent` handler:

```ts
hudState = reduceHud(hudState, event);
hud.publish(hudState);
```

- [ ] **Step 7: Verify on hardware**

Open `http://<board>:8080` from a laptop, or Chromium kiosk on the board's HDMI.
Start a session and confirm turn state, transcript, latency, and both previews
update live.

- [ ] **Step 8: Run the full gate and commit**

Run: `npm run check`
Expected: all stages pass.

```bash
git add rdk/agent/src/hud tests/rdk-hud-state.test.ts rdk/agent/src/main.ts
git commit -m "feat(rdk): add the bench dev HUD with live state and camera previews"
```

---

## Plan self-review

**Spec coverage.** Every section of the design maps to a task: hardware baseline
and the AEC spike → Task 0; server-side changes → Task 1; audio pipeline → Tasks
2, 3, 7; vision IPC → Tasks 4, 9; capability matrix → Task 5; relay and session
lifecycle → Tasks 6, 8; boot and config → Tasks 6, 8, 9; capture behavior and
gallery → Tasks 10, 11; dev HUD → Task 12; error handling → distributed across
Tasks 5, 9, 11 and asserted by test.

**Two gaps I want called out rather than hidden.**

1. **H.264 encoder wiring is described, not written** (Task 11, Step 3). It is
   the one piece that cannot be written blind against `libsrcampy` without the
   board in hand. Everything policy-shaped around it — the recording state
   machine, the space guard, the ten-minute cap — is written and tested; only the
   encoder attach/release calls are left to fill in on hardware.
2. **`camera.record` writes its manifest naming `front.h264` / `rear.h264`
   unconditionally.** Once the encoder is wired, that should reflect which
   sensors actually produced a file, the same way `capture_photo` already does.
   Worth a follow-up commit during Task 11.

**Type consistency.** `VisionClient`, `VisionResponse`, `DeviceCommand`,
`HudState`, `RdkConfig`, and `CloseReason` are defined once and referenced with
identical names throughout. `createDecimator` / `createFramer` /
`createUpsampler2x` / `applySoftLimit` keep the same signatures from Task 2
through Task 7. `SpawnLike` and `ChildProcessLike` are defined in `capture.ts`
and imported by `playback.ts` rather than redeclared.

**Sequencing risk.** Task 9's `service.py` imports `camera` and `gallery`, which
do not exist until Tasks 10 and 11 — noted in the task itself. The unit tests for
Task 9 do not import `service.py`, so the suite stays green in between.
