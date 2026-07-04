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
});
