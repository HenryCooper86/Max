import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("generated protocol", () => {
  it("includes the crash events", () => {
    expect(CLIENT_EVENT_TYPES).toContain("crash.alert");
    expect(CLIENT_EVENT_TYPES).toContain("crash.cancel");
    expect(SERVER_EVENT_TYPES).toContain("crash.ack");
    expect(SERVER_EVENT_TYPES).toContain("crash.simulate");
  });
});

describe("parseClientEvent crash events", () => {
  it("accepts a minimal crash.alert", () => {
    const event = parseClientEvent(encode({ type: "crash.alert", incidentId: "i1", contactOptIn: false }));
    expect(event).toMatchObject({ type: "crash.alert", incidentId: "i1", contactOptIn: false });
  });

  it("accepts a full crash.alert", () => {
    const event = parseClientEvent(
      encode({
        type: "crash.alert",
        incidentId: "i2",
        lat: 31.23,
        lon: 121.47,
        speedKmhRecent: 42,
        contactNumber: "+8613800000000",
        contactOptIn: true,
        detectedAt: 1754200000000
      })
    );
    expect(event).toMatchObject({ type: "crash.alert", lat: 31.23, contactNumber: "+8613800000000" });
  });

  it("rejects crash.alert without an incidentId", () => {
    expect(() => parseClientEvent(encode({ type: "crash.alert", contactOptIn: true }))).toThrow(/incidentId/);
    expect(() => parseClientEvent(encode({ type: "crash.alert", incidentId: "", contactOptIn: true }))).toThrow(/incidentId/);
  });

  it("rejects crash.alert without contactOptIn or with bad field types", () => {
    expect(() => parseClientEvent(encode({ type: "crash.alert", incidentId: "i3" }))).toThrow(/contactOptIn/);
    expect(() => parseClientEvent(encode({ type: "crash.alert", incidentId: "i3", contactOptIn: true, lat: "north" }))).toThrow(/lat/);
  });

  it("accepts crash.cancel and rejects one without an incidentId", () => {
    expect(parseClientEvent(encode({ type: "crash.cancel", incidentId: "i4" }))).toMatchObject({ type: "crash.cancel" });
    expect(() => parseClientEvent(encode({ type: "crash.cancel" }))).toThrow(/incidentId/);
  });
});
