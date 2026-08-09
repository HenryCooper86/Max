import type { DeviceActionName } from "../../../../server/device-actions";

export type EmbeddedCapability = {
  supported: boolean;
  /** A `FAILURE_SPEECH` key from server/device-actions.ts. Required when
   *  `supported` is false, so the rider hears why rather than "没成功". */
  reason?: string;
};

/**
 * What the helmet can honestly do.
 *
 * `gallery.open` is deliberately unsupported: the dev HUD can display the
 * gallery, but it is a bench instrument the rider cannot see, and replying `ok`
 * would have Max claim the rider is looking at photos that are not in front of
 * them.
 *
 */
export const EMBEDDED_CAPABILITIES: Record<DeviceActionName, EmbeddedCapability> = {
  "camera.photo": { supported: true },
  "camera.record": { supported: true },
  "system.shutdown": { supported: true },
  "camera.look": { supported: true },
  "volume.set": { supported: true },
  "gallery.open": { supported: false, reason: "device.noScreen" },
  // Gated to the iOS platform at the source (device-actions.ts's
  // PLATFORM_RESTRICTED_ACTIONS), so the relay never actually dispatches this
  // to the board — listed here only for Record<DeviceActionName, ...>
  // exhaustiveness. Describing the rider's PHONE photo gallery is a phone
  // feature the helmet lacks, same reasoning as music.control/sms.compose/
  // call.dial below, not a screen feature like gallery.open above.
  "gallery.describe": { supported: false, reason: "device.noPhone" },
  "destination.show": { supported: false, reason: "device.noScreen" },
  "torch.set": { supported: false, reason: "torch.unavailable" },
  "music.control": { supported: false, reason: "device.noPhone" },
  "sms.compose": { supported: false, reason: "device.noPhone" },
  "call.dial": { supported: false, reason: "device.noPhone" },
  "navigation.start": { supported: true },
  "navigation.stop": { supported: true },
  // V-C Task 5: the Python sidecar now has a real "vision.watch" handler
  // (rdk/vision/service.py's WatchSampler) behind the same request() fallback
  // volume.set etc. skip — dispatch.ts needs no new branch. Honest to claim
  // support now that something on the other end actually honors it and
  // main.ts's onEvent forwards the resulting watch.frame pushes to the relay.
  "vision.watch": { supported: true }
};

export function capabilityFor(action: DeviceActionName): EmbeddedCapability {
  return EMBEDDED_CAPABILITIES[action] ?? { supported: false, reason: "device.notYet" };
}
