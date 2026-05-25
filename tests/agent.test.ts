import { describe, expect, it } from "vitest";
import { providerCapabilities } from "../shared/agent";

describe("agent contracts", () => {
  it("declares Doubao realtime capabilities", () => {
    const capabilities = providerCapabilities("doubao");

    expect(capabilities.serverVad).toBe(true);
    expect(capabilities.synthesizedAudio).toBe(true);
    expect(capabilities.weatherContext).toBe(true);
    expect(capabilities.emergencyMode).toBe(true);
  });

  it("declares mock as transcript-capable without provider PCM audio", () => {
    const capabilities = providerCapabilities("mock");

    expect(capabilities.transcriptEvents).toBe(true);
    expect(capabilities.synthesizedAudio).toBe(false);
    expect(capabilities.sessionMemory).toBe(true);
  });
});
