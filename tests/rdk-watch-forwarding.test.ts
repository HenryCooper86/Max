import { describe, expect, it, vi } from "vitest";
import { createVisionEventRouter, stopWatchOnClose } from "../rdk/agent/src/main";
import type { VisionEvent, VisionResponse } from "../rdk/agent/src/vision-client";

function fakeHazards(): { calls: VisionEvent[]; handle: (event: VisionEvent) => Promise<void> } {
  const calls: VisionEvent[] = [];
  return {
    calls,
    handle: async (event: VisionEvent) => {
      calls.push(event);
    }
  };
}

describe("createVisionEventRouter", () => {
  it("forwards a watch.frame event to the relay as a single-image vision.frames event", () => {
    const sendEvent = vi.fn();
    const hazards = fakeHazards();
    const router = createVisionEventRouter({ hazards, sendEvent });

    router({ event: "watch.frame", image: "QmFzZTY0Qnl0ZXM=" });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({
      type: "vision.frames",
      reason: "watch",
      index: 0,
      total: 1,
      image: "QmFzZTY0Qnl0ZXM="
    });
    expect(hazards.calls).toEqual([]);
  });

  it("drops a watch.frame with no image rather than forwarding a malformed event", () => {
    const sendEvent = vi.fn();
    const lines: string[] = [];
    const hazards = fakeHazards();
    const router = createVisionEventRouter({ hazards, sendEvent, log: (line) => lines.push(line) });

    router({ event: "watch.frame" });

    expect(sendEvent).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes("dropped watch.frame"))).toBe(true);
  });

  it("drops a watch.frame whose image is not a string", () => {
    const sendEvent = vi.fn();
    const lines: string[] = [];
    const hazards = fakeHazards();
    const router = createVisionEventRouter({ hazards, sendEvent, log: (line) => lines.push(line) });

    router({ event: "watch.frame", image: 12345 });

    expect(sendEvent).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes("dropped watch.frame"))).toBe(true);
  });

  it("still routes a hazard event to the hazard handler, not straight to the relay", () => {
    const sendEvent = vi.fn();
    const hazards = fakeHazards();
    const router = createVisionEventRouter({ hazards, sendEvent });

    router({ event: "hazard", threat: "forward_collision" });

    expect(hazards.calls).toEqual([{ event: "hazard", threat: "forward_collision" }]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("only logs an event it does not recognize; never calls sendEvent", () => {
    const sendEvent = vi.fn();
    const lines: string[] = [];
    const hazards = fakeHazards();
    const router = createVisionEventRouter({ hazards, sendEvent, log: (line) => lines.push(line) });

    router({ event: "preview.ready" });

    expect(sendEvent).not.toHaveBeenCalled();
    expect(hazards.calls).toEqual([]);
    expect(lines.some((line) => line.includes("preview.ready"))).toBe(true);
  });
});

describe("stopWatchOnClose", () => {
  it("issues vision.watch off when the relay session ends", () => {
    const request = vi.fn(async (): Promise<VisionResponse> => ({ id: "v1", status: "ok" }));

    stopWatchOnClose({ request });

    expect(request).toHaveBeenCalledWith("vision.watch", { on: false });
  });

  it("swallows a rejection — the vision socket may be down too", async () => {
    const request = vi.fn(async (): Promise<VisionResponse> => {
      throw new Error("socket gone");
    });

    expect(() => stopWatchOnClose({ request })).not.toThrow();
    // Let the rejected promise's own .catch() run so an unhandled-rejection
    // never surfaces past this call.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
