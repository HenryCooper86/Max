import { audioProcessingLabel } from "../src/lib/utils";
import { NETWORK_LABELS_EN } from "../src/lib/constants";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  createTranslator,
  localized,
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

  it("selects paired copy without translating user data", () => {
    expect(localized("zh-CN", "质量", "Quality")).toBe("质量");
    expect(localized("en-US", "质量", "Quality")).toBe("Quality");
    expect(localized("en-US", "用户输入", "User input")).toBe("User input");
  });
  it("localizes network and audio diagnostics without changing unknown into off", () => {
    expect(NETWORK_LABELS_EN.offline).toBe("Offline");
    expect(NETWORK_LABELS_EN.degraded).toBe("Weak connection");
    expect(audioProcessingLabel(true, "en-US")).toBe("On");
    expect(audioProcessingLabel(false, "en-US")).toBe("Off");
    expect(audioProcessingLabel("unknown", "en-US")).toBe("Unknown");
    expect(audioProcessingLabel("unknown", "zh-CN")).toBe("未知");
  });
});
