import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configFileText,
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  envFileText,
  loadBuildDraft,
  sameConfig,
  saveBuildDraft,
  validateDraft
} from "../src/lib/assistant-config";

const FULL = {
  name: "Iris",
  device: "assistive-glasses",
  languages: ["en", "zh"],
  strictLanguages: true,
  developer: "Northlight Labs",
  tagline: "Eyes-free help",
  wake: { names: ["Hey Iris", "艾瑞斯"], falseFriends: ["iris scan"] },
  template: "beacon",
  templateSwitching: false,
  visualizer: "mirror",
  accentColor: "#FFE500",
  theme: { "radius-card": "4px" },
  voice: { equalizer: { bands: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1], preamp: -2 } },
  persona: "Calm and brief.",
  wearer: { zh: "用户", en: "wearer" }
};

describe("assistant config model", () => {
  it("round-trips a full config, keeping fields the editor does not edit", () => {
    expect(configFromDraft(draftFromConfig(FULL))).toEqual(FULL);
  });

  it("round-trips a minimal config without inventing defaults", () => {
    const minimal = { name: "Max", device: "motorcycle-helmet", languages: ["zh", "en"] };
    expect(configFromDraft(draftFromConfig(minimal))).toEqual(minimal);
  });

  it("reads a coarse device family and the legacy top-level equaliser", () => {
    const draft = draftFromConfig({ name: "A", device: "glasses", equalizer: { preset: "clarity" } });
    expect(draft.device).toBe("smart-glasses");
    expect(configFromDraft(draft)).toMatchObject({ voice: { equalizer: { preset: "clarity" } } });
    expect(configFromDraft(draft)).not.toHaveProperty("equalizer");
  });

  it("drops values the relay would ignore and the wake name equal to the name", () => {
    const draft = draftFromConfig({
      name: "Iris",
      accentColor: "lime",
      visualizer: "laser",
      wake: { names: ["iris", "Hey Iris"] },
      voice: { equalizer: { bass: 4 } }
    });
    expect(draft).toMatchObject({ accentColor: "", visualizer: null, wakeNames: ["Hey Iris"], equalizer: null });
  });

  it("treats a relay on defaults ({}) as an empty draft", () => {
    expect(draftFromConfig({}, "en-US")).toEqual(emptyDraft("en-US"));
  });

  it("compares drafts by the config they would save", () => {
    const a = draftFromConfig(FULL);
    expect(sameConfig(a, { ...a, wakeNames: [...a.wakeNames, ""] })).toBe(true);
    expect(sameConfig(a, { ...a, name: "Iris 2" })).toBe(false);
  });
});

describe("validation", () => {
  const valid = draftFromConfig(FULL);

  it("accepts a well-formed draft", () => {
    expect(validateDraft(valid)).toEqual({});
  });

  it("requires a name of at most 24 characters", () => {
    expect(validateDraft({ ...valid, name: "  " })).toHaveProperty("name");
    expect(validateDraft({ ...valid, name: "x".repeat(25) })).toHaveProperty("name");
  });

  it("wants a #RRGGBB accent or none", () => {
    expect(validateDraft({ ...valid, accentColor: "#12" })).toHaveProperty("accentColor");
    expect(validateDraft({ ...valid, accentColor: "" })).not.toHaveProperty("accentColor");
  });

  it("wants ten whole-dB bands and a preamp within -12…12", () => {
    expect(validateDraft({ ...valid, equalizer: { bands: [0, 0, 0], preamp: 0 } })).toHaveProperty("equalizer");
    expect(validateDraft({ ...valid, equalizer: { bands: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0] } })).toHaveProperty(
      "equalizer"
    );
    expect(validateDraft({ ...valid, equalizer: { bands: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] } })).toHaveProperty(
      "equalizer"
    );
    expect(validateDraft({ ...valid, equalizer: { preset: "wind", preamp: 20 } })).toHaveProperty("equalizer");
    expect(validateDraft({ ...valid, equalizer: { preset: "wind" } })).not.toHaveProperty("equalizer");
  });

  it("needs at least one plausible language and sane wake names", () => {
    expect(validateDraft({ ...valid, languages: [] })).toHaveProperty("languages");
    expect(validateDraft({ ...valid, languages: ["english!"] })).toHaveProperty("languages");
    expect(validateDraft({ ...valid, wakeNames: ["x".repeat(30)] })).toHaveProperty("wakeNames");
  });

  it("speaks the UI language", () => {
    expect(validateDraft({ ...valid, name: "" }, "zh-CN").name).toContain("名字");
  });
});

describe("configurator output", () => {
  it("writes the config the relay reads, in a stable order", () => {
    const draft = {
      ...emptyDraft("en-US"),
      name: "Iris",
      device: "sunglasses",
      wakeNames: ["Hey Iris", ""],
      template: "ember",
      visualizer: "dots" as const,
      accentColor: "#ff7a1a",
      equalizer: { preset: "outdoor" }
    };
    const text = configFileText(draft);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      name: "Iris",
      device: "sunglasses",
      languages: ["en"],
      wake: { names: ["Hey Iris"] },
      template: "ember",
      visualizer: "dots",
      accentColor: "#FF7A1A",
      voice: { equalizer: { preset: "outdoor" } }
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "name",
      "device",
      "languages",
      "wake",
      "template",
      "visualizer",
      "accentColor",
      "voice"
    ]);
  });

  it("lists the .env lines for the backend with every value blank", () => {
    const base = emptyDraft("en-US");
    expect(envFileText({ ...base, voiceProvider: "openai" })).toBe("VOICE_PROVIDER=openai\nOPENAI_API_KEY=\n");
    expect(envFileText({ ...base, voiceProvider: "local" })).toBe("VOICE_PROVIDER=local\nLOCAL_VOICE=on\n");
    expect(envFileText({ ...base, voiceProvider: "mock" })).toBe("VOICE_PROVIDER=mock\n");
    expect(envFileText({ ...base, voiceProvider: "nonsense" })).toBe("VOICE_PROVIDER=mock\n");
  });
});

describe("configurator draft in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("survives a refresh, half-typed fields included", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      }
    });
    const draft = {
      ...emptyDraft("en-US"),
      name: "Ir",
      wakeNames: ["Hey Ir"],
      voiceProvider: "gemini",
      device: "vr-headset"
    };
    saveBuildDraft({ draft, step: 3 });
    const restored = loadBuildDraft("en-US")!;
    expect(restored.step).toBe(3);
    expect(restored.draft).toMatchObject({
      name: "Ir",
      wakeNames: ["Hey Ir"],
      voiceProvider: "gemini",
      device: "vr-headset"
    });
    values.set("max.build.draft.v1", "{not json");
    expect(loadBuildDraft("en-US")).toBeNull();
  });
});
