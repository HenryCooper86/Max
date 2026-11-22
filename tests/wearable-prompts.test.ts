import { afterEach, describe, expect, it } from "vitest";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { buildToolGroundingPrompt, buildWearerWeatherPrompt, promptAudience } from "../server/prompts";
import { buildLiveInstructions } from "../server/providers/live/session";
import type { SessionStartEvent } from "../server/providers/types";
import { RiderLocationContext } from "../server/rider-location";
import { buildDeviceContextSummary } from "../shared/ride";
import {
  buildIntentGuidancePrompt,
  buildSafetyPrompt,
  buildSessionMemoryPrompt,
  createSessionMemory
} from "../shared/session";

// A helmet's rules talk about riding. Glasses and headsets share the device
// actions and honesty rules but must never be told their wearer is a rider.

const START: SessionStartEvent = { type: "session.start", sampleRate: 16000, channels: 1 };
const base = {
  event: START,
  rideContext: { mode: "ride", scenario: "commute" } as const,
  memory: createSessionMemory("ride"),
  weatherRole: "",
  locationRole: "",
  wakeWord: false
};
const RIDING_WORDS = ["骑手", "骑行", "头盔", "停车", "摩托"];

afterEach(() => setAssistantProfileForTests(undefined));

describe("who the rules are written for", () => {
  it("is the rider for helmets and the wearer for everything else", () => {
    expect(promptAudience(assistantProfileFrom({}))).toBe("rider");
    expect(promptAudience(assistantProfileFrom({ name: "Kite", device: "bicycle-helmet" }))).toBe("rider");
    expect(promptAudience(assistantProfileFrom({ name: "Nova", device: "vr-headset" }))).toBe("wearer");
    expect(promptAudience(assistantProfileFrom({ name: "Iris", device: "assistive-glasses" }))).toBe("wearer");
  });
});

describe("instructions for a wearable that is not a helmet", () => {
  const profile = assistantProfileFrom({ name: "Nova", device: "vr-headset", languages: ["en"] });

  it("carry the device actions without any riding wording", () => {
    const text = buildLiveInstructions({ ...base, profile });
    expect(text).toContain("You are Nova");
    expect(text).toContain("[真实能力边界]");
    expect(text).toContain("[安全策略] 简洁模式");
    for (const word of RIDING_WORDS) expect(text, word).not.toContain(word);
  });

  it("leave out Max's own Chinese-and-English rule and remembered language", () => {
    const text = buildLiveInstructions({ ...base, profile });
    expect(text).not.toContain("只支持中文和 English");
    expect(text).not.toContain("[语言与交互规则]");
    expect(text).not.toContain("语言偏好");
  });

  it("do not rule out the tools the owner gave the assistant", () => {
    expect(buildToolGroundingPrompt("wearer")).toContain("系统提供给你的工具");
    expect(buildToolGroundingPrompt("wearer")).not.toContain("除此之外没有工具");
  });

  it("describe the device only when there is something to say", () => {
    expect(buildLiveInstructions({ ...base, profile })).not.toContain("[设备上下文]");
    const text = buildLiveInstructions({
      ...base,
      profile,
      rideContext: { mode: "navigation", scenario: "commute", batteryPct: 40, network: "online" }
    });
    expect(text).toContain("[设备上下文] 正在导航；网络：online；设备电量：40%。");
  });

  it("keep the wake rule, the owner's instructions and the app's context", () => {
    const custom = assistantProfileFrom({
      name: "Nova",
      device: "smart-glasses",
      languages: ["en"],
      instructions: "Always greet the wearer by name."
    });
    const text = buildLiveInstructions({
      ...base,
      profile: custom,
      wakeWord: true,
      event: { ...START, context: "The wearer is in the museum lobby." }
    });
    expect(text).toContain("[唤醒规则]");
    expect(text).toContain("Always greet the wearer by name.");
    expect(text).toContain("museum lobby");
  });
});

describe("instructions for helmets", () => {
  it("keep the stock assistant's riding rules and language rule", () => {
    const text = buildLiveInstructions(base);
    expect(text).toContain("你是 Max");
    expect(text).toContain("[骑行上下文]");
    expect(text).toContain("[语言与交互规则]");
    expect(text).toContain("意图指导：语言规则。只支持中文和 English");
    expect(text).toContain("语言偏好：中文");
  });

  it("keep riding rules for a customised helmet but not Max's language rule", () => {
    setAssistantProfileForTests(
      assistantProfileFrom({ name: "Kite", device: "bicycle-helmet", languages: ["ja", "en"] })
    );
    const text = buildLiveInstructions(base);
    expect(text).toContain("[骑行上下文]");
    expect(text).toContain("骑行模式");
    expect(text).not.toContain("只支持中文和 English");
    expect(text).not.toContain("语言偏好");
    // No blank line is left where the dropped intent line used to be.
    expect(text).not.toMatch(/\n\n人格风格/);
  });

  it("use the riding wording unless asked otherwise", () => {
    const memory = createSessionMemory("ride");
    const context = { mode: "ride", scenario: "commute", speedKmh: 80 } as const;
    expect(buildToolGroundingPrompt()).toBe(buildToolGroundingPrompt("rider"));
    expect(buildSafetyPrompt(context, memory)).toBe(buildSafetyPrompt(context, memory, "rider"));
    expect(buildSafetyPrompt(context, memory)).toContain("骑行模式");
    expect(buildIntentGuidancePrompt("diagnostics")).toContain("摩托车诊断");
    expect(buildSessionMemoryPrompt(memory)).toContain("语言偏好：中文");
  });
});

describe("wearer wording of the shared rules", () => {
  it("covers every response mode without riding words", () => {
    const context = { mode: "ride", scenario: "commute", speedKmh: 80, batteryPct: 50 } as const;
    for (const responseMode of ["concise", "emergency", "normal"] as const) {
      const text = buildSafetyPrompt(context, { ...createSessionMemory("ride"), responseMode }, "wearer");
      expect(text).toContain("[安全策略]");
      for (const word of RIDING_WORDS) expect(text, `${responseMode}: ${word}`).not.toContain(word);
    }
  });

  it("guides only the intents that apply off the bike", () => {
    for (const intent of ["navigation", "weather", "emergency", "casual"] as const) {
      const text = buildIntentGuidancePrompt(intent, { audience: "wearer" });
      expect(text).toContain("意图指导");
      for (const word of RIDING_WORDS) expect(text, `${intent}: ${word}`).not.toContain(word);
    }
    expect(buildIntentGuidancePrompt("diagnostics", { audience: "wearer" })).toBe("");
    expect(buildIntentGuidancePrompt("group", { audience: "wearer" })).toBe("");
    expect(buildIntentGuidancePrompt(undefined, { audience: "wearer" })).toBe("");
  });

  it("gives the weather without riding advice", () => {
    const text = buildWearerWeatherPrompt("rider", "晴，18°C，微风。");
    expect(text).toContain("[实时天气] 用户当前位置晴，18°C，微风。");
    for (const word of RIDING_WORDS) expect(text, word).not.toContain(word);
    expect(buildWearerWeatherPrompt("configured", "晴。")).toContain("默认位置");
    expect(buildWearerWeatherPrompt("demo", "晴。")).toContain("演示位置");
  });

  it("names the wearer, not a rider, in the location rule", () => {
    const location = new RiderLocationContext(undefined);
    expect(location.role("wearer")).toContain("不是用户位置");
    expect(location.role("wearer")).not.toContain("骑手");
    expect(location.role()).toContain("不是骑手位置");
  });

  it("summarises nothing for an idle device", () => {
    expect(buildDeviceContextSummary({ mode: "ride", scenario: "commute" })).toBe("");
    expect(buildDeviceContextSummary({ mode: "emergency", scenario: "crash", speedKmh: 12 })).toBe(
      "紧急模式；估计移动速度：12 km/h"
    );
  });
});
