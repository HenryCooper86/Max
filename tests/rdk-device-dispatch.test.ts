import { describe, expect, it } from "vitest";
import type { DeviceActionName } from "../server/device-actions";
import { deviceFailureSpeech } from "../server/device-actions";
import { EMBEDDED_CAPABILITIES, capabilityFor } from "../rdk/agent/src/device/capabilities";
import { createDeviceDispatcher } from "../rdk/agent/src/device/dispatch";
import type { VisionClient, VisionResponse } from "../rdk/agent/src/vision-client";

function fakeVision(response: VisionResponse): VisionClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async (op: string) => {
      calls.push(op);
      return response;
    },
    handleChunk: () => {},
    failAllPending: () => {}
  };
}

describe("EMBEDDED_CAPABILITIES", () => {
  it("covers every device action the relay can send", () => {
    const actions: DeviceActionName[] = [
      "torch.set",
      "volume.set",
      "music.control",
      "sms.compose",
      "call.dial",
      "destination.show",
      "camera.photo",
      "camera.record",
      "gallery.open",
      "navigation.start",
      "navigation.stop"
    ];
    for (const action of actions) {
      expect(EMBEDDED_CAPABILITIES[action]).toBeDefined();
    }
  });

  it("supports only the actions the helmet hardware can actually perform", () => {
    const supported = Object.entries(EMBEDDED_CAPABILITIES)
      .filter(([, capability]) => capability.supported)
      .map(([action]) => action)
      .sort();
    expect(supported).toEqual(["camera.look", "camera.photo", "camera.record", "volume.set"]);
  });

  it("gives every refusal a reason that maps to real speech", () => {
    for (const [action, capability] of Object.entries(EMBEDDED_CAPABILITIES)) {
      if (capability.supported) continue;
      expect(capability.reason).toBeTruthy();
      const speech = deviceFailureSpeech(action as DeviceActionName, "unsupported", capability.reason);
      expect(speech.endsWith("操作没成功。")).toBe(false);
    }
  });

  it("does not blame a missing phone for unbuilt navigation", () => {
    expect(capabilityFor("navigation.start").reason).toBe("device.notYet");
    expect(capabilityFor("gallery.open").reason).toBe("device.noScreen");
    expect(capabilityFor("call.dial").reason).toBe("device.noPhone");
  });
});

describe("createDeviceDispatcher", () => {
  it("refuses an unsupported action without touching the sidecar", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c1", action: "gallery.open", args: {} });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c1",
      status: "unsupported",
      reason: "device.noScreen"
    });
    expect(vision.calls).toEqual([]);
  });

  it("forwards a photo to the sidecar and echoes the command id", async () => {
    const vision = fakeVision({ id: "v1", status: "ok", detail: "pair-20260725-142233" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c2", action: "camera.photo", args: {} });
    expect(vision.calls).toEqual(["camera.photo"]);
    expect(result).toEqual({
      type: "device.result",
      commandId: "c2",
      status: "ok",
      detail: "pair-20260725-142233"
    });
  });

  it("passes a sidecar refusal through verbatim", async () => {
    const vision = fakeVision({ id: "v1", status: "failed", reason: "storage.full" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c3", action: "camera.record", args: { start: true } });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("storage.full");
  });

  it("handles volume locally", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    let applied = -1;
    const dispatch = createDeviceDispatcher({
      vision,
      setVolume: async (level) => {
        applied = level;
        return true;
      }
    });
    const result = await dispatch({ commandId: "c4", action: "volume.set", args: { level: 0.5 } });
    expect(applied).toBe(0.5);
    expect(result.status).toBe("ok");
    expect(vision.calls).toEqual([]);
  });

  it("reports failure when the mixer will not move", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => false });
    const result = await dispatch({ commandId: "c5", action: "volume.set", args: { level: 0.5 } });
    expect(result.status).toBe("failed");
  });

  it("never lets a thrown handler swallow the result", async () => {
    const vision: VisionClient = {
      request: async () => {
        throw new Error("socket gone");
      },
      handleChunk: () => {},
      failAllPending: () => {}
    };
    const dispatch = createDeviceDispatcher({ vision, setVolume: async () => true });
    const result = await dispatch({ commandId: "c6", action: "camera.photo", args: {} });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c6",
      status: "failed",
      reason: "capture.failed"
    });
  });
});
