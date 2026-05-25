import { describe, expect, it } from "vitest";
import { assessWeatherRisk, buildWeatherSummary, describeWeatherCode } from "../server/weather";

describe("describeWeatherCode", () => {
  it("maps clear sky", () => {
    expect(describeWeatherCode(0)).toBe("晴");
  });

  it("maps moderate rain", () => {
    expect(describeWeatherCode(63)).toBe("中雨");
  });

  it("maps thunderstorms", () => {
    expect(describeWeatherCode(95)).toContain("雷");
  });

  it("falls back for unknown codes", () => {
    expect(describeWeatherCode(424242)).toBe("未知天气");
  });
});

describe("assessWeatherRisk", () => {
  it("marks calm clear weather as normal", () => {
    expect(assessWeatherRisk("晴", 8).riskLevel).toBe("normal");
  });

  it("marks rain or strong wind as caution", () => {
    expect(assessWeatherRisk("小雨", 10).riskLevel).toBe("caution");
    expect(assessWeatherRisk("晴", 28).riskLevel).toBe("caution");
  });

  it("marks severe weather as critical", () => {
    expect(assessWeatherRisk("雷阵雨", 12).riskLevel).toBe("critical");
    expect(assessWeatherRisk("晴", 48).riskLevel).toBe("critical");
  });
});

describe("buildWeatherSummary", () => {
  it("includes the description, temperature, and wind", () => {
    const summary = buildWeatherSummary("晴", 22, 10);
    expect(summary).toContain("晴");
    expect(summary).toContain("22");
    expect(summary).toContain("10");
  });

  it("warns about crosswind when wind is strong", () => {
    expect(buildWeatherSummary("多云", 18, 40)).toContain("横风");
  });

  it("stays quiet about wind when it is calm", () => {
    expect(buildWeatherSummary("晴", 20, 5)).not.toContain("横风");
  });
});
