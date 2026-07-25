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
 * Navigation gets `device.notYet` rather than `device.noPhone` because
 * audio-only turn-by-turn needs neither a phone nor a screen — it simply is not
 * built yet, and claiming otherwise would be a false explanation.
 */
export const EMBEDDED_CAPABILITIES: Record<DeviceActionName, EmbeddedCapability> = {
  "camera.photo": { supported: true },
  "camera.record": { supported: true },
  "volume.set": { supported: true },
  "gallery.open": { supported: false, reason: "device.noScreen" },
  "destination.show": { supported: false, reason: "device.noScreen" },
  "torch.set": { supported: false, reason: "torch.unavailable" },
  "music.control": { supported: false, reason: "device.noPhone" },
  "sms.compose": { supported: false, reason: "device.noPhone" },
  "call.dial": { supported: false, reason: "device.noPhone" },
  "navigation.start": { supported: false, reason: "device.notYet" },
  "navigation.stop": { supported: false, reason: "device.notYet" }
};

export function capabilityFor(action: DeviceActionName): EmbeddedCapability {
  return EMBEDDED_CAPABILITIES[action] ?? { supported: false, reason: "device.notYet" };
}
