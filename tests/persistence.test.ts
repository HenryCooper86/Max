import { describe, expect, it } from "vitest";
import { normalizeStoredSettings } from "../src/lib/persistence";

describe("stored HUD settings", () => {
  it("keeps supported voice settings", () => {
    expect(normalizeStoredSettings({ voiceGender: "male", voicePersonality: "rally", testerId: " qa rider " })).toEqual(
      {
        voiceGender: "male",
        voicePersonality: "rally",
        testerId: "qa rider"
      }
    );
  });

  it("drops malformed or unsupported persisted values", () => {
    expect(normalizeStoredSettings(null)).toEqual({});
    expect(normalizeStoredSettings({ voiceGender: "robot", voicePersonality: "verbose" })).toEqual({});
    expect(normalizeStoredSettings({ voiceGender: "female", voicePersonality: 42 })).toEqual({
      voiceGender: "female"
    });
    expect(normalizeStoredSettings({ testerId: "\u0000".repeat(4) })).toEqual({});
  });
});
