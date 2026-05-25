import { describe, expect, it } from "vitest";
import {
  buildSafetyPrompt,
  buildSessionMemoryPrompt,
  createSessionMemory,
  inferIntent,
  responseModeForRide,
  updateSessionMemory
} from "../shared/session";

describe("session memory and safety policy", () => {
  it("detects emergency intent and escalates response mode", () => {
    expect(inferIntent("I crashed and need help")).toBe("emergency");
    expect(responseModeForRide("ride", "emergency")).toBe("emergency");
  });

  it("keeps riding and navigation responses concise", () => {
    expect(responseModeForRide("ride", "casual")).toBe("concise");
    expect(responseModeForRide("navigation", "weather")).toBe("concise");
    expect(responseModeForRide("stop", "weather")).toBe("normal");
  });

  it("updates language, intent, destination, and response mode from rider text", () => {
    const memory = updateSessionMemory(createSessionMemory("navigation"), "帮我回家，前面堵吗？", "navigation");

    expect(memory.language).toBe("zh");
    expect(memory.lastIntent).toBe("navigation");
    expect(memory.destination).toBe("家");
    expect(memory.responseMode).toBe("concise");
  });

  it("builds compact prompt fragments for Doubao", () => {
    const memory = {
      ...createSessionMemory("emergency"),
      lastIntent: "emergency" as const,
      destination: "医院"
    };
    const memoryPrompt = buildSessionMemoryPrompt(memory);
    const safetyPrompt = buildSafetyPrompt({ mode: "emergency", scenario: "emergency", speedKmh: 18 }, memory);

    expect(memoryPrompt).toContain("医院");
    expect(safetyPrompt).toContain("紧急模式");
    expect(safetyPrompt).toContain("18");
  });
});
