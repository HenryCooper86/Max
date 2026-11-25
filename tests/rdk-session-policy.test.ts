import { describe, expect, it } from "vitest";
import type { RelayClose } from "../rdk/agent/src/relay";
import { decideReconnect, reconnectDecision, terminalCloseDiagnosis } from "../rdk/agent/src/main";

const DROPPED: RelayClose = { kind: "dropped", reason: "" };
const IDLE: RelayClose = { kind: "idle", reason: "idle timeout" };
const INTENTIONAL: RelayClose = { kind: "intentional", reason: "" };
const USAGE_LIMIT: RelayClose = { kind: "usage-limit", reason: "usage limit reached" };
const CREDENTIALS: RelayClose = { kind: "credentials", reason: "signed out" };

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

  it("never reconnects after a close the relay would repeat, gate or no gate", () => {
    // 4003: nothing on this board brings the minutes back. 1008: this board
    // cannot fetch a fresh token, so the same one would be refused again.
    expect(decideReconnect("usage-limit", false)).toBe("never");
    expect(decideReconnect("usage-limit", true)).toBe("never");
    expect(decideReconnect("credentials", false)).toBe("never");
    expect(decideReconnect("credentials", true)).toBe("never");
  });
});

describe("reconnectDecision", () => {
  it("an idle close while the rider is speaking reconnects immediately", () => {
    expect(reconnectDecision(false, IDLE, true)).toBe("now");
  });

  it("an idle close in silence waits for the voice gate", () => {
    expect(reconnectDecision(false, IDLE, false)).toBe("wait-for-voice");
  });

  it("shutdown never reconnects, whatever the gate says", () => {
    expect(reconnectDecision(true, IDLE, true)).toBe("never");
  });

  it("an unexpected drop reconnects, and a refusal does not reach the gate", () => {
    expect(reconnectDecision(false, DROPPED, false)).toBe("now");
    expect(reconnectDecision(false, USAGE_LIMIT, true)).toBe("never");
    expect(reconnectDecision(false, CREDENTIALS, true)).toBe("never");
  });
});

describe("terminalCloseDiagnosis", () => {
  it("names what used up the allowance, quoting the relay, and how to come back", () => {
    expect(terminalCloseDiagnosis(USAGE_LIMIT)).toBe(
      "voice minutes used up (usage limit reached); the relay refuses every new session until the allowance resets or the balance or limit is raised; the agent is not reconnecting: restart max-agent once it has"
    );
  });

  it("quotes the relay's reason when it refused this device, instead of guessing at the token", () => {
    // 1008 covers a signed-out or expired session, a deleted account, a
    // rotated or reused key, a project that is not ready (docs/protocol.md).
    // Only the relay knows which, so its reason is the cause of the line.
    expect(terminalCloseDiagnosis(CREDENTIALS)).toBe(
      "the relay refused this device's credentials: signed out; the same ones would be refused again, so the agent is not retrying; sort out what the reason names, then restart max-agent; this board's own credential is MAX_RELAY_TOKEN in /etc/max/agent.env"
    );
    expect(terminalCloseDiagnosis({ kind: "credentials", reason: "project not ready" })).toContain(
      "the relay refused this device's credentials: project not ready"
    );
  });

  it("says when the relay closed without giving a reason", () => {
    expect(terminalCloseDiagnosis({ kind: "credentials", reason: "" })).toContain(
      "the relay refused this device's credentials without giving a reason"
    );
    expect(terminalCloseDiagnosis({ kind: "usage-limit", reason: "" })).toMatch(/^voice minutes used up;/);
  });

  it("says nothing for closes the agent recovers from by itself", () => {
    expect(terminalCloseDiagnosis(DROPPED)).toBeUndefined();
    expect(terminalCloseDiagnosis(IDLE)).toBeUndefined();
    expect(terminalCloseDiagnosis(INTENTIONAL)).toBeUndefined();
  });
});
