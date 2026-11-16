import { afterEach, describe, expect, it } from "vitest";
import {
  assistantProfileFrom,
  assistantSummary,
  basePersonaPrompt,
  DEFAULT_ASSISTANT_PROFILE,
  identityPrompt,
  setAssistantProfileForTests,
  wakeHint
} from "../server/assistant";
import { DEFAULT_AGENT_SYSTEM_PROMPT, buildIdentityPrompt } from "../server/providers/doubao";
import { containsWakePhrase, createWakeMatcher } from "../shared/wake";

afterEach(() => setAssistantProfileForTests());

describe("assistant profile", () => {
  it("keeps the original Max persona when nothing is configured", () => {
    expect(basePersonaPrompt()).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(basePersonaPrompt()).toMatch(/^你是 Max，/);
    expect(buildIdentityPrompt()).toContain("Horizon Continental Technology（neueHCT）");
    expect(assistantSummary(true)).toMatchObject({ name: "Max", device: "helmet", wakePhrase: "Max" });
    expect(wakeHint()).toContain('"Max"');
  });

  it("builds an English smart-glasses persona that does not inherit the original maker", () => {
    const profile = assistantProfileFrom({
      name: "Nova",
      device: "glasses",
      languages: ["en", "es"],
      accentColor: "#ff8800",
      wake: { names: ["noah", "诺瓦"] }
    });
    const persona = basePersonaPrompt(profile);
    expect(persona).toContain("You are Nova");
    expect(persona).toContain("smart glasses");
    expect(persona).toContain("English and Spanish");
    expect(persona + identityPrompt(profile)).not.toMatch(/Horizon|neueHCT|Max/);
    expect(identityPrompt(profile)).toContain("never name a company");
    expect(profile.accentColor).toBe("#FF8800");
    expect(profile.wake).toMatchObject({ label: "Nova", latin: ["nova", "noah"], cjk: ["诺瓦"] });
    expect(profile.strictLanguages).toBe(false);
  });

  it("states the configured developer and writes Chinese prompts for a Chinese-first assistant", () => {
    const profile = assistantProfileFrom({ name: "小飞", developer: "Acme Labs", languages: ["zh"] });
    expect(basePersonaPrompt(profile)).toContain("你是 小飞");
    expect(identityPrompt(profile)).toContain("我由 Acme Labs 开发");
    expect(profile.wake.cjk).toEqual(["小飞"]);
  });

  it("uses a persona override verbatim and rejects malformed config", () => {
    expect(basePersonaPrompt(assistantProfileFrom({ name: "Rex", persona: "Be brief." }))).toBe("Be brief.");
    expect(() => assistantProfileFrom([])).toThrow(/JSON object/);
    expect(assistantProfileFrom({ accentColor: "lime" }).accentColor).toBeUndefined();
  });

  it("switches the relay's wake phrase with the profile", () => {
    expect(containsWakePhrase("hey nova what time is it")).toBe(false);
    setAssistantProfileForTests(assistantProfileFrom({ name: "Nova", wake: { names: ["诺瓦"] } }));
    expect(containsWakePhrase("hey nova what time is it")).toBe(true);
    expect(containsWakePhrase("诺瓦今天天气怎么样")).toBe(true);
    expect(containsWakePhrase("Max, what time is it")).toBe(false);
    expect(wakeHint()).toContain("Nova");
    setAssistantProfileForTests(DEFAULT_ASSISTANT_PROFILE);
    expect(containsWakePhrase("Max, what time is it")).toBe(true);
  });
});

describe("wake matcher", () => {
  const matches = createWakeMatcher({
    label: "Nova",
    latin: ["nova", "hey computer"],
    cjk: ["诺瓦"],
    falseFriends: ["诺瓦克"]
  });

  it("matches whole tokens only", () => {
    expect(matches("Nova, lights on")).toBe(true);
    expect(matches("that is an innovative idea")).toBe(false);
    expect(matches("supernova")).toBe(false);
    expect(matches("ok, hey computer start navigation")).toBe(true);
  });

  it("matches Han names inside unspaced text but not their false friends", () => {
    expect(matches("请问诺瓦现在几点")).toBe(true);
    expect(matches("诺瓦克赢了比赛")).toBe(false);
  });

  it("never matches when no names are configured", () => {
    expect(createWakeMatcher({ label: "", latin: [], cjk: [], falseFriends: [] })("anything")).toBe(false);
  });
});
