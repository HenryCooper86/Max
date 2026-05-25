import { afterEach, describe, expect, it, vi } from "vitest";
import { doubaoSpeaker } from "../server/providers/doubao";

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
    expect(doubaoSpeaker("male")).toBe("zh_male_vv_jupiter_bigtts");
  });

  it("honours the DOUBAO_VOICE override for female", () => {
    vi.stubEnv("DOUBAO_VOICE", "zh_female_custom_bigtts");
    expect(doubaoSpeaker("female")).toBe("zh_female_custom_bigtts");
  });

  it("honours the DOUBAO_VOICE_MALE override for male", () => {
    vi.stubEnv("DOUBAO_VOICE_MALE", "zh_male_custom_bigtts");
    expect(doubaoSpeaker("male")).toBe("zh_male_custom_bigtts");
  });
});
