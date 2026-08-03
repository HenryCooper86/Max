import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES, SERVER_EVENT_TYPES } from "../shared/generated/agent-protocol";

describe("generated protocol", () => {
  it("includes the crash events", () => {
    expect(CLIENT_EVENT_TYPES).toContain("crash.alert");
    expect(CLIENT_EVENT_TYPES).toContain("crash.cancel");
    expect(SERVER_EVENT_TYPES).toContain("crash.ack");
    expect(SERVER_EVENT_TYPES).toContain("crash.simulate");
  });
});
