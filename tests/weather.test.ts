import { describe, expect, it } from "vitest";
import { buildWeatherSummary, describeWeatherCode } from "../server/weather";

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
