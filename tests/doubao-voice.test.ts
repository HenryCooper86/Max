import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  buildDoubaoDialogContext,
  buildDoubaoSessionConfig,
  buildIdentityPrompt,
  buildLanguageInteractionPrompt,
  buildToolGroundingPrompt,
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

  it("states unsupported external actions honestly", () => {
    const prompt = buildToolGroundingPrompt();
    // The relay now dispatches real device commands, so the prompt declares the
    // executable set and keeps everything else explicitly out of reach.
    expect(prompt).toContain("除此之外没有工具");
    expect(prompt).toContain("实时交通");
    expect(prompt).toContain("车辆控制或诊断");
    expect(prompt).toContain("系统明确返回成功");
  });

  it("refuses to claim a dial or send the rider has not confirmed", () => {
    const prompt = buildToolGroundingPrompt();
    expect(prompt).toContain("不要说已经拨通或已经发送");
  });
});

describe("Doubao realtime configuration", () => {
  it("enables documented VAD, two-pass ASR, truncation, loudness, and speaking style controls", () => {
    const config = buildDoubaoSessionConfig({
      sampleRate: 16000,
      channels: 1,
      voiceGender: "female",
      systemRole: "system",
      speakingStyle: "brief",
      location: { latitude: 31.2, longitude: 121.5 }
    });

    expect(config.dialog).toMatchObject({
      system_role: "system",
      speaking_style: "brief",
      location: { latitude: 31.2, longitude: 121.5 },
      extra: {
        strict_audit: true,
        enable_loudness_norm: true,
        enable_conversation_truncate: true,
        model: "1.2.1.1"
      }
    });
    expect(config.asr.extra).toMatchObject({
      end_smooth_window_ms: 900,
      enable_custom_vad: true,
      enable_asr_twopass: true
    });
    expect(config.asr.extra.context.hotwords.map(({ word }) => word)).toEqual(["Max", "马克斯", "麦克斯"]);
    expect(config.tts.audio_config).toMatchObject({ speech_rate: 8, loudness_rate: 10 });
  });

  it("keeps only complete, bounded rider/assistant pairs in structured history", () => {
    const turns = Array.from({ length: 45 }, (_, index) => ({
      at: index + 1,
      speaker: (index % 2 === 0 ? "rider" : "agent") as "rider" | "agent",
      text: `turn-${index}`
    }));
    const context = buildDoubaoDialogContext(turns);

    expect(context).toHaveLength(40);
    expect(context[0]?.role).toBe("user");
    expect(context.at(-1)?.role).toBe("assistant");
    expect(context.every((item, index) => index === 0 || item.timestamp > context[index - 1]!.timestamp)).toBe(true);
  });
});
