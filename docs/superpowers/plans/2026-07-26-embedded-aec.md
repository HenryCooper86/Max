# Embedded AEC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore barge-in on the RDK X5 helmet client by cancelling Max's own voice out of the microphone, instead of muting the mic while he speaks.

**Architecture:** A C++ helper `max-aec` replaces `arecord`: it owns ALSA capture, receives the post-limiter 48 kHz far-end reference on fd 3, runs the WebRTC APM at 16 kHz, and writes the same 320-sample frames the agent already sends upstream. The agent owns the `CROSSTALK` mixer so the codec duck and the canceller can never disagree.

**Tech Stack:** C++ with `libwebrtc-audio-processing` 0.3.1 and ALSA (`libasound2-dev`), TypeScript on Node 22, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-26-embedded-aec-design.md`

## Global Constraints

- Uplink stays **16 kHz PCM16 mono, 320-sample (640-byte) 20 ms frames** — byte-identical to `public/pcm-worklet.js`. `max-aec` must not change this contract.
- APM processes **10 ms frames**: 160 samples at 16 kHz. One uplink frame is exactly 2 APM frames.
- The reference is the **post-limiter 48 kHz** signal — the samples handed to the DAC. Never the 24 kHz stream as received.
- `flush()` must drop pending reference **and** reset APM **atomically**, or barge-in mangles the rider's next words.
- `CROSSTALK1`/`CROSSTALK2` = **0** when AEC is active, **10** when it is not. Set by the agent at startup, never left to `alsactl`.
- **No AEC failure may crash the agent.** Fall back to `arecord` + `CROSSTALK=10` and log loudly.
- Build deps on the board: `libwebrtc-audio-processing-dev` (0.3.1-0ubuntu5) and `libasound2-dev` — both already installed 2026-07-26.
- `npm run check` must pass at the end of every task touching TypeScript.
- Board: `root@192.168.50.9`. Agent runs as the `max-agent` systemd unit from `/opt/max`.

---

## File Structure

**Created**

| Path                                                     | Responsibility                                          |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `rdk/aec/Makefile`                                       | builds `max-aec` via `pkg-config`                       |
| `rdk/aec/src/resample.h` / `.cpp`                        | FIR low-pass + ÷3 decimation, mirroring `dsp.ts`        |
| `rdk/aec/src/wav.h` / `.cpp`                             | minimal 16-bit mono WAV read/write, offline mode only   |
| `rdk/aec/src/apm.h` / `.cpp`                             | APM lifecycle: configure, process, reset, ERLE          |
| `rdk/aec/src/main.cpp`                                   | CLI: `--offline` (WAVs) or live (ALSA + fd 3)           |
| `rdk/aec/tools/erle.py`                                  | generates fixtures, runs the binary, reports ERLE in dB |
| `rdk/agent/src/audio/mixer.ts`                           | sets `CROSSTALK` to match AEC state                     |
| `rdk/agent/src/audio/reference.ts`                       | reference pipe + atomic flush                           |
| `tests/rdk-echo-loop.test.ts`                            | echo-loop detector                                      |
| `tests/rdk-mixer.test.ts`, `tests/rdk-reference.test.ts` | Vitest                                                  |

**Modified**

| Path                              | Change                                              |
| --------------------------------- | --------------------------------------------------- |
| `rdk/agent/src/audio/capture.ts`  | spawn `max-aec` (fd 3 pipe) with `arecord` fallback |
| `rdk/agent/src/audio/playback.ts` | tap post-limiter to reference; flush drops + resets |
| `rdk/agent/src/config.ts`         | `MAX_AEC_MODE`, `MAX_AEC_BIN`, `MAX_AEC_DELAY_MS`   |
| `rdk/agent/src/main.ts`           | wire mixer + reference                              |
| `rdk/README.md`                   | build, run, bench results                           |

**Sequencing.** Tasks 1–3 are pure TypeScript and need no board. Tasks 4–6 build and prove `max-aec` offline. Task 7 wires it in; Task 8 is bench verification.

---

## Task 1: Echo-loop detector

The regression guard, built first because it is pure, valuable on its own, and encodes the exact failure we shipped once.

**Files:**

- Create: `rdk/agent/src/audio/echo-loop.ts`, `tests/rdk-echo-loop.test.ts`

**Interfaces:**

- Produces:
  - `type Turn = { speaker: "rider" | "agent"; text: string }`
  - `looksLikeEcho(previousAgent: string, riderText: string): boolean`
  - `detectEchoLoop(turns: Turn[], minRun?: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-echo-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectEchoLoop, looksLikeEcho, type Turn } from "../rdk/agent/src/audio/echo-loop";

describe("looksLikeEcho", () => {
  it("flags a rider turn that is a prefix of the agent's previous reply", () => {
    expect(looksLikeEcho("今天晴间多云，气温大概25度", "今天晴间多云")).toBe(true);
  });

  it("flags a truncated prefix, which is what ASR actually produced", () => {
    expect(looksLikeEcho("对的，今天晴间多云，气温和风速都很适合骑行", "对的，今天晴间多")).toBe(true);
  });

  it("does not flag a genuine reply", () => {
    expect(looksLikeEcho("今天晴间多云，气温大概25度", "帮我打开灯")).toBe(false);
  });

  it("does not flag a very short echo-looking fragment", () => {
    // "好的" is a plausible real utterance; too short to call.
    expect(looksLikeEcho("好的，那你之后有任何骑行相关的需求", "好的")).toBe(false);
  });

  it("ignores punctuation and whitespace differences", () => {
    expect(looksLikeEcho("没错，这样的天气骑行很舒服", "没错  这样的天气骑行很舒服。")).toBe(true);
  });
});

describe("detectEchoLoop", () => {
  const loop: Turn[] = [
    { speaker: "agent", text: "今天晴间多云，气温大概25度，风速3公里每小时" },
    { speaker: "rider", text: "今天晴间多云" },
    { speaker: "agent", text: "对的，今天晴间多云，气温和风速都很适合骑行" },
    { speaker: "rider", text: "对的，今天晴间多" },
    { speaker: "agent", text: "是的，今天晴间多云，天气条件不错" },
    { speaker: "rider", text: "是的，今天晴间多云，天气条件不错" }
  ];

  it("detects the transcript that shipped to a live rider", () => {
    expect(detectEchoLoop(loop)).toBe(true);
  });

  it("does not flag a healthy conversation", () => {
    const healthy: Turn[] = [
      { speaker: "rider", text: "Max，帮我打开灯" },
      { speaker: "agent", text: "手电筒已打开。" },
      { speaker: "rider", text: "Max，今天的天气怎么样？" },
      { speaker: "agent", text: "今天晴间多云，气温大概25度。" }
    ];
    expect(detectEchoLoop(healthy)).toBe(false);
  });

  it("needs a run, not one coincidence", () => {
    const once: Turn[] = [
      { speaker: "agent", text: "今天晴间多云，气温大概25度" },
      { speaker: "rider", text: "今天晴间多云" },
      { speaker: "agent", text: "好的" },
      { speaker: "rider", text: "帮我导航去杭州" }
    ];
    expect(detectEchoLoop(once)).toBe(false);
  });

  it("honours an explicit minimum run length", () => {
    const once: Turn[] = [
      { speaker: "agent", text: "今天晴间多云，气温大概25度" },
      { speaker: "rider", text: "今天晴间多云" }
    ];
    expect(detectEchoLoop(once, 1)).toBe(true);
  });

  it("is empty-safe", () => {
    expect(detectEchoLoop([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-echo-loop.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/audio/echo-loop`.

- [ ] **Step 3: Write the implementation**

Create `rdk/agent/src/audio/echo-loop.ts`:

```ts
/**
 * Detects the signature of an acoustic echo loop in a transcript: the rider
 * "says" a prefix of what the agent just said, because the microphone heard the
 * speaker and ASR transcribed it.
 *
 * This shipped to a live rider once (2026-07-25, see rdk/README.md under "AEC").
 * Catching it should not depend on a human reading a transcript and noticing.
 */

export type Turn = { speaker: "rider" | "agent"; text: string };

/** Below this many characters a match is more likely a real short utterance
 *  ("好的", "没错") than an echo. */
const MIN_ECHO_CHARS = 6;

/** Consecutive echo-looking exchanges before we call it a loop. */
const DEFAULT_MIN_RUN = 2;

function normalise(text: string): string {
  return text.replace(/[\s，,。.、!！?？]/g, "");
}

export function looksLikeEcho(previousAgent: string, riderText: string): boolean {
  const agent = normalise(previousAgent);
  const rider = normalise(riderText);
  if (rider.length < MIN_ECHO_CHARS) return false;
  return agent.startsWith(rider);
}

export function detectEchoLoop(turns: Turn[], minRun: number = DEFAULT_MIN_RUN): boolean {
  let run = 0;
  for (let i = 1; i < turns.length; i += 1) {
    const previous = turns[i - 1]!;
    const current = turns[i]!;
    if (previous.speaker !== "agent" || current.speaker !== "rider") continue;
    if (looksLikeEcho(previous.text, current.text)) {
      run += 1;
      if (run >= minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-echo-loop.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/audio/echo-loop.ts tests/rdk-echo-loop.test.ts
git commit -m "feat(rdk): detect the acoustic echo-loop transcript signature"
```

---

## Task 2: Mixer control

**Files:**

- Create: `rdk/agent/src/audio/mixer.ts`, `tests/rdk-mixer.test.ts`

**Interfaces:**

- Produces:
  - `CROSSTALK_AEC_ON = 0`, `CROSSTALK_AEC_OFF = 10`
  - `crosstalkFor(aecActive: boolean): number`
  - `mixerArgs(control: string, value: number): string[]`
  - `applyCrosstalk(aecActive: boolean, run?: RunFn): Promise<boolean>`
  - `type RunFn = (cmd: string, args: string[]) => Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-mixer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CROSSTALK_AEC_OFF,
  CROSSTALK_AEC_ON,
  applyCrosstalk,
  crosstalkFor,
  mixerArgs
} from "../rdk/agent/src/audio/mixer";

describe("crosstalkFor", () => {
  it("disables the hardware duck when AEC is active", () => {
    expect(crosstalkFor(true)).toBe(CROSSTALK_AEC_ON);
    expect(CROSSTALK_AEC_ON).toBe(0);
  });

  it("restores the vendor duck when AEC is not active", () => {
    // The duck is the only thing preventing the echo loop without a canceller.
    expect(crosstalkFor(false)).toBe(CROSSTALK_AEC_OFF);
    expect(CROSSTALK_AEC_OFF).toBe(10);
  });
});

describe("mixerArgs", () => {
  it("targets card 0 and the named control", () => {
    expect(mixerArgs("CROSSTALK1", 0)).toEqual(["-c", "0", "sset", "CROSSTALK1", "0"]);
  });
});

describe("applyCrosstalk", () => {
  it("sets both crosstalk controls", async () => {
    const calls: string[][] = [];
    const ok = await applyCrosstalk(true, async (_cmd, args) => {
      calls.push(args);
      return 0;
    });
    expect(ok).toBe(true);
    expect(calls.map((a) => a[3])).toEqual(["CROSSTALK1", "CROSSTALK2"]);
    expect(calls.every((a) => a[4] === "0")).toBe(true);
  });

  it("writes 10 to both when AEC is off", async () => {
    const values: string[] = [];
    await applyCrosstalk(false, async (_cmd, args) => {
      values.push(args[4]!);
      return 0;
    });
    expect(values).toEqual(["10", "10"]);
  });

  it("reports failure when amixer exits non-zero", async () => {
    expect(await applyCrosstalk(true, async () => 1)).toBe(false);
  });

  it("reports failure rather than throwing when amixer is missing", async () => {
    expect(
      await applyCrosstalk(true, async () => {
        throw new Error("ENOENT");
      })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-mixer.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/audio/mixer`.

- [ ] **Step 3: Write the implementation**

Create `rdk/agent/src/audio/mixer.ts`:

```ts
import { spawn } from "node:child_process";

/**
 * The ES8326's CROSSTALK controls are a hardware duck, not an echo canceller:
 * at the vendor default they attenuate the whole capture path while the DAC is
 * active, so the rider cannot be heard while Max speaks.
 *
 * They must therefore track the AEC state exactly. A board left at 0 with no
 * canceller running is the echo loop that reached a live rider on 2026-07-25.
 */

export const CROSSTALK_AEC_ON = 0;
export const CROSSTALK_AEC_OFF = 10;

const CONTROLS = ["CROSSTALK1", "CROSSTALK2"] as const;

export type RunFn = (cmd: string, args: string[]) => Promise<number>;

export function crosstalkFor(aecActive: boolean): number {
  return aecActive ? CROSSTALK_AEC_ON : CROSSTALK_AEC_OFF;
}

export function mixerArgs(control: string, value: number): string[] {
  return ["-c", "0", "sset", control, String(value)];
}

const defaultRun: RunFn = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args);
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

/** Returns false rather than throwing: a mixer we cannot set is a reason to log
 *  and fall back, never a reason to take the agent down. */
export async function applyCrosstalk(aecActive: boolean, run: RunFn = defaultRun): Promise<boolean> {
  const value = crosstalkFor(aecActive);
  for (const control of CONTROLS) {
    try {
      if ((await run("amixer", mixerArgs(control, value))) !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-mixer.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/audio/mixer.ts tests/rdk-mixer.test.ts
git commit -m "feat(rdk): let the agent own the CROSSTALK mixer state"
```

---

## Task 3: Reference pipe and atomic flush

**Files:**

- Create: `rdk/agent/src/audio/reference.ts`, `tests/rdk-reference.test.ts`
- Modify: `rdk/agent/src/config.ts`

**Interfaces:**

- Produces:
  - `type ReferenceSink = { write(pcm48k: Int16Array): void; flush(): void; close(): void }`
  - `createReferenceSink(options: { stream: NodeJS.WritableStream | null; onReset(): void }): ReferenceSink`
  - config gains `aecMode: "apm" | "off"`, `aecBin: string`, `aecDelayMs: number`

- [ ] **Step 1: Write the failing test**

Create `tests/rdk-reference.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createReferenceSink } from "../rdk/agent/src/audio/reference";
import { loadConfig } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

describe("createReferenceSink", () => {
  it("forwards reference audio to the pipe", () => {
    const stream = new PassThrough();
    const seen: number[] = [];
    stream.on("data", (chunk: Buffer) => seen.push(chunk.length));
    const sink = createReferenceSink({ stream, onReset: () => {} });
    sink.write(new Int16Array(480));
    expect(seen).toEqual([960]);
  });

  it("signals reset on flush", () => {
    let resets = 0;
    const sink = createReferenceSink({ stream: new PassThrough(), onReset: () => (resets += 1) });
    sink.flush();
    expect(resets).toBe(1);
  });

  it("drops audio queued before a flush", () => {
    // Barge-in kills aplay, so anything still queued will never be played.
    // Feeding it to APM would subtract a phantom echo from the rider's speech.
    const stream = new PassThrough();
    const chunks: number[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c.length));
    const sink = createReferenceSink({ stream, onReset: () => {} });
    sink.flush();
    sink.write(new Int16Array(160));
    expect(chunks).toEqual([320]); // only the post-flush write
  });

  it("survives a write to a closed pipe", () => {
    const stream = new PassThrough();
    const sink = createReferenceSink({ stream, onReset: () => {} });
    stream.destroy();
    expect(() => sink.write(new Int16Array(160))).not.toThrow();
  });

  it("is a no-op with no pipe, so AEC-off still plays audio", () => {
    const sink = createReferenceSink({ stream: null, onReset: () => {} });
    expect(() => {
      sink.write(new Int16Array(160));
      sink.flush();
      sink.close();
    }).not.toThrow();
  });
});

describe("aec config", () => {
  it("defaults to apm mode", () => {
    expect(loadConfig(BASE_ENV).aecMode).toBe("apm");
  });

  it("can be switched off without a rebuild", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_AEC_MODE: "off" }).aecMode).toBe("off");
  });

  it("rejects an unknown mode rather than silently guessing", () => {
    expect(() => loadConfig({ ...BASE_ENV, MAX_AEC_MODE: "maybe" })).toThrow(/MAX_AEC_MODE/);
  });

  it("defaults the helper path and delay", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.aecBin).toBe("/opt/max/rdk/aec/max-aec");
    expect(config.aecDelayMs).toBe(160);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-reference.test.ts`
Expected: FAIL — cannot resolve `../rdk/agent/src/audio/reference`.

- [ ] **Step 3: Write the reference sink**

Create `rdk/agent/src/audio/reference.ts`:

```ts
/**
 * The far-end reference feed for max-aec.
 *
 * Carries the post-limiter 48 kHz signal — literally the samples handed to the
 * DAC. Tapping earlier would hide the limiter's non-linearity from a canceller
 * that models the echo path as linear, and cancellation would degrade exactly
 * when Max is loudest.
 */

export type ReferenceSink = {
  write(pcm48k: Int16Array): void;
  flush(): void;
  close(): void;
};

export type ReferenceOptions = {
  /** fd 3 of the max-aec child, or null when AEC is off. */
  stream: NodeJS.WritableStream | null;
  /** Tells max-aec to reset APM. Must happen in the same beat as the drop. */
  onReset(): void;
};

export function createReferenceSink(options: ReferenceOptions): ReferenceSink {
  const { stream } = options;
  if (stream) {
    // A dead pipe is expected when the helper exits; it must not be fatal.
    stream.on("error", () => {});
  }

  return {
    write(pcm48k: Int16Array): void {
      if (!stream || stream.destroyed) return;
      try {
        stream.write(Buffer.from(pcm48k.buffer, pcm48k.byteOffset, pcm48k.byteLength));
      } catch {
        // Same reasoning as above.
      }
    },

    flush(): void {
      // Barge-in: whatever is queued will never reach the speaker, so APM must
      // forget it or it will subtract an echo that never happened.
      options.onReset();
    },

    close(): void {
      if (stream && !stream.destroyed) stream.end();
    }
  };
}
```

- [ ] **Step 4: Add the config fields**

In `rdk/agent/src/config.ts`, add to `RdkConfig`:

```ts
/** "apm" runs max-aec; "off" falls back to arecord plus the hardware duck. */
aecMode: "apm" | "off";
aecBin: string;
/** Reference-to-mic delay hint for APM, measured on the bench. */
aecDelayMs: number;
```

and inside `loadConfig`'s returned object:

```ts
    aecMode: optionalEnum(env, "MAX_AEC_MODE", ["apm", "off"], "apm"),
    aecBin: optionalString(env, "MAX_AEC_BIN", "/opt/max/rdk/aec/max-aec"),
    aecDelayMs: optionalNumber(env, "MAX_AEC_DELAY_MS", 160),
```

and add this helper next to `optionalNumber`:

```ts
function optionalEnum<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const trimmed = value.trim() as T;
  if (!allowed.includes(trimmed)) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}, got ${value}`);
  }
  return trimmed;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/rdk-reference.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/audio/reference.ts rdk/agent/src/config.ts tests/rdk-reference.test.ts
git commit -m "feat(rdk): add the AEC reference sink and config"
```

---

## Task 4: max-aec skeleton — resampler, WAV, build

Builds a binary that does no cancellation yet, but resamples and round-trips WAVs. Everything after this has something to run.

**Files:**

- Create: `rdk/aec/Makefile`, `rdk/aec/src/resample.h`, `rdk/aec/src/resample.cpp`, `rdk/aec/src/wav.h`, `rdk/aec/src/wav.cpp`, `rdk/aec/src/main.cpp`

**Interfaces:**

- Produces:
  - `class Decimator3 { std::vector<int16_t> process(const int16_t* in, size_t n); }`
  - `bool wav_read_mono16(const std::string& path, int& rate, std::vector<int16_t>& out)`
  - `bool wav_write_mono16(const std::string& path, int rate, const std::vector<int16_t>& in)`
  - binary `rdk/aec/max-aec` accepting `--offline <ref.wav> <mic.wav> <out.wav>`

- [ ] **Step 1: Write the build file**

Create `rdk/aec/Makefile`:

```make
# max-aec — echo cancellation helper for the RDK X5 helmet client.
# Build on the board: apt install libwebrtc-audio-processing-dev libasound2-dev
CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++14 -Wall -Wextra
PKGS      = webrtc-audio-processing alsa
CXXFLAGS += $(shell pkg-config --cflags $(PKGS))
LDLIBS    = $(shell pkg-config --libs $(PKGS))

SRC = src/main.cpp src/resample.cpp src/wav.cpp src/apm.cpp
BIN = max-aec

$(BIN): $(SRC)
	$(CXX) $(CXXFLAGS) -o $@ $(SRC) $(LDLIBS)

clean:
	rm -f $(BIN)

.PHONY: clean
```

- [ ] **Step 2: Write the resampler**

Create `rdk/aec/src/resample.h`:

```cpp
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

// 48 kHz -> 16 kHz, mirroring createDecimator(3, LOW_PASS_48K) in
// rdk/agent/src/audio/dsp.ts. Both legs of the canceller must be decimated
// identically; a mismatch between mic and reference presents as echo.
class Decimator3 {
 public:
  Decimator3();
  std::vector<int16_t> process(const int16_t* in, size_t n);

 private:
  std::vector<float> taps_;
  std::vector<float> history_;
  int phase_ = 0;
};
```

Create `rdk/aec/src/resample.cpp`:

```cpp
#include "resample.h"
#include <cmath>

namespace {
constexpr int kTaps = 31;
constexpr double kCutoffHz = 7500.0;
constexpr double kRate = 48000.0;
constexpr int kFactor = 3;
}  // namespace

Decimator3::Decimator3() : taps_(kTaps), history_(kTaps - 1, 0.0f) {
  const double middle = (kTaps - 1) / 2.0;
  const double fc = kCutoffHz / kRate;
  double sum = 0.0;
  for (int i = 0; i < kTaps; ++i) {
    const double n = i - middle;
    const double sinc = (n == 0.0) ? 2.0 * fc : std::sin(2.0 * M_PI * fc * n) / (M_PI * n);
    const double window = 0.54 - 0.46 * std::cos(2.0 * M_PI * i / (kTaps - 1));
    taps_[i] = static_cast<float>(sinc * window);
    sum += taps_[i];
  }
  for (int i = 0; i < kTaps; ++i) taps_[i] = static_cast<float>(taps_[i] / sum);
}

std::vector<int16_t> Decimator3::process(const int16_t* in, size_t n) {
  const size_t width = taps_.size();
  std::vector<float> buffer(history_.size() + n);
  for (size_t i = 0; i < history_.size(); ++i) buffer[i] = history_[i];
  for (size_t i = 0; i < n; ++i) buffer[history_.size() + i] = in[i] / 32768.0f;

  std::vector<int16_t> out;
  out.reserve(n / kFactor + 1);
  for (size_t i = width - 1; i < buffer.size(); ++i) {
    if (phase_ == 0) {
      float acc = 0.0f;
      for (size_t k = 0; k < width; ++k) acc += taps_[k] * buffer[i - k];
      int scaled = static_cast<int>(std::lround(acc * 32768.0f));
      if (scaled > 32767) scaled = 32767;
      if (scaled < -32768) scaled = -32768;
      out.push_back(static_cast<int16_t>(scaled));
    }
    phase_ = (phase_ + 1) % kFactor;
  }

  history_.assign(buffer.end() - static_cast<long>(width - 1), buffer.end());
  return out;
}
```

- [ ] **Step 3: Write the WAV helpers**

Create `rdk/aec/src/wav.h`:

```cpp
#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Minimal 16-bit mono PCM WAV. Offline mode only — the live path is raw PCM.
bool wav_read_mono16(const std::string& path, int& rate, std::vector<int16_t>& out);
bool wav_write_mono16(const std::string& path, int rate, const std::vector<int16_t>& in);
```

Create `rdk/aec/src/wav.cpp`:

```cpp
#include "wav.h"
#include <cstdio>
#include <cstring>

namespace {
struct Header {
  char riff[4];
  uint32_t size;
  char wave[4];
  char fmt[4];
  uint32_t fmt_size;
  uint16_t format;
  uint16_t channels;
  uint32_t rate;
  uint32_t byte_rate;
  uint16_t block_align;
  uint16_t bits;
  char data[4];
  uint32_t data_size;
};
}  // namespace

bool wav_read_mono16(const std::string& path, int& rate, std::vector<int16_t>& out) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  Header h{};
  if (std::fread(&h, sizeof(h), 1, f) != 1) {
    std::fclose(f);
    return false;
  }
  if (std::memcmp(h.riff, "RIFF", 4) != 0 || h.channels != 1 || h.bits != 16) {
    std::fclose(f);
    return false;
  }
  rate = static_cast<int>(h.rate);
  out.resize(h.data_size / 2);
  const size_t read = std::fread(out.data(), 2, out.size(), f);
  out.resize(read);
  std::fclose(f);
  return true;
}

bool wav_write_mono16(const std::string& path, int rate, const std::vector<int16_t>& in) {
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  Header h{};
  std::memcpy(h.riff, "RIFF", 4);
  std::memcpy(h.wave, "WAVE", 4);
  std::memcpy(h.fmt, "fmt ", 4);
  std::memcpy(h.data, "data", 4);
  h.fmt_size = 16;
  h.format = 1;
  h.channels = 1;
  h.rate = static_cast<uint32_t>(rate);
  h.bits = 16;
  h.block_align = 2;
  h.byte_rate = h.rate * h.block_align;
  h.data_size = static_cast<uint32_t>(in.size() * 2);
  h.size = 36 + h.data_size;
  std::fwrite(&h, sizeof(h), 1, f);
  std::fwrite(in.data(), 2, in.size(), f);
  std::fclose(f);
  return true;
}
```

- [ ] **Step 4: Write a passthrough main**

Create `rdk/aec/src/main.cpp`:

```cpp
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "apm.h"
#include "resample.h"
#include "wav.h"

namespace {

int run_offline(const std::string& ref_path, const std::string& mic_path,
                const std::string& out_path, int delay_ms) {
  int ref_rate = 0, mic_rate = 0;
  std::vector<int16_t> ref, mic;
  if (!wav_read_mono16(ref_path, ref_rate, ref)) {
    std::fprintf(stderr, "max-aec: cannot read %s\n", ref_path.c_str());
    return 1;
  }
  if (!wav_read_mono16(mic_path, mic_rate, mic)) {
    std::fprintf(stderr, "max-aec: cannot read %s\n", mic_path.c_str());
    return 1;
  }

  Decimator3 ref_dec, mic_dec;
  std::vector<int16_t> ref16 =
      ref_rate == 48000 ? ref_dec.process(ref.data(), ref.size()) : ref;
  std::vector<int16_t> mic16 =
      mic_rate == 48000 ? mic_dec.process(mic.data(), mic.size()) : mic;

  ApmSession apm;
  if (!apm.init(delay_ms)) {
    std::fprintf(stderr, "max-aec: APM init failed\n");
    return 1;
  }

  std::vector<int16_t> out;
  out.reserve(mic16.size());
  const size_t frame = ApmSession::kFrameSamples;
  for (size_t i = 0; i + frame <= mic16.size(); i += frame) {
    if (i + frame <= ref16.size()) apm.process_reverse(&ref16[i]);
    int16_t block[frame];
    std::memcpy(block, &mic16[i], frame * sizeof(int16_t));
    apm.process(block);
    out.insert(out.end(), block, block + frame);
  }

  if (!wav_write_mono16(out_path, 16000, out)) {
    std::fprintf(stderr, "max-aec: cannot write %s\n", out_path.c_str());
    return 1;
  }
  std::fprintf(stderr, "max-aec: offline done, %zu frames\n", out.size() / frame);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  int delay_ms = 160;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--delay-ms") == 0 && i + 1 < argc) delay_ms = std::atoi(argv[++i]);
  }
  if (argc >= 5 && std::strcmp(argv[1], "--offline") == 0) {
    return run_offline(argv[2], argv[3], argv[4], delay_ms);
  }
  std::fprintf(stderr,
               "usage: max-aec --offline <ref.wav> <mic.wav> <out.wav> [--delay-ms N]\n"
               "       max-aec --device <alsa> [--delay-ms N]   (live: mic->stdout, ref on fd 3)\n");
  return 2;
}
```

- [ ] **Step 5: Commit (does not build yet — apm.h arrives in Task 5)**

```bash
git add rdk/aec
git commit -m "feat(rdk): add the max-aec skeleton, resampler and WAV IO"
```

---

## Task 5: APM session, and the offline ERLE harness

**Files:**

- Create: `rdk/aec/src/apm.h`, `rdk/aec/src/apm.cpp`, `rdk/aec/tools/erle.py`

**Interfaces:**

- Consumes: `Decimator3`, WAV helpers
- Produces:
  - `class ApmSession` with `static constexpr size_t kFrameSamples = 160`, `bool init(int delay_ms)`, `void process_reverse(const int16_t* ref160)`, `void process(int16_t* mic160)`, `void reset()`, `float erle_db() const`

- [ ] **Step 1: Write the APM wrapper**

Create `rdk/aec/src/apm.h`:

```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace webrtc {
class AudioProcessing;
}

// WebRTC APM at 16 kHz mono: echo cancellation, noise suppression, gain control.
// 16 kHz is the uplink rate, so nothing extra is converted on the path we send.
class ApmSession {
 public:
  // APM processes 10 ms frames: 160 samples at 16 kHz. One 320-sample uplink
  // frame is exactly two of these.
  static constexpr size_t kFrameSamples = 160;
  static constexpr int kRate = 16000;

  ApmSession();
  ~ApmSession();

  bool init(int delay_ms);
  void process_reverse(const int16_t* ref);
  void process(int16_t* mic);
  void reset();
  float erle_db() const;

 private:
  webrtc::AudioProcessing* apm_ = nullptr;
  int delay_ms_ = 0;
  float erle_db_ = 0.0f;
};
```

Create `rdk/aec/src/apm.cpp`:

```cpp
#include "apm.h"

#include <webrtc/modules/audio_processing/include/audio_processing.h>
#include <webrtc/modules/interface/module_common_types.h>

#include <cstring>

using webrtc::AudioFrame;
using webrtc::AudioProcessing;

ApmSession::ApmSession() = default;

ApmSession::~ApmSession() {
  delete apm_;
}

bool ApmSession::init(int delay_ms) {
  delay_ms_ = delay_ms;

  webrtc::Config config;
  // ExtendedFilter widens the adaptive filter; DelayAgnostic lets APM track the
  // real delay when our hint is wrong. Both matter because the aplay buffer
  // makes the true delay vary.
  config.Set<webrtc::ExtendedFilter>(new webrtc::ExtendedFilter(true));
  config.Set<webrtc::DelayAgnostic>(new webrtc::DelayAgnostic(true));

  apm_ = AudioProcessing::Create(config);
  if (!apm_) return false;

  if (apm_->Initialize(kRate, kRate, kRate, AudioProcessing::kMono, AudioProcessing::kMono,
                       AudioProcessing::kMono) != AudioProcessing::kNoError) {
    return false;
  }

  apm_->echo_cancellation()->set_suppression_level(
      webrtc::EchoCancellation::kHighSuppression);
  apm_->echo_cancellation()->enable_metrics(true);
  if (apm_->echo_cancellation()->Enable(true) != AudioProcessing::kNoError) return false;

  // The helmet wants these regardless of echo: wind and engine noise at speed.
  apm_->noise_suppression()->set_level(webrtc::NoiseSuppression::kHigh);
  apm_->noise_suppression()->Enable(true);
  apm_->gain_control()->set_mode(webrtc::GainControl::kAdaptiveDigital);
  apm_->gain_control()->Enable(true);

  return true;
}

namespace {
void fill(AudioFrame& frame, const int16_t* pcm) {
  frame.num_channels_ = 1;
  frame.sample_rate_hz_ = ApmSession::kRate;
  frame.samples_per_channel_ = ApmSession::kFrameSamples;
  std::memcpy(frame.data_, pcm, ApmSession::kFrameSamples * sizeof(int16_t));
}
}  // namespace

void ApmSession::process_reverse(const int16_t* ref) {
  if (!apm_) return;
  AudioFrame frame;
  fill(frame, ref);
  apm_->ProcessReverseStream(&frame);
}

void ApmSession::process(int16_t* mic) {
  if (!apm_) return;
  AudioFrame frame;
  fill(frame, mic);
  apm_->set_stream_delay_ms(delay_ms_);
  apm_->ProcessStream(&frame);
  std::memcpy(mic, frame.data_, kFrameSamples * sizeof(int16_t));

  webrtc::EchoCancellation::Metrics metrics;
  if (apm_->echo_cancellation()->GetMetrics(&metrics) == AudioProcessing::kNoError) {
    erle_db_ = static_cast<float>(metrics.echo_return_loss_enhancement.instant);
  }
}

void ApmSession::reset() {
  // Barge-in dropped reference audio that never played. Without this, APM keeps
  // adapting against an echo that will not arrive and damages the rider's speech.
  if (apm_) apm_->Initialize();
}

float ApmSession::erle_db() const {
  return erle_db_;
}
```

- [ ] **Step 2: Build on the board**

```bash
scp -r rdk/aec root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/aec && make 2>&1 | tail -20'
```

Expected: `max-aec` produced, no errors. If `gain_control()->set_mode` or a
`Metrics` field name mismatches this APM build, read
`/usr/include/webrtc_audio_processing/webrtc/modules/audio_processing/include/audio_processing.h`
and correct to the declared names — do not guess.

- [ ] **Step 3: Write the ERLE harness**

Create `rdk/aec/tools/erle.py`:

```python
"""Measure echo cancellation offline, in dB, against known ground truth.

The previous AEC spike compared a sweep's RMS against a noise floor, concluded
"gate passed", and was wrong — a live conversation looped immediately. This
harness cannot flatter itself the same way: it synthesises the echo, so it knows
exactly what should have been removed.

    python3 tools/erle.py --bin ./max-aec --delay-ms 160
"""

from __future__ import annotations

import argparse
import math
import struct
import subprocess
import wave
from pathlib import Path

RATE = 16000


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, s))) for s in samples))


def read_wav(path: Path) -> list[int]:
    with wave.open(str(path)) as w:
        raw = w.readframes(w.getnframes())
    return list(struct.unpack(f"<{len(raw) // 2}h", raw))


def rms(samples: list[int]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(float(s) * s for s in samples) / len(samples))


def tone(freq: float, n: int, amp: float) -> list[int]:
    return [int(amp * 32767 * math.sin(2 * math.pi * freq * i / RATE)) for i in range(n)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./max-aec")
    parser.add_argument("--delay-ms", type=int, default=160)
    parser.add_argument("--echo-gain", type=float, default=0.5)
    parser.add_argument("--seconds", type=float, default=6.0)
    parser.add_argument("--min-erle-db", type=float, default=12.0)
    args = parser.parse_args()

    n = int(RATE * args.seconds)
    delay = int(RATE * args.delay_ms / 1000)

    # Far end: what Max says. Near end: the rider, quieter and different pitch.
    reference = tone(440.0, n, 0.5)
    speech = tone(880.0, n, 0.05)

    # Mic = delayed, attenuated echo of the reference + the rider.
    mic = []
    for i in range(n):
        echo = reference[i - delay] * args.echo_gain if i >= delay else 0.0
        mic.append(int(echo + speech[i]))

    tmp = Path("/tmp/erle")
    tmp.mkdir(exist_ok=True)
    write_wav(tmp / "ref.wav", reference)
    write_wav(tmp / "mic.wav", mic)

    subprocess.run(
        [args.bin, "--offline", str(tmp / "ref.wav"), str(tmp / "mic.wav"), str(tmp / "out.wav"),
         "--delay-ms", str(args.delay_ms)],
        check=True,
    )

    cleaned = read_wav(tmp / "out.wav")
    # Skip the first second: the adaptive filter has to converge.
    skip = RATE
    before = rms(mic[skip:])
    after = rms(cleaned[skip:]) if len(cleaned) > skip else 0.0
    erle = 20 * math.log10(max(before, 1e-9) / max(after, 1e-9))

    print(f"  echo gain     : {args.echo_gain}")
    print(f"  delay         : {args.delay_ms} ms")
    print(f"  mic rms       : {before:.1f}")
    print(f"  cleaned rms   : {after:.1f}")
    print(f"  ERLE          : {erle:.1f} dB  (want >= {args.min_erle_db})")

    if erle < args.min_erle_db:
        raise SystemExit(f"ERLE {erle:.1f} dB below threshold {args.min_erle_db} dB")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the harness on the board**

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/aec && python3 tools/erle.py --bin ./max-aec --delay-ms 160'
```

Expected: an ERLE figure ≥ 12 dB. If it is near 0, sweep `--delay-ms` from 40 to
400 in steps of 40 and record which values work — that range is the real delay
budget and feeds `MAX_AEC_DELAY_MS` in Task 7.

- [ ] **Step 5: Commit**

```bash
git add rdk/aec/src/apm.h rdk/aec/src/apm.cpp rdk/aec/tools/erle.py
git commit -m "feat(rdk): add the APM session and offline ERLE harness"
```

---

## Task 6: Live mode — ALSA capture and the reference pipe

**Files:**

- Modify: `rdk/aec/src/main.cpp`

**Interfaces:**

- Produces: `max-aec --device plughw:0,0 [--delay-ms N]` — reads the mic from
  ALSA, reference from fd 3, writes 16 kHz 320-sample PCM16 to stdout, resets APM
  on `SIGUSR1`.

- [ ] **Step 1: Add the live path**

In `rdk/aec/src/main.cpp`, add these includes at the top:

```cpp
#include <alsa/asoundlib.h>
#include <csignal>
#include <unistd.h>
```

Add before `main`:

```cpp
namespace {

volatile std::sig_atomic_t g_reset = 0;

void on_reset(int) { g_reset = 1; }

// 48 kHz in, 16 kHz out. 960 input samples = 20 ms = one 320-sample uplink frame.
constexpr snd_pcm_uframes_t kPeriod = 960;

int run_live(const std::string& device, int delay_ms) {
  std::signal(SIGUSR1, on_reset);

  snd_pcm_t* pcm = nullptr;
  if (snd_pcm_open(&pcm, device.c_str(), SND_PCM_STREAM_CAPTURE, 0) < 0) {
    std::fprintf(stderr, "max-aec: cannot open %s\n", device.c_str());
    return 1;
  }
  if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1, 48000, 1,
                         200000) < 0) {
    std::fprintf(stderr, "max-aec: cannot configure %s\n", device.c_str());
    snd_pcm_close(pcm);
    return 1;
  }

  ApmSession apm;
  if (!apm.init(delay_ms)) {
    std::fprintf(stderr, "max-aec: APM init failed\n");
    snd_pcm_close(pcm);
    return 1;
  }

  Decimator3 mic_dec, ref_dec;
  std::vector<int16_t> ref_pending;
  std::vector<int16_t> mic_in(kPeriod);

  for (;;) {
    if (g_reset) {
      g_reset = 0;
      apm.reset();
      ref_pending.clear();  // audio that will never be played
    }

    // Drain whatever reference is available without blocking the mic.
    int16_t ref_buf[kPeriod];
    ssize_t got = read(3, ref_buf, sizeof(ref_buf));
    if (got > 0) {
      std::vector<int16_t> down = ref_dec.process(ref_buf, static_cast<size_t>(got) / 2);
      ref_pending.insert(ref_pending.end(), down.begin(), down.end());
    }

    snd_pcm_sframes_t read_frames = snd_pcm_readi(pcm, mic_in.data(), kPeriod);
    if (read_frames < 0) {
      if (snd_pcm_recover(pcm, static_cast<int>(read_frames), 1) < 0) break;
      continue;
    }

    std::vector<int16_t> mic16 = mic_dec.process(mic_in.data(), static_cast<size_t>(read_frames));
    const size_t frame = ApmSession::kFrameSamples;
    for (size_t i = 0; i + frame <= mic16.size(); i += frame) {
      if (ref_pending.size() >= frame) {
        apm.process_reverse(ref_pending.data());
        ref_pending.erase(ref_pending.begin(), ref_pending.begin() + static_cast<long>(frame));
      }
      apm.process(&mic16[i]);
    }
    if (!mic16.empty()) {
      const size_t bytes = mic16.size() * sizeof(int16_t);
      if (write(STDOUT_FILENO, mic16.data(), bytes) != static_cast<ssize_t>(bytes)) break;
    }
  }

  snd_pcm_close(pcm);
  return 0;
}

}  // namespace
```

Set fd 3 non-blocking at the start of `run_live`, immediately after
`std::signal`:

```cpp
  int flags = fcntl(3, F_GETFL, 0);
  if (flags >= 0) fcntl(3, F_SETFL, flags | O_NONBLOCK);
```

and add `#include <fcntl.h>` to the includes.

Then extend `main`'s dispatch, before the usage message:

```cpp
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--device") == 0 && i + 1 < argc) {
      return run_live(argv[i + 1], delay_ms);
    }
  }
```

- [ ] **Step 2: Build and smoke-test on the board**

```bash
scp -r rdk/aec root@192.168.50.9:/opt/max/rdk/
ssh root@192.168.50.9 'cd /opt/max/rdk/aec && make 2>&1 | tail -10 && \
  systemctl stop max-agent; \
  timeout 5 ./max-aec --device plughw:0,0 3</dev/null > /tmp/aec.raw; \
  ls -l /tmp/aec.raw'
```

Expected: roughly `5 s × 16000 × 2 = 160000` bytes, ± a period. If the file is
empty, the ALSA device is busy — check `fuser -v /dev/snd/pcmC0D0c` and release
PulseAudio with
`sudo -u sunrise XDG_RUNTIME_DIR=/run/user/1000 pactl set-card-profile 0 off`.

- [ ] **Step 3: Confirm the output is real audio, not silence**

```bash
ssh root@192.168.50.9 'python3 -c "
import audioop,sys
d=open(\"/tmp/aec.raw\",\"rb\").read()
print(\"bytes\",len(d),\"rms\",audioop.rms(d,2))"'
```

Expected: non-zero RMS. Zero means APM's gain control muted a silent room, which
is fine — retry while speaking to confirm.

- [ ] **Step 4: Commit**

```bash
git add rdk/aec/src/main.cpp
git commit -m "feat(rdk): add live ALSA capture and reference pipe to max-aec"
```

---

## Task 7: Wire max-aec into the agent

**Files:**

- Modify: `rdk/agent/src/audio/capture.ts`, `rdk/agent/src/audio/playback.ts`, `rdk/agent/src/main.ts`
- Test: `tests/rdk-audio-io.test.ts`

**Interfaces:**

- Consumes: `createReferenceSink`, `applyCrosstalk`, config `aecMode`/`aecBin`/`aecDelayMs`
- Produces:
  - `aecArgs(device: string, delayMs: number): string[]`
  - `createCapture` gains `aec?: { bin: string; delayMs: number }` and
    `onReference?(stream: NodeJS.WritableStream | null): void`
  - `createPlayback` gains `reference?: ReferenceSink`

- [ ] **Step 1: Write the failing test**

Append to `tests/rdk-audio-io.test.ts`:

```ts
describe("aecArgs", () => {
  it("passes the device and delay to max-aec", () => {
    const args = aecArgs("plughw:0,0", 160);
    expect(args).toEqual(["--device", "plughw:0,0", "--delay-ms", "160"]);
  });
});

describe("createCapture with AEC", () => {
  it("spawns max-aec instead of arecord when configured", () => {
    const fake = fakeChild();
    let spawned = "";
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: (cmd) => {
        spawned = cmd;
        return fake.child;
      },
      onFrame: () => {},
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 160 }
    });
    capture.start();
    expect(spawned).toBe("/opt/max/rdk/aec/max-aec");
  });

  it("still spawns arecord when AEC is not configured", () => {
    const fake = fakeChild();
    let spawned = "";
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: (cmd) => {
        spawned = cmd;
        return fake.child;
      },
      onFrame: () => {}
    });
    capture.start();
    expect(spawned).toBe("arecord");
  });

  it("emits 320-sample frames unchanged — max-aec already outputs 16 kHz", () => {
    const fake = fakeChild();
    const frames: Int16Array[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: (f) => frames.push(f),
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 160 }
    });
    capture.start();
    fake.stdout.write(Buffer.from(new Int16Array(960).buffer)); // 3 frames at 16 kHz
    expect(frames.length).toBe(3);
    expect(frames[0]!.length).toBe(FRAME_SAMPLES);
  });
});

describe("playback reference", () => {
  it("forwards post-limiter audio to the reference sink", () => {
    const fake = fakeChild();
    const written: number[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      reference: {
        write: (pcm) => written.push(pcm.length),
        flush: () => {},
        close: () => {}
      }
    });
    playback.write(new Int16Array(240)); // 24 kHz in -> 480 at 48 kHz
    expect(written).toEqual([480]);
  });

  it("flushes the reference when barge-in flushes playback", () => {
    let flushes = 0;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fakeChild().child,
      reference: { write: () => {}, flush: () => (flushes += 1), close: () => {} }
    });
    playback.write(new Int16Array(240));
    playback.flush();
    expect(flushes).toBe(1);
  });
});
```

Add `aecArgs` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: FAIL — `aecArgs` is not exported and the new options are unknown.

- [ ] **Step 3: Update capture.ts**

In `rdk/agent/src/audio/capture.ts`, add:

```ts
export function aecArgs(device: string, delayMs: number): string[] {
  return ["--device", device, "--delay-ms", String(delayMs)];
}
```

Extend `CaptureOptions`:

```ts
export type CaptureOptions = {
  device: string;
  onFrame(frame: Int16Array): void;
  spawn?: SpawnLike;
  /** When set, max-aec replaces arecord and already emits 16 kHz. */
  aec?: { bin: string; delayMs: number };
  /** Receives fd 3 of max-aec — the far-end reference pipe. */
  onReference?(stream: NodeJS.WritableStream | null): void;
};
```

and replace the body of `start()` with:

```ts
    start(): void {
      if (child) return;
      const useAec = options.aec !== undefined;
      // max-aec outputs 16 kHz already; arecord needs our decimation.
      const decimate = useAec ? null : createDecimator(3, LOW_PASS_48K);
      const frame = createFramer();
      leftover = Buffer.alloc(0);

      child = useAec
        ? spawn(options.aec!.bin, aecArgs(options.device, options.aec!.delayMs))
        : spawn("arecord", captureArgs(options.device));

      child.stdout?.on("error", () => {});
      options.onReference?.(useAec ? ((child.stdio?.[3] as NodeJS.WritableStream) ?? null) : null);

      child.stdout?.on("data", (chunk: Buffer) => {
        const merged = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = merged.length - (merged.length % 2);
        leftover = Buffer.from(merged.subarray(usable));

        const samples = new Int16Array(usable / 2);
        for (let i = 0; i < samples.length; i += 1) samples[i] = merged.readInt16LE(i * 2);

        const ready = decimate ? decimate(samples) : samples;
        for (const output of frame(ready)) options.onFrame(output);
      });
    },
```

Extend `ChildProcessLike` with the extra pipe:

```ts
export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  stdio?: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>;
  kill(signal?: string): void;
  on(event: "exit", listener: () => void): void;
};
```

and give the real spawn the fourth pipe:

```ts
const spawn =
  options.spawn ??
  ((command, args) =>
    nodeSpawn(command, args, {
      stdio: ["ignore", "pipe", "inherit", "pipe"]
    }) as unknown as ChildProcessLike);
```

- [ ] **Step 4: Update playback.ts**

In `rdk/agent/src/audio/playback.ts`, extend `PlaybackOptions`:

```ts
  /** Far-end reference for AEC. Fed the post-limiter signal — see the spec. */
  reference?: { write(pcm: Int16Array): void; flush(): void; close(): void };
```

In `write`, after computing `limited`, add:

```ts
// Post-limiter, so the canceller sees exactly what the DAC receives.
options.reference?.write(limited);
```

In `flush`, before killing the child:

```ts
// Atomic with the kill: queued reference will never be played, and APM
// must forget it or it subtracts an echo that never happened.
options.reference?.flush();
```

- [ ] **Step 5: Wire main.ts**

In `rdk/agent/src/main.ts`, inside `start()`, replace the playback/capture setup with:

```ts
const aecActive = config.aecMode === "apm";
void applyCrosstalk(aecActive).then((ok) => {
  if (!ok) console.log("[audio] could not set CROSSTALK; check amixer");
});

let referenceSink = createReferenceSink({ stream: null, onReset: () => {} });
const playback = createPlayback({
  device: config.alsaPlayback,
  reference: {
    write: (pcm) => referenceSink.write(pcm),
    flush: () => referenceSink.flush(),
    close: () => referenceSink.close()
  }
});

const capture = createCapture({
  device: config.alsaCapture,
  aec: aecActive ? { bin: config.aecBin, delayMs: config.aecDelayMs } : undefined,
  onReference: (stream) => {
    referenceSink = createReferenceSink({
      stream,
      onReset: () => captureChild?.kill("SIGUSR1")
    });
  },
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
```

`createCapture` must expose the child so the reset signal can reach it. Add to
its return object in `capture.ts`:

```ts
    signal(sig: string): void {
      child?.kill(sig);
    },
```

and in `main.ts` use `capture.signal("SIGUSR1")` in place of
`captureChild?.kill("SIGUSR1")`.

Add the imports:

```ts
import { applyCrosstalk } from "./audio/mixer";
import { createReferenceSink } from "./audio/reference";
```

- [ ] **Step 6: Run the full gate**

Run: `npx vitest run && npm run check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add rdk/agent/src tests/rdk-audio-io.test.ts
git commit -m "feat(rdk): run capture through max-aec with an atomic reference flush"
```

---

## Task 8: Bench verification and docs

**Files:**

- Modify: `rdk/README.md`

- [ ] **Step 1: Deploy and measure the real delay**

```bash
ssh root@192.168.50.9 'cd /opt/max/rdk/aec && for d in 40 80 120 160 200 240 320 400; do \
  echo -n "delay ${d}ms: "; python3 tools/erle.py --bin ./max-aec --delay-ms $d 2>&1 | grep ERLE; done'
```

Record the best value; that becomes `MAX_AEC_DELAY_MS` in `/etc/max/agent.env`.

- [ ] **Step 2: Restart the agent and confirm AEC is live**

```bash
ssh root@192.168.50.9 'systemctl restart max-agent && sleep 12 && \
  journalctl -u max-agent -n 5 --no-pager && \
  amixer -c 0 sget CROSSTALK1 | tail -1'
```

Expected: `[relay] session ready`, and `CROSSTALK1` reads **0** — set by the
agent, proving the mixer now tracks the AEC state.

- [ ] **Step 3: The acceptance test — a live conversation**

Headset on, with the HUD at `http://192.168.50.9:8080`:

1. Say "Max，今天天气怎么样", then **stay silent**. Max must reply once and stop.
   No `rider:` turn may echo his words. This is the failure that shipped before.
2. Ask again, and **talk over him mid-reply**. His speech must cut within
   ~120 ms and the HUD must flip `speaking` → `hearing`.

**Both must pass in one session.** Either alone means nothing — that is exactly
how the 2026-07-25 spike reached a wrong conclusion.

- [ ] **Step 4: Check thermals under load**

```bash
ssh root@192.168.50.9 'hrut_somstatus | grep -A4 temperature'
```

The board idles near 71 °C; record the figure with AEC running.

- [ ] **Step 5: Update the README**

Replace the "AEC" section's status: record the measured `MAX_AEC_DELAY_MS`, the
offline ERLE figure, the live-conversation result, and that `CROSSTALK` is now
agent-owned. Keep the 2026-07-25 failure narrative — it is why the harness
exists.

- [ ] **Step 6: Commit**

```bash
git add rdk/README.md
git commit -m "docs(rdk): record AEC bench results and the live acceptance test"
```

---

## Plan self-review

**Spec coverage.** Reference-after-limiter → Task 7 Step 4. APM at 16 kHz with
exact frame arithmetic → Task 5. Delay alignment (config + DelayAgnostic +
logging) → Tasks 5, 8. Barge-in atomic flush → Tasks 3 and 7. Agent-owned mixer →
Tasks 2 and 7. Degradation to `arecord` → Task 7 (`aecMode: "off"`). Offline ERLE
harness → Task 5. Echo-loop detector → Task 1. Live acceptance → Task 8.

**Two risks I want named rather than buried.**

1. **The APM 0.3.1 API details are read from the installed header, but the code
   is not yet compiled.** `gain_control()->set_mode`, the `Metrics` field
   `echo_return_loss_enhancement.instant`, and the `Config`/`ExtendedFilter`
   constructors are the likeliest mismatches. Task 5 Step 2 says explicitly: read
   the header and correct, do not guess.
2. **The reference/mic alignment in `run_live` is best-effort.** It drains fd 3
   opportunistically and consumes one reference frame per mic frame. If the pipe
   starves, reference and mic drift apart and cancellation degrades. The
   `DelayAgnostic` setting absorbs some of this, and Task 8's delay sweep will
   show it — but if ERLE is good offline and poor live, this is the first place
   to look.

**Type consistency.** `ApmSession::kFrameSamples`, `Decimator3::process`,
`ReferenceSink`, `RunFn`, and `aecArgs` are each defined once and used with
identical names throughout. `createCapture` gains `aec`, `onReference` and
`signal`; all three are used in Task 7 Step 5 exactly as declared in Step 3.

**Sequencing.** Tasks 1–3 need no board. Task 4 does not build alone (it needs
`apm.h` from Task 5) and is committed deliberately as a non-building checkpoint —
the first build happens in Task 5 Step 2. Tasks 6–8 need the board and the
headset.
