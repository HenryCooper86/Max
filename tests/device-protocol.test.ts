import { describe, expect, it } from "vitest";
import { parseClientEvent } from "../server/session-controller";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("generated protocol", () => {
  it("includes the device events", () => {
    expect(SERVER_EVENT_TYPES).toContain("device.command");
    expect(CLIENT_EVENT_TYPES).toContain("device.result");
  });
});

describe("parseClientEvent — device.result", () => {
  it("accepts a minimal ok result", () => {
    expect(parseClientEvent(encode({ type: "device.result", commandId: "c1", status: "ok" }))).toEqual({
      type: "device.result",
      commandId: "c1",
      status: "ok",
      reason: undefined,
      detail: undefined
    });
  });

  it("accepts a failure with reason and detail", () => {
    expect(
      parseClientEvent(
        encode({ type: "device.result", commandId: "c2", status: "denied", reason: "unsafe.speed", detail: "骑行中" })
      )
    ).toEqual({
      type: "device.result",
      commandId: "c2",
      status: "denied",
      reason: "unsafe.speed",
      detail: "骑行中"
    });
  });

  it("rejects an unknown status", () => {
    expect(() => parseClientEvent(encode({ type: "device.result", commandId: "c3", status: "maybe" }))).toThrow(
      "Invalid device.result status"
    );
  });

  it("rejects a missing or oversized commandId", () => {
    expect(() => parseClientEvent(encode({ type: "device.result", status: "ok" }))).toThrow(
      "Invalid device.result commandId"
    );
    expect(() => parseClientEvent(encode({ type: "device.result", commandId: "x".repeat(121), status: "ok" }))).toThrow(
      "Invalid device.result commandId"
    );
  });

  it("rejects an oversized detail", () => {
    expect(() =>
      parseClientEvent(encode({ type: "device.result", commandId: "c4", status: "failed", detail: "x".repeat(501) }))
    ).toThrow("Invalid device.result detail");
  });
});
