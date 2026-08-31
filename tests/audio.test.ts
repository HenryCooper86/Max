import { describe, expect, it } from "vitest";
import { createPacketWindow, recordDroppedFrame, recordSentFrame } from "../shared/audio";

describe("audio packet metrics", () => {
  it("emits outgoing FPS once the packet window elapses", () => {
    let packet = createPacketWindow();
    packet = recordSentFrame(packet, 0).window;
    const result = recordSentFrame(packet, 1000);

    // Two frames 1000 ms apart is a true rate of 1 fps: the anchor frame
    // contributes no elapsed time, so it must not be counted in the rate.
    expect(result.metric).toEqual({ outgoingFrames: 2, outgoingFps: 1, droppedFrames: 0 });
  });

  it("reports the true rate at the real 20 ms frame cadence", () => {
    let packet = createPacketWindow();
    let metric;
    // 51 frames at 20 ms spacing: anchor at t=0, then 50 frames over 1000 ms.
    for (let i = 0; i <= 50; i += 1) {
      const result = recordSentFrame(packet, i * 20);
      packet = result.window;
      if (result.metric) metric = result.metric;
    }

    expect(metric).toEqual({ outgoingFrames: 51, outgoingFps: 50, droppedFrames: 0 });
  });

  it("tracks dropped frames while preserving the active window", () => {
    const first = recordSentFrame(createPacketWindow(), 100);
    const dropped = recordDroppedFrame(first.window);

    expect(dropped.metric.droppedFrames).toBe(1);
    expect(dropped.window.sent).toBe(1);
  });
});
