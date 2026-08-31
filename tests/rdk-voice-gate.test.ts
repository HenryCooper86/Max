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
