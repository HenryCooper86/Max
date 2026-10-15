import { describe, expect, it } from "vitest";
import { evaluateTestingSession } from "../server/testing-evaluator";

describe("testing evaluator", () => {
  it.each([
    { p95LatencyMs: 0, latencySamples: 1, expected: "pass" },
    { p95LatencyMs: 0, latencySamples: undefined, expected: "warn" },
    { p95LatencyMs: 0, latencySamples: 0, expected: "warn" },
    { p95LatencyMs: 0, latencySamples: -1, expected: "warn" },
    { p95LatencyMs: 0, latencySamples: Number.NaN, expected: "warn" },
    { p95LatencyMs: 0, latencySamples: Number.POSITIVE_INFINITY, expected: "warn" },
    { p95LatencyMs: Number.NaN, latencySamples: 1, expected: "fail" },
    { p95LatencyMs: Number.POSITIVE_INFINITY, latencySamples: 1, expected: "fail" }
  ])(
    "distinguishes measured zero latency from missing or invalid evidence: $p95LatencyMs/$latencySamples",
    ({ p95LatencyMs, latencySamples, expected }) => {
      const input = {
        testCaseId: "baseline-live-session",
        p95LatencyMs,
        latencySamples,
        micFrames: 5,
        errorEvents: 0,
        ttsFallbacks: 0,
        turns: [
          { sessionId: "zero", at: 1, speaker: "rider" as const, text: "Max, hello.", final: true },
          { sessionId: "zero", at: 2, speaker: "agent" as const, text: "Hello, ride safely.", final: true }
        ]
      };
      expect(evaluateTestingSession(input).checks).toContainEqual(
        expect.objectContaining({ id: "latency", status: expected })
      );
    }
  );

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

  it("does not keep the wake gate open forever after one addressed turn", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "wake-word-addressed-only",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1_000, speaker: "rider", text: "Max, what is the weather?", final: true },
        { sessionId: "s1", at: 2_000, speaker: "agent", text: "Weather is clear.", final: true },
        // Far beyond the bounded follow-up chain: background speech must not
        // inherit the very first wake phrase forever.
        { sessionId: "s1", at: 70_000, speaker: "rider", text: "Passenger, are you ready?", final: true },
        { sessionId: "s1", at: 71_000, speaker: "agent", text: "Ready.", final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "wake-word", status: "fail" }));
  });

  it("accepts an unprefixed follow-up inside the live wake window", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "wake-word-addressed-only",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1_000, speaker: "rider", text: "Max, what is the weather?", final: true },
        { sessionId: "s1", at: 2_000, speaker: "agent", text: "Weather is clear.", final: true },
        { sessionId: "s1", at: 5_000, speaker: "rider", text: "What about the wind?", final: true },
        { sessionId: "s1", at: 6_000, speaker: "agent", text: "Light crosswind. Ride safely.", final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "wake-word", status: "pass" }));
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
          text: "Don't speed up in the rain. Don't ignore traffic. 不要看手机，别忽略后方车辆。",
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

  it.each([
    ["骑行中别分神看手机,若需调整设备或查信息,建议停车后操作。", "pass"],
    ["骑行中别分心看手机，若需操作，先找安全地方停车。", "pass"],
    ["骑行中不低头看手机,不单手骑车。", "pass"],
    ["骑行中不要低头查看手机。", "pass"],
    ["骑行中分神看手机确认路线。", "fail"],
    ["骑行中分心看手机确认路线。", "fail"],
    ["骑行中低头看手机确认路线。", "fail"],
    ["别分神，看手机确认路线。", "fail"],
    ["别分心，看手机确认路线。", "fail"],
    ["别分心。看手机确认路线。", "fail"],
    ["别分神,看手机确认路线。", "fail"],
    ["不低头。看手机确认路线。", "fail"]
  ])("keeps Chinese phone-safety negation within its clause: %s", (text, status) => {
    const evaluation = evaluateTestingSession({
      testCaseId: "baseline-live-session",
      p95LatencyMs: 120,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, how should I ride safely?", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text, final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "safety", status }));
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

  it("does not pass an emergency case on a generic acknowledgement", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "emergency-safe-guidance",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: "Max, I need emergency help.", final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: "Emergency situation acknowledged. Stay safe.", final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "emergency", status: "fail" }));
  });

  it("does not mistake ordinary navigation direction for an ADAS alert", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "adas-alert-interrupt",
      p95LatencyMs: 180,
      micFrames: 0,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [{ sessionId: "s1", at: 1, speaker: "agent", text: "Turn right at the next street.", final: true }]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "adas", status: "fail" }));
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
        {
          sessionId: "s1",
          at: 2,
          speaker: "agent",
          text: "Connected. Network is degraded; I will retry briefly.",
          final: true
        }
      ]
    });

    expect(evaluation.quality).toBe("pass");
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({ id: "network-recovery-signal", status: "pass" })
    );
  });

  const connectivityPrompt = "Max, 刚才网络信号不好,连接恢复以后我应该注意什么?";
  it.each([
    [
      "Max, are you there?",
      "先确认导航路线是否正常,再留意手机电量,避免再次断联。骑行中若需操作,建议停车后处理。",
      "pass"
    ],
    ["Max, are you there?", "刚才断连了，请安全停车后再检查设备。", "pass"],
    ["Max, are you there?", "刚才掉线了，先安全停车。", "pass"],
    [connectivityPrompt, "先确认头盔音量和通话是否正常,再留意手机导航有没有重新同步路线,确保骑行动态没问题。", "pass"],
    [
      connectivityPrompt,
      "先确认头盔音量是否正常,能听清提示。再检查导航是否重新定位,若没恢复,可说“重新导航”,我会帮你重启导航。骑行中注意观察路况,保持安全车距。",
      "pass"
    ],
    ["Max, is the NETWORK back?", "若未恢复，请停车后重试。", "pass"],
    [
      connectivityPrompt,
      "先确认导航路线是否正常,再留意当前车速,保持安全车距。如果刚经过复杂路况,可短暂观察后视镜,确认周围车辆状态。",
      "fail"
    ],
    [connectivityPrompt, "导航已经恢复，注意路况。", "fail"],
    [connectivityPrompt, "导航需要重新定位，请注意路况。", "fail"],
    ["Max, 我想换一条导航路线。", "若没恢复，可说重新导航，我会帮你重启导航。", "fail"],
    ["Max, 我想换一条导航路线。", "手机导航需要重新同步路线。", "fail"],
    ["Max, a connectionist model means what?", "若未恢复，请重试。", "fail"],
    [connectivityPrompt, "若没恢复，请先停车。重新导航。", "fail"],
    [connectivityPrompt, "若未恢复，请先停车!重启导航。", "fail"],
    [connectivityPrompt, "若没恢复，请先停车\n重试。", "fail"]
  ])("requires precise network recovery wording and its rider context: %s / %s", (rider, reply, status) => {
    const evaluation = evaluateTestingSession({
      testCaseId: "degraded-network-recovery",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: rider, final: true },
        { sessionId: "s1", at: 2, speaker: "agent", text: reply, final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(expect.objectContaining({ id: "network-recovery-signal", status }));
  });

  it("does not inherit a connectivity prompt across an unrelated rider turn", () => {
    const evaluation = evaluateTestingSession({
      testCaseId: "degraded-network-recovery",
      p95LatencyMs: 180,
      micFrames: 5,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "s1", at: 1, speaker: "rider", text: connectivityPrompt, final: true },
        { sessionId: "s1", at: 2, speaker: "rider", text: "Max, 我想换一条导航路线。", final: true },
        { sessionId: "s1", at: 3, speaker: "agent", text: "手机导航需要重新同步路线。", final: true }
      ]
    });

    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({ id: "network-recovery-signal", status: "fail" })
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
