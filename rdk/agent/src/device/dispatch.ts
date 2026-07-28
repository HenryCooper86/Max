import type { DeviceActionName } from "../../../../server/device-actions";
import type { DeviceResultEvent } from "../../../../shared/agent";
import type { VisionClient } from "../vision-client";
import { capabilityFor } from "./capabilities";

export type DeviceCommand = {
  commandId: string;
  action: DeviceActionName;
  args: Record<string, unknown>;
};

/** Bound for the board->sidecar `GET /frame/front` fetch that backs
 *  `camera.look`. Well under the relay's 8 s DEVICE_RESULT_TIMEOUT_MS so a
 *  hung sidecar fails this hop fast rather than leaving the fetch pending for
 *  minutes — see the comment at the call site. */
const CAMERA_LOOK_FETCH_TIMEOUT_MS = 3_000;

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
        // Fetched over HTTP, never the vision control socket (the unix socket
        // vision-client.ts uses for camera.photo/record): this board->sidecar
        // hop keeps image bytes off that channel. That is scoped to this hop
        // only — the frame goes on to travel the relay's own control socket
        // afterward, base64-encoded in a camera.frame event (see onFrame /
        // relay.sendEvent in main.ts).
        //
        // Bounded well under the relay's 8 s device-command timeout
        // (DEVICE_RESULT_TIMEOUT_MS in server/device-actions.ts): the frame is
        // ordinarily just a buffer read on the sidecar and returns almost
        // immediately, but without a signal here a hung sidecar would leave
        // this fetch pending for minutes. If it later completed anyway,
        // onFrame would hand the relay a scene that is no longer current —
        // exactly the "fluent sentence about the wrong scene" failure mode —
        // so a timeout here is what turns that into an honest, timely failure
        // instead.
        const response = await fetch(`http://127.0.0.1:${options.previewPort}/frame/front`, {
          signal: AbortSignal.timeout(CAMERA_LOOK_FETCH_TIMEOUT_MS)
        });
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
