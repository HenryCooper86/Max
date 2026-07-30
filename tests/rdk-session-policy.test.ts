import { describe, expect, it } from "vitest";
import { decideReconnect, reconnectDecision } from "../rdk/agent/src/main";

describe("decideReconnect", () => {
  it("reconnects immediately after an unexpected drop", () => {
    expect(decideReconnect("dropped", false)).toBe("now");
  });

  it("waits for the rider's voice after an idle close", () => {
    expect(decideReconnect("idle", false)).toBe("wait-for-voice");
  });

  it("reconnects after an idle close once the gate opens", () => {
    expect(decideReconnect("idle", true)).toBe("now");
  });

  it("stays offline after an intentional shutdown", () => {
    expect(decideReconnect("intentional", true)).toBe("never");
  });
});

describe("reconnectDecision", () => {
  it("an idle close while the rider is speaking reconnects immediately", () => {
    expect(reconnectDecision(false, true, true)).toBe("now");
  });

  it("an idle close in silence waits for the voice gate", () => {
    expect(reconnectDecision(false, true, false)).toBe("wait-for-voice");
  });

  it("shutdown never reconnects, whatever the gate says", () => {
    expect(reconnectDecision(true, true, true)).toBe("never");
  });
});
