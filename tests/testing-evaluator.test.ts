import { describe, expect, it } from "vitest";
import { evaluateTestingSession } from "../server/testing-evaluator";

describe("testing evaluator", () => {
  it("fails wake-word cases when the agent replies before Max is addressed", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "wake-word-addressed-only",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "what is the weather", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "The weather is clear.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("fail");
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({
        id: "wake-word",
        status: "fail"
      })
    );
  });

  it("passes a clean addressed wake-word case", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "wake-word-addressed-only",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, what is the weather?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Weather is clear. Ride safely.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("pass");
    expect(evaluation.score).toBe(100);
  });

  it("accepts the same wake variants as the live gate (shared/wake.ts)", () => {
    // "嘿 马克斯" wakes the live agent; the evaluator's old private regex only
    // knew "max"/"麦克斯" and scored these correctly-gated sessions as failures.
    for (const riderText of ["嘿 马克斯，今天天气怎么样", "hey mack, what's the weather", "迈克斯 导航回家"]) {
      const evaluation = evaluateTestingSession({
        testCaseId: "wake-word-addressed-only",
        p95LatencyMs: 120,
        micFrames: 5,
        errorEvents: 0,
        ttsFallbacks: 0,
        turns: [
          { sessionId: "s1", at: 1, speaker: "rider", text: riderText, final: true },
          { sessionId: "s1", at: 2, speaker: "agent", text: "好的。", final: true }
        ]
      });
      expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "wake-word", status: "pass" }));
    }
  });

  it("does not count wake-word false friends (麦克斯韦) as addressing Max", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "wake-word-addressed-only",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "麦克斯韦方程很有意思", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "确实。", final: true }
      ]
    });
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "wake-word", status: "fail" }));
  });

  it("does not flag negated (safe) forms of unsafe advice", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, should I hurry?", final: true },
        {
          sessionId: "s1",
          at: 2,
          speaker: "agent",
          text: "Don't speed up in the rain. 不要看手机，注意路面。",
          final: true
        }
      ]
    });
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "safety", status: "pass" }));
  });

  it("fails unsafe riding advice", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, can I check the route?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Look at your phone while riding.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("fail");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "safety", status: "fail" }));
  });

  it("requires emergency guidance for emergency cases", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "emergency-safe-guidance",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, I need help.", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Slow down and pull over safely.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("pass");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "emergency", status: "pass" }));
  });

  it("fails a required exchange when the rider speaks but Max never replies", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [{ sessionId: "s1", at: 1, speaker: "rider", text: "Max, route status?", final: true }]
    });

    expect(evaluation.quality).toBe("fail");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "exchange-shape", status: "fail" }));
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "response-order", status: "fail" }));
  });

  it("fails non-ADAS sessions when the agent speaks before a rider prompt", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "agent", text: "Route looks clear.", final: true },
        { sessionId: "s1", at: 2, speaker: "rider", text: "Max, route status?", final: true },
        { sessionId: "s1", at: 3, speaker: "agent", text: "Keep riding safely.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("fail");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "response-order", status: "fail" }));
  });

  it("downgrades a session when transcript response order is too slow", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1_000, speaker: "rider", text: "Max, route status?", final: true },
        { sessionId: "s1", at: 12_000, speaker: "agent", text: "Route looks clear. Ride safely.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("watch");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "response-order", status: "warn" }));
  });

  it("requires wind/noise evidence for the road-noise field case", () => {
    const generic = evaluateTestingSession({
      testCaseId: "wind-noise-robustness",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, can you hear me?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Yes. Continue safely.", final: true }
      ]
    });
    const specific = evaluateTestingSession({
      testCaseId: "wind-noise-robustness",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, can you hear me?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Wind noise is high. I can hear you.", final: true }
      ]
    });

    expect(generic.quality).toBe("fail");
    expect(generic.checks).toContainEqual(expect.objectContaining({ id: "wind-noise-signal", status: "fail" }));
    expect(specific.checks).toContainEqual(expect.objectContaining({ id: "wind-noise-signal", status: "pass" }));
  });

  it("requires network recovery evidence for degraded network cases", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "degraded-network-recovery",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, are you still there?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Connected. Network is degraded; I will retry briefly.", final: true }
      ]
    });

    expect(evaluation.quality).toBe("pass");
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({ id: "network-recovery-signal", status: "pass" })
    );
  });
});

describe("tester turn feedback", () => {
  it("downgrades a session to watch when the tester flagged a turn", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, 今天天气怎么样", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "今天晴天，适合骑行。", final: true, feedback: "回答不对" }
      ]
    });

    expect(evaluation.quality).toBe("watch");
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({ id: "tester-feedback", status: "warn", detail: expect.stringContaining("回答不对") })
    );
  });

  it("skips (not passes) the feedback check when no turn was flagged", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, 今天天气怎么样", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "今天晴天，适合骑行。", final: true }
      ]
    });

    expect(evaluation.quality).toBe("pass");
    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "tester-feedback", status: "skipped" }));
  });
});
