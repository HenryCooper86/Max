import { describe, expect, it } from "vitest";
import {
  buildIntentGuidancePrompt,
  buildPersonalityPrompt,
  buildSafetyPrompt,
  buildSessionMemoryPrompt,
  createSessionMemory,
  inferIntent,
  responseModeForRide,
  restoreSessionMemory,
  updateSessionMemory
} from "../shared/session";

describe("session memory and safety policy", () => {
  it("detects emergency intent and escalates response mode", () => {
    expect(inferIntent("I crashed and need help")).toBe("emergency");
    expect(responseModeForRide("ride", "emergency")).toBe("emergency");
  });

  it("detects common crash phrasings as emergencies", () => {
    expect(inferIntent("我摔倒了")).toBe("emergency");
    expect(inferIntent("我出车祸了")).toBe("emergency");
    expect(inferIntent("受了伤，需要帮忙")).toBe("emergency");
    expect(inferIntent("quick, I fell and I'm hurt")).toBe("emergency");
  });

  it("does not match intent keywords inside unrelated words", () => {
    // "rain" in "train", "tire" in "tired", "eta" in "details", "wind" in
    // "window", 风 in 麦克风 — all previously misclassified.
    expect(inferIntent("route to the train station")).toBe("navigation");
    expect(inferIntent("I'm tired, let's stop soon")).toBe("casual");
    expect(inferIntent("give me the details")).toBe("casual");
    expect(inferIntent("close the helmet window vents")).toBe("casual");
    expect(inferIntent("麦克风好像坏了")).toBe("casual");
  });

  it("keeps riding and navigation responses concise", () => {
    expect(responseModeForRide("ride", "casual")).toBe("concise");
    expect(responseModeForRide("navigation", "weather")).toBe("concise");
    expect(responseModeForRide("stop", "weather")).toBe("normal");
  });

  it("updates language, intent, destination, and response mode from rider text", () => {
    const memory = updateSessionMemory(createSessionMemory("navigation"), "帮我回家，前面堵吗？", "navigation");

    expect(memory.language).toBe("zh");
    expect(memory.lastIntent).toBe("navigation");
    expect(memory.destination).toBe("家");
    expect(memory.responseMode).toBe("concise");
  });

  it("does not capture Chinese verb complements as destinations", () => {
    // 到/回 appear in everyday verbs (听到 "heard", 迟到 "was late") — only
    // navigation-shaped turns may set a destination.
    expect(updateSessionMemory(createSessionMemory("ride"), "我听到异响了", "ride").destination).toBeUndefined();
    expect(updateSessionMemory(createSessionMemory("ride"), "刚才迟到了十分钟", "ride").destination).toBeUndefined();
    // Fullwidth punctuation ends the capture.
    expect(updateSessionMemory(createSessionMemory("navigation"), "带我回家！", "navigation").destination).toBe("家");
  });

  it("keeps the previous destination when a non-navigation turn follows", () => {
    const withDestination = updateSessionMemory(createSessionMemory("navigation"), "导航回家", "navigation");
    expect(withDestination.destination).toBe("家");
    const afterCasual = updateSessionMemory(withDestination, "今天有点累", "navigation");
    expect(afterCasual.destination).toBe("家");
  });

  it("caps an English destination at the place name, not the trailing clause", () => {
    expect(
      updateSessionMemory(createSessionMemory("navigation"), "navigate to busan station right now please", "navigation")
        .destination
    ).toBe("busan station");
  });

  it("infers an English destination only from destination-bearing phrases", () => {
    // A bare infinitive must not be mistaken for a destination.
    expect(updateSessionMemory(createSessionMemory("ride"), "I want to ride fast", "ride").destination).toBeUndefined();
    // A real navigation phrase still captures the place.
    expect(
      updateSessionMemory(createSessionMemory("navigation"), "navigate to busan station", "navigation").destination
    ).toBe("busan station");
  });

  it("maps each personality to its own prompt fragment", () => {
    expect(buildPersonalityPrompt("concise")).toContain("极简");
    expect(buildPersonalityPrompt("friendly")).toContain("友好");
    expect(buildPersonalityPrompt("technical")).toContain("技术型");
    expect(buildPersonalityPrompt("rally")).toContain("领航员");
  });

  it("gives intent-specific guidance and falls back to the language rule", () => {
    expect(buildIntentGuidancePrompt("navigation")).toContain("导航");
    expect(buildIntentGuidancePrompt("emergency")).toContain("紧急");
    expect(buildIntentGuidancePrompt("diagnostics")).toContain("诊断");
    // Undefined intent → the generic language-rule fallback.
    expect(buildIntentGuidancePrompt(undefined)).toContain("语言规则");
  });

  it("adds the high-speed policy and telemetry above 60 km/h", () => {
    const memory = createSessionMemory("ride");
    const prompt = buildSafetyPrompt(
      { mode: "ride", scenario: "commute", speedKmh: 72, routePhase: "highway", network: "online", batteryPct: 64 },
      memory
    );
    expect(prompt).toContain("高速");
    expect(prompt).toContain("72");
    expect(prompt).toContain("highway");
    expect(prompt).toContain("64%");
  });

  it("restores a client memory snapshot across a session restart", () => {
    const memory = restoreSessionMemory(
      { language: "en", destination: "  busan station  ", lastIntent: "navigation" },
      "navigation"
    );

    expect(memory.language).toBe("en");
    expect(memory.destination).toBe("busan station");
    expect(memory.lastIntent).toBe("navigation");
    // responseMode is re-derived from the current mode + intent, not restored.
    expect(memory.responseMode).toBe("concise");
  });

  it("does not let a stale emergency intent pin emergency verbosity after restart", () => {
    // The rider said 报警 hours ago, then toggled a setting while parked: the
    // restored snapshot must not resurrect emergency command-style replies.
    const memory = restoreSessionMemory({ language: "zh", lastIntent: "emergency" }, "stop");
    expect(memory.lastIntent).toBe("emergency");
    expect(memory.responseMode).toBe("normal");
    // A genuinely ongoing emergency is carried by the current ride mode.
    expect(restoreSessionMemory({ lastIntent: "emergency" }, "emergency").responseMode).toBe("emergency");
  });

  it("falls back to fresh memory for missing or invalid snapshots", () => {
    expect(restoreSessionMemory(undefined, "ride")).toEqual(createSessionMemory("ride"));

    const sanitized = restoreSessionMemory(
      { language: "fr", destination: "x".repeat(200), lastIntent: "hack-the-planet" },
      "ride"
    );
    expect(sanitized.language).toBe("zh");
    expect(sanitized.destination).toHaveLength(64);
    expect(sanitized.lastIntent).toBeUndefined();
  });

  it("builds compact prompt fragments for Doubao", () => {
    const memory = {
      ...createSessionMemory("emergency"),
      lastIntent: "emergency" as const,
      destination: "医院"
    };
    const memoryPrompt = buildSessionMemoryPrompt(memory);
    const safetyPrompt = buildSafetyPrompt({ mode: "emergency", scenario: "emergency", speedKmh: 18 }, memory);

    expect(memoryPrompt).toContain("医院");
    expect(safetyPrompt).toContain("紧急模式");
    expect(safetyPrompt).toContain("18");
  });
});
