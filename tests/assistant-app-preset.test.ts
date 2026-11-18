import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantProfileFrom,
  basePersonaPrompt,
  setAssistantProfileForTests,
  wakeWordActive
} from "../server/assistant";

afterEach(() => setAssistantProfileForTests());

describe("app device preset", () => {
  it("is a general-purpose preset with the wake word off by default", () => {
    const profile = assistantProfileFrom({ name: "Nova", device: "app" });
    expect(profile.preset.id).toBe("app");
    expect(profile.preset.general).toBe(true);
    expect(profile.wakeWord).toBe(false);
  });

  it("accepts the aliases for the app preset", () => {
    for (const device of ["web", "website", "software", "kiosk"]) {
      expect(assistantProfileFrom({ name: "Nova", device }).preset.id, device).toBe("app");
    }
  });

  it("respects an explicit wakeWord setting either way", () => {
    expect(assistantProfileFrom({ name: "Nova", device: "app", wakeWord: true }).wakeWord).toBe(true);
    expect(assistantProfileFrom({ name: "Nova", device: "helmet" }).wakeWord).toBe(true);
    expect(assistantProfileFrom({ name: "Nova", device: "helmet", wakeWord: false }).wakeWord).toBe(false);
  });

  it("parses instructions and greeting", () => {
    const profile = assistantProfileFrom({
      name: "Nova",
      device: "app",
      instructions: "  Always mention the free plan. ",
      greeting: " Hi, I'm Nova. "
    });
    expect(profile.instructions).toBe("Always mention the free plan.");
    expect(profile.greeting).toBe("Hi, I'm Nova.");
    expect(assistantProfileFrom({ name: "Nova", device: "app" })).toMatchObject({
      instructions: undefined,
      greeting: undefined
    });
  });

  it("resolves toolsModule relative to the config directory and keeps raw tools", () => {
    const tools = [{ name: "a", description: "d", url: "https://x.example/a" }];
    const profile = assistantProfileFrom(
      { name: "Nova", device: "app", toolsModule: "./agent-tools.ts", tools },
      "/srv/agent"
    );
    expect(profile.tools).toEqual({ tools, modulePath: path.resolve("/srv/agent", "agent-tools.ts") });
    expect(assistantProfileFrom({ name: "Nova", device: "app" }).tools).toEqual({});
    expect(
      assistantProfileFrom({ name: "Nova", device: "app", toolsModule: "../up.ts" }, "/srv/agent").tools.modulePath
    ).toBe("/srv/up.ts");
  });

  it("writes a general persona with no riding or hands-free wording", () => {
    const persona = basePersonaPrompt(assistantProfileFrom({ name: "Nova", device: "app", languages: ["en"] }));
    expect(persona).toContain("You are Nova");
    expect(persona).toContain("voice assistant");
    expect(persona).toContain("the user");
    expect(persona).not.toMatch(/hands-free|torch|rider|helmet|motorcycle|navigation|ride/i);
    expect(persona).not.toMatch(/\p{Script=Han}/u);
  });

  it("does not use the legacy Max persona for a bare app config", () => {
    const persona = basePersonaPrompt(assistantProfileFrom({ name: "Nova", device: "app", languages: ["en"] }));
    expect(persona).not.toContain("Max");
  });

  it("wakeWordActive is false for an app profile even when the relay allows the wake word", () => {
    const profile = assistantProfileFrom({ name: "Nova", device: "app" });
    expect(wakeWordActive(false, profile)).toBe(false);
    expect(wakeWordActive(true, profile)).toBe(false);
    expect(wakeWordActive(true, assistantProfileFrom({ name: "Nova", device: "app", wakeWord: true }))).toBe(true);
    expect(wakeWordActive(false, assistantProfileFrom({ name: "Nova", device: "app", wakeWord: true }))).toBe(false);
  });
});
