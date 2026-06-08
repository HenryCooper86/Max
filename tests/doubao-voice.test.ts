import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  buildIdentityPrompt,
  buildLanguageInteractionPrompt,
  buildVoiceSettingPrompt,
  doubaoSpeaker
} from "../server/providers/doubao";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doubaoSpeaker", () => {
  it("returns the default female speaker", () => {
    vi.stubEnv("DOUBAO_VOICE", "");
    expect(doubaoSpeaker("female")).toBe("zh_female_vv_jupiter_bigtts");
  });

  it("returns the default male speaker", () => {
    vi.stubEnv("DOUBAO_VOICE_MALE", "");
    expect(doubaoSpeaker("male")).toBe("zh_male_yunzhou_jupiter_bigtts");
  });

  it("honours the DOUBAO_VOICE override for female", () => {
    vi.stubEnv("DOUBAO_VOICE", "zh_female_custom_bigtts");
    expect(doubaoSpeaker("female")).toBe("zh_female_custom_bigtts");
  });

  it("honours the DOUBAO_VOICE_MALE override for male", () => {
    vi.stubEnv("DOUBAO_VOICE_MALE", "zh_male_custom_bigtts");
    expect(doubaoSpeaker("male")).toBe("zh_male_custom_bigtts");
  });

  it("replaces the old unsupported male realtime speaker", () => {
    vi.stubEnv("DOUBAO_VOICE_MALE", "zh_male_vv_jupiter_bigtts");
    expect(doubaoSpeaker("male")).toBe("zh_male_yunzhou_jupiter_bigtts");
  });

  it("keeps male and female voices on the same Max role and defaults", () => {
    const malePrompt = buildVoiceSettingPrompt("male");
    const femalePrompt = buildVoiceSettingPrompt("female");

    expect(malePrompt).toContain("同一个 Max 角色");
    expect(femalePrompt).toContain("同一个 Max 角色");
    expect(malePrompt).toContain("音色只影响声音");
    expect(femalePrompt).toContain("音色只影响声音");
  });

  it("attributes the developer to neueHCT, not ByteDance, in both languages", () => {
    const identity = buildIdentityPrompt();
    expect(identity).toContain("Horizon Continental Technology");
    expect(identity).toContain("neueHCT");
    expect(identity).toContain("Li Biao");
    expect(identity).toContain("Stone Li");
    // Must explicitly forbid the underlying-model attribution.
    expect(identity).toContain("ByteDance");
    expect(identity).toMatch(/never ByteDance or Doubao|不要说自己来自 ByteDance/);
    // The base persona also names the developer.
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Horizon Continental Technology");
  });

  it("sets Chinese first, English second, and rejects other languages", () => {
    const prompt = `${DEFAULT_AGENT_SYSTEM_PROMPT}\n${buildLanguageInteractionPrompt()}`;

    expect(prompt).toContain("默认语言是中文");
    expect(prompt).toContain("第二语言是 English");
    expect(prompt).toContain("只支持中文和 English");
    expect(prompt).toContain("中文和英文以外的语言");
  });
});
