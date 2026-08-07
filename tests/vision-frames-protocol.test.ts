import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const base = { type: "vision.frames", commandId: "c1", reason: "gallery", index: 0, total: 2, image: "aGVsbG8=" };

describe("generated protocol", () => {
  it("includes vision.frames and the synced device actions", () => {
    expect(CLIENT_EVENT_TYPES).toContain("vision.frames");
  });
});

describe("parseClientEvent vision.frames", () => {
  it("accepts a frame chunk with and without a question", () => {
    expect(parseClientEvent(encode(base))).toMatchObject({
      type: "vision.frames",
      commandId: "c1",
      index: 0,
      total: 2
    });
    const withQuestion = parseClientEvent(encode({ ...base, question: "有什么" }));
    expect(withQuestion).toMatchObject({ question: "有什么" });
  });

  it("rejects a watch reason until V-C", () => {
    expect(() => parseClientEvent(encode({ ...base, reason: "watch" }))).toThrow(/reason/);
  });

  it("rejects out-of-range index/total", () => {
    expect(() => parseClientEvent(encode({ ...base, total: 9, index: 8 }))).toThrow(/total/);
    expect(() => parseClientEvent(encode({ ...base, index: 2 }))).toThrow(/index/);
    expect(() => parseClientEvent(encode({ ...base, index: 0.5 }))).toThrow(/index/);
    expect(() => parseClientEvent(encode({ ...base, total: 0, index: 0 }))).toThrow(/total/);
  });

  it("rejects an oversized or empty image and an oversized question", () => {
    expect(() => parseClientEvent(encode({ ...base, image: "" }))).toThrow(/image/);
    expect(() => parseClientEvent(encode({ ...base, image: "x".repeat(200_001) }))).toThrow(/image/);
    expect(() => parseClientEvent(encode({ ...base, question: "问".repeat(200) }))).toThrow(/question/);
  });

  it("returns an allowlisted reconstruction, not the raw blob", () => {
    const event = parseClientEvent(encode({ ...base, extra: "smuggled" })) as Record<string, unknown>;
    expect(event).not.toHaveProperty("extra");
  });
});
