import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const origin = { lat: 31.2304, lon: 121.4737 };

describe("generated protocol", () => {
  it("includes the nav events", () => {
    expect(CLIENT_EVENT_TYPES).toContain("nav.request");
    expect(SERVER_EVENT_TYPES).toContain("nav.route");
    expect(SERVER_EVENT_TYPES).toContain("nav.error");
  });
});

describe("parseClientEvent nav.request", () => {
  it("accepts a start request", () => {
    const event = parseClientEvent(
      encode({ type: "nav.request", commandId: "c1", reason: "start", origin, query: "人民广场" })
    );
    expect(event).toMatchObject({ type: "nav.request", commandId: "c1", reason: "start", query: "人民广场" });
  });

  it("accepts a reroute request with destination", () => {
    const event = parseClientEvent(
      encode({
        type: "nav.request",
        commandId: "c2",
        reason: "reroute",
        origin,
        destination: { lat: 31.24, lon: 121.49 },
        destinationName: "人民广场"
      })
    );
    expect(event).toMatchObject({ type: "nav.request", reason: "reroute", destinationName: "人民广场" });
  });

  it("rejects a start request without a query", () => {
    expect(() => parseClientEvent(encode({ type: "nav.request", commandId: "c3", reason: "start", origin }))).toThrow(
      /query/
    );
  });

  it("rejects a reroute request without a destination", () => {
    expect(() => parseClientEvent(encode({ type: "nav.request", commandId: "c4", reason: "reroute", origin }))).toThrow(
      /destination/
    );
  });

  it("rejects an out-of-range origin", () => {
    expect(() =>
      parseClientEvent(
        encode({ type: "nav.request", commandId: "c5", reason: "start", origin: { lat: 91, lon: 0 }, query: "x" })
      )
    ).toThrow(/lat/);
  });

  it("rejects an oversized query", () => {
    expect(() =>
      parseClientEvent(
        encode({ type: "nav.request", commandId: "c6", reason: "start", origin, query: "深".repeat(200) })
      )
    ).toThrow(/query/);
  });
});
