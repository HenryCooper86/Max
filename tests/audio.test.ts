import { describe, expect, it } from "vitest";
import { createPacketWindow, recordDroppedFrame, recordSentFrame } from "../shared/audio";

describe("audio packet metrics", () => {
  it("emits outgoing FPS once the packet window elapses", () => {
    let packet = createPacketWindow();
    packet = recordSentFrame(packet, 0).window;
    const result = recordSentFrame(packet, 1000);

    expect(result.metric).toEqual({ outgoingFrames: 2, outgoingFps: 2, droppedFrames: 0 });
  });

  it("tracks dropped frames while preserving the active window", () => {
    const first = recordSentFrame(createPacketWindow(), 100);
    const dropped = recordDroppedFrame(first.window);

    expect(dropped.metric.droppedFrames).toBe(1);
    expect(dropped.window.sent).toBe(1);
  });
});
