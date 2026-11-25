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
  /** Reads the ES8326B playback level, 0..1. Resolves null when the mixer
   *  cannot report it: a step is never taken from a level that was guessed. */
  getVolume(): Promise<number | null>;
  /** Applies playback volume on the ES8326B mixer. Resolves false if the mixer
   *  did not move, so Max never claims a volume change that did not happen. */
  setVolume(level: number): Promise<boolean>;
  /** The poweroff countdown (device/poweroff.ts). Optional so tests without
   *  one still compile; absent, the action fails honestly. */
  poweroff?: { schedule(): "scheduled" | "already"; cancel(): boolean };
  /** Port the sidecar serves `GET /frame/front` on. Used by `camera.look`. */
  previewPort: number;
  /** Receives the fetched frame for `camera.look`. Task 5 supplies this; until
   *  then the frame is fetched and dropped. */
  onFrame?: (commandId: string, jpeg: Buffer) => void;
};

/**
 * How many levels playback has. The phones step their gain 0.5 → 4.0 in 0.5
 * increments and never go below an audible floor (iOS
 * PlaybackVolumeController, Android nextVoiceGain). The helmet keeps the same
 * shape on the mixer's 0..100% range, as levels at 1/7, 2/7 … 7/7: the
 * quietest is one seventh, never 0, because Max, navigation prompts and spoken
 * hazard alerts all play through this control.
 */
const VOLUME_LEVELS = 7;

/**
 * The level one step from `current` (0..1) in `direction`, or null when there
 * is none to go to. Levels sit on a fixed grid of VOLUME_LEVELS points instead
 * of moving by a step from wherever the mixer happens to be: amixer stores
 * whole percents, so stepping 1/7 off each rounded value drifts (100 → 86 →
 * 72 → … → 16 → 2) and the drift ends in a short last step. A level left off
 * the grid by hand joins it on the first move, which is then between half a
 * step and one and a half.
 */
export function nextVolumeLevel(current: number, direction: "up" | "down"): number | null {
  const nearest = Math.round(Math.min(1, Math.max(0, current)) * VOLUME_LEVELS);
  const next = Math.min(VOLUME_LEVELS, Math.max(1, nearest + (direction === "up" ? 1 : -1)));
  const level = next / VOLUME_LEVELS;
  // A step must move the way it was asked: there is none beyond either end,
  // and a mixer left below the quietest level is not raised by "quieter".
  const moves = direction === "up" ? level > current : level < current;
  return moves ? level : null;
}

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
      if (command.action === "system.shutdown") {
        if (options.poweroff === undefined) {
          return { type: "device.result", commandId: command.commandId, status: "failed" };
        }
        if (command.args["cancel"] === true) {
          return options.poweroff.cancel()
            ? { type: "device.result", commandId: command.commandId, status: "ok" }
            : {
                type: "device.result",
                commandId: command.commandId,
                status: "failed",
                reason: "shutdown.notPending"
              };
        }
        // Answer now, not in 10 s: the relay's device-result window is 8 s,
        // and the countdown is the confirmation, not a pending outcome.
        options.poweroff.schedule();
        return { type: "device.result", commandId: command.commandId, status: "ok" };
      }

      if (command.action === "volume.set") {
        // The relay only ever asks for a step ("Max, 大声一点"), never an
        // absolute level, so the mixer is read before it is moved.
        const direction = command.args["direction"];
        if (direction !== "up" && direction !== "down") {
          return {
            type: "device.result",
            commandId: command.commandId,
            status: "unsupported",
            reason: "action.invalid"
          };
        }
        const current = await options.getVolume();
        // No level to go to — already at the end asked for — is reported as
        // the non-event it is: `ok` would have Max announce a change nobody
        // can hear.
        const level = current === null ? null : nextVolumeLevel(current, direction);
        const applied = level !== null && (await options.setVolume(level));
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
