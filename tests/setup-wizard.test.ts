import { describe, expect, it } from "vitest";
import { mergeEnv } from "../scripts/setup";

describe("setup wizard env merge", () => {
  it("replaces managed keys in place and leaves everything else untouched", () => {
    const before = "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=mock\n# OPENAI_API_KEY=\n\n";
    expect(mergeEnv(before, { VOICE_PROVIDER: "grok", XAI_API_KEY: "k" })).toBe(
      "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=grok\n# OPENAI_API_KEY=\nXAI_API_KEY=k\n"
    );
  });

  it("creates a file from nothing", () => {
    expect(mergeEnv("", { VOICE_PROVIDER: "openai" })).toBe("VOICE_PROVIDER=openai\n");
  });
});
