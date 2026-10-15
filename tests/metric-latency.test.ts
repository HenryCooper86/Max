import { describe, expect, it } from "vitest";
import { displayedMetricLatency } from "../src/lib/metric-latency";

describe("HUD metric latency", () => {
  it("records a genuine zero latency sample", () => {
    expect(displayedMetricLatency({ type: "metric", latencyMs: 0 })).toBe(0);
  });

  it("preserves the current latency for frames-only zero placeholders", () => {
    expect(displayedMetricLatency({ type: "metric", latencyMs: 0, outgoingFps: 50 })).toBeUndefined();
    expect(displayedMetricLatency({ type: "metric", latencyMs: 0, droppedFrames: 0 })).toBeUndefined();
    expect(displayedMetricLatency({ type: "metric", latencyMs: 0, outgoingFps: 0, droppedFrames: 2 })).toBeUndefined();
  });

  it("accepts positive samples and refuses invalid numbers", () => {
    expect(displayedMetricLatency({ type: "metric", latencyMs: 42, outgoingFps: 50 })).toBe(42);
    for (const latencyMs of [-1, Number.NaN, Infinity]) {
      expect(displayedMetricLatency({ type: "metric", latencyMs })).toBeUndefined();
    }
  });
});
