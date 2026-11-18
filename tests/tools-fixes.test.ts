import { describe, expect, it } from "vitest";
import { createToolBroker } from "../server/tools/broker";
import { createLogger } from "../server/logger";

describe("tool broker close", () => {
  it("settles a running server tool at once even when its handler ignores the signal", async () => {
    const broker = createToolBroker({
      sessionId: "s",
      serverTools: () => [
        { name: "hang", description: "never returns", timeoutMs: 60_000, handler: () => new Promise(() => {}) }
      ],
      clientTools: [],
      send: () => {},
      log: createLogger("test")
    });
    const pending = broker.run({ callId: "c1", name: "hang", arguments: "{}" });
    await Promise.resolve();
    broker.close();
    await expect(pending).resolves.toEqual({ ok: false, output: JSON.stringify({ error: "the session ended" }) });
  });
});
