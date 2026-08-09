import { describe, expect, it } from "vitest";
import { providerCapabilities } from "../shared/agent";
import { SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

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

  it("keeps the RDK device identity optional but canonical on session.start", () => {
    const base = { type: "session.start", sampleRate: 16000, channels: 1 };

    expect(parseClientEvent(Buffer.from(JSON.stringify(base)))).toMatchObject(base);
    expect(
      parseClientEvent(Buffer.from(JSON.stringify({ ...base, deviceId: "rdk-123e4567-e89b-42d3-a456-426614174000" })))
    ).toMatchObject({ ...base, deviceId: "rdk-123e4567-e89b-42d3-a456-426614174000" });
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ ...base, deviceId: "RDK-123E4567-E89B-42D3-A456-426614174000" })))
    ).toThrow("Invalid deviceId");
  });

  it("declares companion events on the agent server channel", () => {
    expect(SERVER_EVENT_TYPES).toEqual(
      expect.arrayContaining(["companion.pairing", "phone.location", "phone.location.status"])
    );
  });
});
