import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGE_MESSAGE, detectLanguage, isSupportedLanguageText } from "../shared/language";

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

describe("detectLanguage", () => {
  it("detects Japanese from kana", () => {
    expect(detectLanguage("ルート確認をお願いします")).toBe("ja");
  });

  it("detects Chinese from Han-only text", () => {
    expect(detectLanguage("最近的加油站在前方一公里")).toBe("zh");
  });

  it("detects English from Latin text", () => {
    expect(detectLanguage("the nearest gas station is ahead")).toBe("en");
  });

  it("treats kanji-only text as Chinese", () => {
    expect(detectLanguage("確認")).toBe("zh");
  });
});
