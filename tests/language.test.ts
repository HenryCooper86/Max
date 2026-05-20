import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGE_MESSAGE, isSupportedLanguageText } from "../shared/language";

describe("isSupportedLanguageText", () => {
  it("accepts Chinese", () => {
    expect(isSupportedLanguageText("帮我找最近的加油站")).toBe(true);
  });

  it("accepts English", () => {
    expect(isSupportedLanguageText("find the nearest gas station")).toBe(true);
  });

  it("accepts Japanese", () => {
    expect(isSupportedLanguageText("一番近いガソリンスタンドを探して")).toBe(true);
  });

  it("accepts supported scripts mixed with digits and punctuation", () => {
    expect(isSupportedLanguageText("ETA 18:42，到家路线")).toBe(true);
  });

  it("rejects Korean", () => {
    expect(isSupportedLanguageText("가장 가까운 주유소")).toBe(false);
  });

  it("rejects Cyrillic", () => {
    expect(isSupportedLanguageText("ближайшая заправка")).toBe(false);
  });

  it("exposes the refusal message", () => {
    expect(SUPPORTED_LANGUAGE_MESSAGE).toContain("日本語");
  });
});
