import type { DeviceActionName } from "../../../../server/device-actions";
import type { DeviceResultEvent } from "../../../../shared/agent";
import type { VisionClient } from "../vision-client";
import { capabilityFor } from "./capabilities";

export type DeviceCommand = {
  commandId: string;
  action: DeviceActionName;
  args: Record<string, unknown>;
};

export type DispatcherOptions = {
  vision: VisionClient;
  /** Applies playback volume on the ES8326B mixer. Resolves false if the mixer
   *  did not move, so Max never claims a volume change that did not happen. */
  setVolume(level: number): Promise<boolean>;
  /** Port the sidecar serves `GET /frame/front` on. Used by `camera.look`. */
  previewPort: number;
  /** Receives the fetched frame for `camera.look`. Task 5 supplies this; until
   *  then the frame is fetched and dropped. */
  onFrame?: (commandId: string, jpeg: Buffer) => void;
};

/**
 * Turns one `device.command` into exactly one `device.result`. Every path —
 * including a thrown handler — produces a result, because the relay treats
 * silence past DEVICE_RESULT_TIMEOUT_MS as failure and would then speak a
 * generic failure line we could have made specific.
 */
export function createDeviceDispatcher(
  options: DispatcherOptions
): (command: DeviceCommand) => Promise<DeviceResultEvent> {
  return async (command: DeviceCommand): Promise<DeviceResultEvent> => {
    const capability = capabilityFor(command.action);
    if (!capability.supported) {
      return {
        type: "device.result",
        commandId: command.commandId,
        status: "unsupported",
        reason: capability.reason
      };
    }

    try {
      if (command.action === "volume.set") {
        const level = typeof command.args["level"] === "number" ? (command.args["level"] as number) : NaN;
        const applied = Number.isFinite(level) ? await options.setVolume(level) : false;
        return applied
          ? { type: "device.result", commandId: command.commandId, status: "ok" }
          : { type: "device.result", commandId: command.commandId, status: "failed" };
      }

      if (command.action === "camera.look") {
        // Fetched over HTTP, never the control socket: image bytes stay off
        // that channel. The frame is a buffer read on the sidecar, so this
        // returns long before the relay's 8 s device timeout.
        const response = await fetch(`http://127.0.0.1:${options.previewPort}/frame/front`);
        if (response.status === 403) {
          return {
            type: "device.result",
            commandId: command.commandId,
            status: "denied",
            reason: "vision.sharingOff"
          };
        }
        if (!response.ok) {
          return { type: "device.result", commandId: command.commandId, status: "failed" };
        }
        const frame = Buffer.from(await response.arrayBuffer());
        options.onFrame?.(command.commandId, frame);
        return { type: "device.result", commandId: command.commandId, status: "ok" };
      }

      const response = await options.vision.request(command.action, command.args);
      const result: DeviceResultEvent = {
        type: "device.result",
        commandId: command.commandId,
        status: response.status
      };
      if (response.reason !== undefined) result.reason = response.reason;
      if (response.detail !== undefined) result.detail = response.detail;
      return result;
    } catch {
      return {
        type: "device.result",
        commandId: command.commandId,
        status: "failed",
        reason: "capture.failed"
      };
    }
  };
}
