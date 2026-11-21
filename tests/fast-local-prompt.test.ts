import { describe, expect, it } from "vitest";
import { forFastLocalModel } from "../server/prompts";
import { buildLiveInstructions } from "../server/providers/live/session";
import { createSessionMemory } from "../shared/session";

const stockPrompt = () =>
  buildLiveInstructions({
    event: { type: "session.start", sampleRate: 16000, channels: 1 },
    rideContext: { mode: "ride", scenario: "commute" },
    memory: createSessionMemory("ride"),
    weatherRole: "",
    locationRole: "",
    wakeWord: false
  });

describe("instructions for a local model without a thinking step", () => {
  it("removes every scripted refusal from the stock assistant and keeps the language limit", () => {
    const stock = stockPrompt();
    expect(stock).toContain("我只支持中文和 English");
    const fast = forFastLocalModel(stock);
    expect(fast).not.toContain("我只支持");
    expect(fast).not.toContain("简短拒绝");
    expect(fast).toContain("[回答语言] 只用中文或 English 回答");
  });

  it("leaves a persona without the scripted refusal exactly as written", () => {
    const custom = "You are Nova. Answer in French or English.";
    expect(forFastLocalModel(custom)).toBe(custom);
  });
});
