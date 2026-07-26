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

describe("parseClientEvent — hazard.report", () => {
  it("is a client event, so real alerts can reach the transcript", () => {
    expect(CLIENT_EVENT_TYPES).toContain("hazard.report");
  });

  it("accepts a report from the board", () => {
    const event = parseClientEvent(
      encode({
        type: "hazard.report",
        threat: "forward_collision",
        direction: "front",
        severity: "critical",
        label: "前车急刹",
        message: "前车急刹，注意保持车距！",
        advice: "立即收油，平稳减速。",
        ttcSeconds: 1.4,
        latencyMs: 180
      })
    );
    expect(event).toMatchObject({
      type: "hazard.report",
      threat: "forward_collision",
      severity: "critical",
      ttcSeconds: 1.4,
      latencyMs: 180
    });
  });

  it("accepts a shadow-era report with no measured latency", () => {
    const event = parseClientEvent(
      encode({
        type: "hazard.report",
        threat: "tailgating",
        direction: "rear",
        severity: "caution",
        label: "后车跟车过近",
        message: "后车跟车过近，注意保持车距。",
        advice: "保持匀速，不要急刹。"
      })
    );
    expect(event).toMatchObject({ type: "hazard.report", threat: "tailgating" });
  });

  it("rejects a report with no threat", () => {
    expect(() =>
      parseClientEvent(
        encode({
          type: "hazard.report",
          direction: "front",
          severity: "critical",
          label: "x",
          message: "y",
          advice: "z"
        })
      )
    ).toThrow(/threat/);
  });

  it("rejects an unknown severity rather than passing it through", () => {
    // The transcript and QA record key off severity; an unrecognised value
    // would render as neither caution nor critical.
    expect(() =>
      parseClientEvent(
        encode({
          type: "hazard.report",
          threat: "forward_collision",
          direction: "front",
          severity: "catastrophic",
          label: "x",
          message: "y",
          advice: "z"
        })
      )
    ).toThrow(/severity/);
  });
});
