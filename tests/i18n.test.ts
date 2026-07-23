import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  createTranslator,
  readStoredLanguage
} from "../src/lib/i18n";

function storage(values: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(values));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    }
  };
}

describe("UI language core", () => {
  it("defaults to Chinese and rejects unsupported persisted values", () => {
    expect(DEFAULT_LANGUAGE).toBe("zh-CN");
    expect(readStoredLanguage(storage())).toBe("zh-CN");
    expect(readStoredLanguage(storage({ [LANGUAGE_STORAGE_KEY]: "fr-FR" }))).toBe("zh-CN");
  });

  it("restores English from storage", () => {
    expect(readStoredLanguage(storage({ [LANGUAGE_STORAGE_KEY]: "en-US" }))).toBe("en-US");
  });

  it("translates and interpolates UI copy", () => {
    const t = createTranslator("en-US");
    expect(t("settings.title")).toBe("Settings");
    expect(t("login.welcome", { product: "Max" })).toContain("Max");
  });
});
