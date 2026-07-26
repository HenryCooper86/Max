import { describe, expect, it, vi } from "vitest";
import { createHazardInjector } from "../server/hazard-injector";

function harness(platform?: string) {
  const send = vi.fn();
  const injector = createHazardInjector({
    send,
    emitRideContext: () => {},
    platform: () => platform
  });
  return { send, injector };
}

async function tick(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createHazardInjector", () => {
  it("injects simulated hazards for a web session", async () => {
    const { send, injector } = harness("web");
    injector.start(1, 1);
    await tick();
    injector.stop();
    expect(send).toHaveBeenCalled();
  });

  it("never injects for an embedded session", async () => {
    // The embedded board runs a real detector. A rider cannot tell a simulated
    // hazard from a real one, and a transcript holding both is worthless as QA
    // evidence for the false-alarm rate M2 exists to measure.
    const { send, injector } = harness("embedded");
    injector.start(1, 1);
    await tick();
    injector.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("treats an unspecified platform as simulatable, preserving today's behaviour", async () => {
    const { send, injector } = harness(undefined);
    injector.start(1, 1);
    await tick();
    injector.stop();
    expect(send).toHaveBeenCalled();
  });

  it("stays inert for embedded even if start is called repeatedly", async () => {
    // The gate lives in the factory rather than at the five start() call sites,
    // because a rule spread across call sites is a rule that gets missed — this
    // project already shipped a platform allowlist duplicated across files, and
    // the fifth copy rejected the board.
    const { send, injector } = harness("embedded");
    injector.start(1, 1);
    injector.start(1, 1);
    injector.start(1, 1);
    await tick();
    injector.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("can be stopped without ever having started", () => {
    const { injector } = harness("embedded");
    expect(() => injector.stop()).not.toThrow();
  });
});
