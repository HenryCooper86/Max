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
