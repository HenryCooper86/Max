import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceActionName } from "../server/device-actions";
import { DEVICE_ACTION_TIERS, deviceFailureSpeech } from "../server/device-actions";
import { EMBEDDED_CAPABILITIES, capabilityFor } from "../rdk/agent/src/device/capabilities";
import { createDeviceDispatcher, nextVolumeLevel } from "../rdk/agent/src/device/dispatch";
import type { VisionClient, VisionResponse } from "../rdk/agent/src/vision-client";

function fakeVision(
  response: VisionResponse
): VisionClient & { calls: string[]; requests: { op: string; args: Record<string, unknown> }[] } {
  const calls: string[] = [];
  const requests: { op: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    requests,
    request: async (op: string, args: Record<string, unknown> = {}) => {
      calls.push(op);
      requests.push({ op, args });
      return response;
    },
    handleChunk: () => {},
    failAllPending: () => {}
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EMBEDDED_CAPABILITIES", () => {
  it("covers every device action the relay can send", () => {
    // Derived, never re-listed — server/session-controller.ts:41 carries the
    // scar for exactly this pattern: a hand-copied platform list there
    // silently rejected the embedded client once the enum grew "embedded".
    // This list made the same mistake, silently omitting "camera.look" after
    // it was added to DeviceActionName.
    const actions = Object.keys(DEVICE_ACTION_TIERS) as DeviceActionName[];
    for (const action of actions) {
      expect(EMBEDDED_CAPABILITIES[action]).toBeDefined();
    }
  });

  it("supports only the actions the helmet hardware can actually perform", () => {
    const supported = Object.entries(EMBEDDED_CAPABILITIES)
      .filter(([, capability]) => capability.supported)
      .map(([action]) => action)
      .sort();
    expect(supported).toEqual([
      "camera.look",
      "camera.photo",
      "camera.record",
      "navigation.start",
      "navigation.stop",
      "system.shutdown",
      "vision.watch",
      "volume.set"
    ]);
  });

  it("gives every refusal a reason that maps to real speech", () => {
    for (const [action, capability] of Object.entries(EMBEDDED_CAPABILITIES)) {
      if (capability.supported) continue;
      expect(capability.reason).toBeTruthy();
      const speech = deviceFailureSpeech(action as DeviceActionName, "unsupported", capability.reason);
      expect(speech.endsWith("操作没成功。")).toBe(false);
    }
  });

  it("supports helmet navigation without claiming it can show a destination", () => {
    expect(capabilityFor("navigation.start")).toEqual({ supported: true });
    expect(capabilityFor("navigation.stop")).toEqual({ supported: true });
    expect(capabilityFor("gallery.open").reason).toBe("device.noScreen");
    expect(capabilityFor("destination.show")).toEqual({ supported: false, reason: "device.noScreen" });
    expect(capabilityFor("call.dial").reason).toBe("device.noPhone");
  });
});

describe("nextVolumeLevel", () => {
  it("has no level beyond either end", () => {
    expect(nextVolumeLevel(1, "up")).toBeNull();
    // 14% is the quietest level (1/7) read back from amixer, which keeps whole percents.
    expect(nextVolumeLevel(0.14, "down")).toBeNull();
    expect(nextVolumeLevel(1.5, "up")).toBeNull();
    expect(nextVolumeLevel(-0.5, "down")).toBeNull();
  });

  it("never goes below the quietest level, not even from a mixer left below it", () => {
    expect(nextVolumeLevel(1 / 7, "down")).toBeNull();
    expect(nextVolumeLevel(0.07, "down")).toBeNull();
    // From below, "louder" is a real move up to the quietest level.
    expect(nextVolumeLevel(0.07, "up")).toBe(1 / 7);
  });

  it("brings a level left off the grid by hand onto it in one move", () => {
    expect(nextVolumeLevel(0.52, "up")).toBeCloseTo(5 / 7);
    expect(nextVolumeLevel(0.52, "down")).toBeCloseTo(3 / 7);
  });

  it("spreads seven levels from a configured floor to full", () => {
    // Floor 30%: 30, 41.7, 53.3, 65, 76.7, 88.3, 100.
    expect(nextVolumeLevel(1, "down", 0.3)).toBeCloseTo(0.8833, 3);
    expect(nextVolumeLevel(0.35, "down", 0.3)).toBeCloseTo(0.3);
    expect(nextVolumeLevel(0.3, "down", 0.3)).toBeNull();
    // amixer's whole percents: 88% reads back as the sixth level, not off the grid.
    expect(nextVolumeLevel(0.88, "up", 0.3)).toBe(1);
    expect(nextVolumeLevel(0.2, "up", 0.3)).toBeCloseTo(0.3);
  });
});

describe("createDeviceDispatcher", () => {
  it("refuses an unsupported action without touching the sidecar", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
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
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
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
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
    const result = await dispatch({ commandId: "c3", action: "camera.record", args: { start: true } });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("storage.full");
  });

  it("steps the mixer from where it is, on the command the relay actually sends", async () => {
    // "Max, 大声一点" arrives as args.direction (extractDeviceCommand in
    // server/device-actions.ts; iOS and Android read the same field). The
    // dispatcher used to accept only a numeric `level`, which nothing sends,
    // so every spoken volume change on the helmet failed.
    const vision = fakeVision({ id: "v1", status: "ok" });
    const applied: number[] = [];
    const dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 0.43,
      setVolume: async (level) => {
        applied.push(level);
        return true;
      }
    });
    const up = await dispatch({ commandId: "c4", action: "volume.set", args: { direction: "up" } });
    const down = await dispatch({ commandId: "c5", action: "volume.set", args: { direction: "down" } });
    expect(applied).toEqual([4 / 7, 2 / 7]);
    expect(up).toEqual({ type: "device.result", commandId: "c4", status: "ok" });
    expect(down).toEqual({ type: "device.result", commandId: "c5", status: "ok" });
    expect(vision.calls).toEqual([]);
  });

  it("reaches its quietest level in six steps and never silences the board", async () => {
    // The phones stop at an audible floor too. amixer keeps whole percents, so
    // each level is read back rounded.
    let level = 1;
    const setVolume = vi.fn(async (next: number) => {
      level = Math.round(next * 100) / 100;
      return true;
    });
    const dispatch = createDeviceDispatcher({
      vision: fakeVision({ id: "v1", status: "ok" }),
      getVolume: async () => level,
      setVolume
    });
    const levels: number[] = [];
    for (let step = 0; step < 6; step += 1) {
      const result = await dispatch({ commandId: `quiet-${step}`, action: "volume.set", args: { direction: "down" } });
      expect(result.status).toBe("ok");
      levels.push(level);
    }
    expect(levels).toEqual([0.86, 0.71, 0.57, 0.43, 0.29, 0.14]);
    // One more would silence Max and every spoken hazard alert, so it is not taken.
    const floor = await dispatch({ commandId: "quiet-6", action: "volume.set", args: { direction: "down" } });
    expect(floor).toEqual({ type: "device.result", commandId: "quiet-6", status: "failed" });
    expect(setVolume).toHaveBeenCalledTimes(6);
  });

  it("reports failure, not a phantom change, when already at the end asked for", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const setVolume = vi.fn(async () => true);
    const atCeiling = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume });
    const atFloor = createDeviceDispatcher({ vision, getVolume: async () => 0.14, setVolume });
    const louder = await atCeiling({ commandId: "c8", action: "volume.set", args: { direction: "up" } });
    const quieter = await atFloor({ commandId: "c9", action: "volume.set", args: { direction: "down" } });
    expect(louder).toEqual({ type: "device.result", commandId: "c8", status: "failed" });
    expect(quieter).toEqual({ type: "device.result", commandId: "c9", status: "failed" });
    expect(setVolume).not.toHaveBeenCalled();
  });

  it("does not raise a mixer left below the quietest level when asked for quieter", async () => {
    const setVolume = vi.fn(async () => true);
    const dispatch = createDeviceDispatcher({
      vision: fakeVision({ id: "v1", status: "ok" }),
      getVolume: async () => 0.07,
      setVolume
    });
    const result = await dispatch({ commandId: "c10", action: "volume.set", args: { direction: "down" } });
    expect(result).toEqual({ type: "device.result", commandId: "c10", status: "failed" });
    expect(setVolume).not.toHaveBeenCalled();
  });

  it("reports failure when the mixer will not move", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => false });
    const result = await dispatch({ commandId: "c5", action: "volume.set", args: { direction: "down" } });
    expect(result.status).toBe("failed");
  });

  it("reports failure when the mixer cannot be read, without writing a guessed level", async () => {
    const setVolume = vi.fn(async () => true);
    const dispatch = createDeviceDispatcher({
      vision: fakeVision({ id: "v1", status: "ok" }),
      getVolume: async () => null,
      setVolume
    });
    const result = await dispatch({ commandId: "c6", action: "volume.set", args: { direction: "up" } });
    expect(result).toEqual({ type: "device.result", commandId: "c6", status: "failed" });
    expect(setVolume).not.toHaveBeenCalled();
  });

  it("refuses a command with no direction without touching the mixer", async () => {
    const getVolume = vi.fn(async () => 1);
    const setVolume = vi.fn(async () => true);
    const dispatch = createDeviceDispatcher({
      vision: fakeVision({ id: "v1", status: "ok" }),
      getVolume,
      setVolume
    });
    const result = await dispatch({ commandId: "c7", action: "volume.set", args: { level: 0.5 } });
    expect(result).toEqual({ type: "device.result", commandId: "c7", status: "unsupported", reason: "action.invalid" });
    expect(getVolume).not.toHaveBeenCalled();
    expect(setVolume).not.toHaveBeenCalled();
  });

  it("forwards vision.watch to the vision control plane", async () => {
    // No dispatch.ts branch for this action: it rides the same
    // options.vision.request(command.action, command.args) fall-through as
    // camera.photo/camera.record above, now that the sidecar has a real
    // "vision.watch" handler (Task 4) and EMBEDDED_CAPABILITIES marks it
    // supported (Task 5).
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
    const result = await dispatch({ commandId: "w1", action: "vision.watch", args: { on: true } });
    expect(result).toEqual({ type: "device.result", commandId: "w1", status: "ok" });
    expect(vision.requests).toContainEqual({ op: "vision.watch", args: { on: true } });
  });

  it("never lets a thrown handler swallow the result", async () => {
    const vision: VisionClient = {
      request: async () => {
        throw new Error("socket gone");
      },
      handleChunk: () => {},
      failAllPending: () => {}
    };
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
    const result = await dispatch({ commandId: "c6", action: "camera.photo", args: {} });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c6",
      status: "failed",
      reason: "capture.failed"
    });
  });
});

// camera.look never went through the agent before: EMBEDDED_CAPABILITIES and
// the extractor both treat it as supported, but the dispatcher branch that
// actually fetches the board's frame had no test at all.
describe("createDeviceDispatcher — camera.look", () => {
  it("denies the look when the board's consent gate refuses with 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response)
    );
    const onFrame = vi.fn();
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      previewPort: 8081,
      onFrame
    });

    const result = await dispatch({ commandId: "c7", action: "camera.look", args: {} });

    expect(result).toEqual({
      type: "device.result",
      commandId: "c7",
      status: "denied",
      reason: "vision.sharingOff"
    });
    expect(onFrame).not.toHaveBeenCalled();
    expect(vision.calls).toEqual([]);
  });

  it("fetches the frame, hands it to onFrame, and reports ok", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength)
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);
    const onFrame = vi.fn();
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      previewPort: 8081,
      onFrame
    });

    const result = await dispatch({ commandId: "c8", action: "camera.look", args: {} });

    expect(result).toEqual({ type: "device.result", commandId: "c8", status: "ok" });
    expect(onFrame).toHaveBeenCalledTimes(1);
    const [commandId, frame] = onFrame.mock.calls[0] as [string, Buffer];
    expect(commandId).toBe("c8");
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(frame.equals(jpegBytes)).toBe(true);
    expect(vision.calls).toEqual([]);

    // I2b: a hung sidecar must never leave this fetch pending for minutes —
    // confirm an abort signal is actually wired to the call, not just
    // documented in a comment.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":8081/frame/front");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports failure without touching onFrame when the sidecar fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch aborted");
      })
    );
    const onFrame = vi.fn();
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      previewPort: 8081,
      onFrame
    });

    const result = await dispatch({ commandId: "c9", action: "camera.look", args: {} });

    expect(result).toEqual({
      type: "device.result",
      commandId: "c9",
      status: "failed",
      reason: "capture.failed"
    });
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe("system.shutdown dispatch", () => {
  function poweroffStub(outcome: "scheduled" | "already", pending: boolean) {
    const calls: string[] = [];
    return {
      calls,
      controller: {
        schedule: (): "scheduled" | "already" => {
          calls.push("schedule");
          return outcome;
        },
        cancel: (): boolean => {
          calls.push("cancel");
          return pending;
        }
      }
    };
  }

  it("schedules the countdown and answers the relay immediately", async () => {
    const stub = poweroffStub("scheduled", false);
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      poweroff: stub.controller
    });

    const result = await dispatch({ commandId: "c10", action: "system.shutdown", args: {} });

    expect(result).toEqual({ type: "device.result", commandId: "c10", status: "ok" });
    expect(stub.calls).toEqual(["schedule"]);
    expect(vision.calls).toEqual([]);
  });

  it("cancel of a pending countdown is ok; of nothing, a truthful failure", async () => {
    const pending = poweroffStub("scheduled", true);
    const vision = fakeVision({ id: "v1", status: "ok" });
    let dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      poweroff: pending.controller
    });
    let result = await dispatch({ commandId: "c11", action: "system.shutdown", args: { cancel: true } });
    expect(result).toEqual({ type: "device.result", commandId: "c11", status: "ok" });

    const idle = poweroffStub("scheduled", false);
    dispatch = createDeviceDispatcher({
      vision,
      getVolume: async () => 1,
      setVolume: async () => true,
      poweroff: idle.controller
    });
    result = await dispatch({ commandId: "c12", action: "system.shutdown", args: { cancel: true } });
    expect(result).toEqual({
      type: "device.result",
      commandId: "c12",
      status: "failed",
      reason: "shutdown.notPending"
    });
  });

  it("without a controller the action fails honestly instead of pretending", async () => {
    const vision = fakeVision({ id: "v1", status: "ok" });
    const dispatch = createDeviceDispatcher({ vision, getVolume: async () => 1, setVolume: async () => true });
    const result = await dispatch({ commandId: "c13", action: "system.shutdown", args: {} });
    expect(result.status).toBe("failed");
  });
});
