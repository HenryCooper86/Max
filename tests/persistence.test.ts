import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredTranscript,
  loadStoredTranscript,
  normalizeStoredSettings,
  saveStoredTranscript
} from "../src/lib/persistence";

function stubStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

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

describe("account-scoped transcript persistence", () => {
  const aliceId = "11111111-1111-4111-8111-111111111111";
  const bobId = "22222222-2222-4222-8222-222222222222";
  const turn = {
    id: 1,
    at: 10,
    speaker: "rider" as const,
    text: "private route",
    final: true,
    language: "en" as const
  };

  it("keeps different accounts in different storage records", () => {
    stubStorage();
    saveStoredTranscript(aliceId, [turn]);

    expect(loadStoredTranscript(aliceId)).toEqual([turn]);
    expect(loadStoredTranscript(bobId)).toEqual([]);
  });

  it("drops the ambiguous device-global v1 transcript instead of assigning it to a new login", () => {
    const values = stubStorage({ "max.transcript.v1": JSON.stringify([turn]) });

    expect(loadStoredTranscript(aliceId)).toEqual([]);
    expect(values.has("max.transcript.v1")).toBe(false);
  });

  it("clears only the selected account", () => {
    stubStorage();
    saveStoredTranscript(aliceId, [turn]);
    saveStoredTranscript(bobId, [{ ...turn, text: "bob route" }]);

    clearStoredTranscript(aliceId);

    expect(loadStoredTranscript(aliceId)).toEqual([]);
    expect(loadStoredTranscript(bobId)).toMatchObject([{ text: "bob route" }]);
  });
});
