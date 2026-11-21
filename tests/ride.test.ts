import { describe, expect, it } from "vitest";
import {
  buildRideContextSummary,
  combineHazardLevels,
  describeRideMode,
  rideModeFromScenario,
  scenarioDefaultMode,
  scenarioLabel
} from "../shared/ride";

describe("ride intelligence", () => {
  it("maps emergency scenarios to emergency mode", () => {
    expect(scenarioDefaultMode("emergency")).toBe("emergency");
    expect(rideModeFromScenario(undefined, "emergency")).toBe("emergency");
  });

  it("keeps explicit ride modes over scenario defaults", () => {
    expect(rideModeFromScenario("stop", "emergency")).toBe("stop");
  });

  it("describes critical emergency behavior", () => {
    expect(describeRideMode("emergency").hazardLevel).toBe("critical");
    expect(describeRideMode("emergency").safetyRule).toContain("生命安全");
  });

  it("lets the assistant answer small talk while riding or navigating, but not in an emergency", () => {
    for (const mode of ["ride", "navigation"] as const) {
      expect(describeRideMode(mode).safetyRule).toContain("闲聊、笑话和常识问题用一两句话直接回答");
      expect(describeRideMode(mode).safetyRule).not.toContain("避免闲聊");
    }
    expect(describeRideMode("ride").safetyRule).toContain("改为建议停车后继续");
    expect(describeRideMode("emergency").safetyRule).not.toContain("闲聊");
  });

  it("builds a concise ride context summary", () => {
    const summary = buildRideContextSummary({
      mode: "navigation",
      scenario: "fuel",
      speedKmh: 62,
      routePhase: "高速出口前",
      network: "degraded",
      batteryPct: 34
    });

    expect(summary).toContain("导航");
    expect(summary).toContain(scenarioLabel("fuel"));
    expect(summary).toContain("62");
    expect(summary).toContain("高速出口前");
    expect(summary).toContain("34");
  });

  it("keeps the higher hazard level", () => {
    expect(combineHazardLevels("normal", "caution")).toBe("caution");
    expect(combineHazardLevels("critical", "caution")).toBe("critical");
  });
});
