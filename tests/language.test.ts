import { describe, expect, it } from "vitest";
import { detectLanguage } from "../shared/language";

describe("detectLanguage", () => {
  it("detects Chinese from Han-only text", () => {
    expect(detectLanguage("最近的加油站在前方一公里")).toBe("zh");
  });

  it("detects English from Latin text", () => {
    expect(detectLanguage("the nearest gas station is ahead")).toBe("en");
  });

  it("treats kanji-only text as Chinese", () => {
    expect(detectLanguage("確認")).toBe("zh");
  });

  it("falls back to English for non-Han non-Latin text", () => {
    expect(detectLanguage("hello world")).toBe("en");
  });
});
