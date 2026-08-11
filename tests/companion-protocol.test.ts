import { describe, expect, it } from "vitest";
import { parseCompanionClientEvent } from "../shared/companion";

describe("parseCompanionClientEvent", () => {
  it("parses every companion control event", () => {
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.pair", code: "S8NM5R" }))).toEqual({
      type: "companion.pair",
      code: "S8NM5R"
    });
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.start" }))).toEqual({ type: "companion.start" });
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.stop" }))).toEqual({ type: "companion.stop" });
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.unpair" }))).toEqual({
      type: "companion.unpair"
    });
  });

  it("parses a bounded companion fix", () => {
    expect(
      parseCompanionClientEvent(
        JSON.stringify({
          type: "companion.location",
          sequence: 7,
          lat: 31.2304,
          lon: 121.4737,
          horizontalAccuracyMeters: 8,
          timestamp: 1_786_200_000_000,
          courseDegrees: 90,
          speedMps: 12
        })
      )
    ).toMatchObject({ type: "companion.location", sequence: 7 });
  });

  it("rejects binary and unknown companion input", () => {
    expect(() => parseCompanionClientEvent(Buffer.from([0, 1, 2]))).toThrow();
    expect(() => parseCompanionClientEvent(JSON.stringify({ type: "companion.debug" }))).toThrow(
      "Unsupported companion client event companion.debug"
    );
  });

  it("rejects overlong pairing codes", () => {
    expect(() => parseCompanionClientEvent(JSON.stringify({ type: "companion.pair", code: "码".repeat(41) }))).toThrow(
      "Invalid companion.pair code"
    );
  });

  it("rejects invalid companion fixes", () => {
    const fix = {
      type: "companion.location",
      sequence: 7,
      lat: 31.2304,
      lon: 121.4737,
      horizontalAccuracyMeters: 8,
      timestamp: 1_786_200_000_000,
      courseDegrees: 90,
      speedMps: 12
    };

    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, lat: 91 }))).toThrow(
      "Invalid companion.location lat"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, lon: -181 }))).toThrow(
      "Invalid companion.location lon"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, horizontalAccuracyMeters: -1 }))).toThrow(
      "Invalid companion.location horizontalAccuracyMeters"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, speedMps: -1 }))).toThrow(
      "Invalid companion.location speedMps"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, courseDegrees: 361 }))).toThrow(
      "Invalid companion.location courseDegrees"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, sequence: 1.5 }))).toThrow(
      "Invalid companion.location sequence"
    );
    expect(() => parseCompanionClientEvent(JSON.stringify({ ...fix, sequence: 0 }))).toThrow(
      "Invalid companion.location sequence"
    );
  });
});

describe("companion.pairDiscover parsing", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  it("accepts a canonical 32-hex token", () => {
    expect(parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token: TOKEN }))).toEqual({
      type: "companion.pairDiscover",
      token: TOKEN
    });
  });

  it.each([
    ["uppercase", "0123456789ABCDEF0123456789ABCDEF"],
    ["short", "0123456789abcdef"],
    ["long", `${"0123456789abcdef".repeat(2)}00`],
    ["non-hex", "zz23456789abcdef0123456789abcdef"],
    ["empty", ""]
  ])("rejects a %s token", (_label, token) => {
    expect(() => parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token }))).toThrow(
      /pairDiscover/
    );
  });

  it("rejects extra fields", () => {
    expect(() =>
      parseCompanionClientEvent(JSON.stringify({ type: "companion.pairDiscover", token: TOKEN, extra: 1 }))
    ).toThrow(/pairDiscover/);
  });
});
