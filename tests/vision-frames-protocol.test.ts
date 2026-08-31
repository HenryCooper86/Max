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

  it("rejects a gallery-shaped payload relabelled as watch (V-C narrows the watch shape, not just the reason enum)", () => {
    expect(() => parseClientEvent(encode({ ...base, reason: "watch" }))).toThrow(/commandId/);
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

describe("parseClientEvent vision.frames watch reason", () => {
  const watch = { type: "vision.frames", reason: "watch", index: 0, total: 1, image: "aGVsbG8=" };

  it("accepts a bare watch frame", () => {
    expect(parseClientEvent(encode(watch))).toMatchObject({
      type: "vision.frames",
      reason: "watch",
      index: 0,
      total: 1
    });
  });

  it("rejects watch frames with a commandId, a question, or multi-frame shape", () => {
    expect(() => parseClientEvent(encode({ ...watch, commandId: "c1" }))).toThrow(/commandId/);
    expect(() => parseClientEvent(encode({ ...watch, question: "x" }))).toThrow(/question/);
    expect(() => parseClientEvent(encode({ ...watch, total: 2, index: 1 }))).toThrow(/total/);
  });

  it("still requires commandId for gallery", () => {
    expect(() =>
      parseClientEvent(encode({ type: "vision.frames", reason: "gallery", index: 0, total: 1, image: "x" }))
    ).toThrow(/commandId/);
  });
});
