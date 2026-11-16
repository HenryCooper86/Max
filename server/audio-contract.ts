import type { AudioPlan, DeviceAudio } from "../shared/agent";

/**
 * The audio contract between a device and the relay.
 *
 * A device may say, in `session.start`, what its own hardware and firmware
 * already do to the microphone signal. The relay then leaves those jobs to the
 * device instead of doing them a second time, or working against them, and
 * tells the device what it decided in `session.started`.
 *
 * A device that says nothing is treated exactly as before this existed.
 * See docs/audio/contract.md for the document written for hardware builders.
 */

const SPEAKERS = ["sealed", "open", "bone", "loudspeaker"] as const;

/** Keeps the well-formed fields of an untrusted declaration; undefined when
 *  nothing usable is left. Unknown keys are dropped, never rejected, so a
 *  device built against a newer contract still connects. */
export function normalizeDeviceAudio(raw: unknown): DeviceAudio | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const result: DeviceAudio = {};
  for (const key of ["echoCancellation", "noiseSuppression", "autoGainControl", "voiceGate", "wakeWord"] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  if (typeof input.microphones === "number" && Number.isInteger(input.microphones)) {
    if (input.microphones >= 1 && input.microphones <= 16) result.microphones = input.microphones;
  }
  if (typeof input.speaker === "string" && (SPEAKERS as readonly string[]).includes(input.speaker)) {
    result.speaker = input.speaker as DeviceAudio["speaker"];
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * What the relay does for a session, given what the device declared.
 *
 * - Wake word: a device that spots the wake word itself sends only speech
 *   meant for the assistant, so the relay's own name check is skipped. Run
 *   twice, the second check would drop every follow-up that did not repeat
 *   the name.
 * - Silence: a device that stops sending while nobody speaks never sends the
 *   quiet a speech detector needs to hear to end a turn. The relay supplies
 *   it.
 * - Interruption: the speech detectors behind the relay listen to the
 *   device's microphone. A device whose speaker reaches its microphone and
 *   which does not cancel that echo will make them hear the assistant as the
 *   wearer. Such a device is asked to confirm an interruption against its own
 *   microphone before cutting the reply.
 */
export function planAudio(device: DeviceAudio | undefined, relayWakeWord: boolean): AudioPlan {
  const echoReachesMic = device?.echoCancellation === false && device.speaker !== "sealed";
  return {
    wakeGate: !relayWakeWord ? "off" : device?.wakeWord ? "device" : "relay",
    silenceFill: device?.voiceGate === true,
    bargeIn: echoReachesMic ? "confirm" : "relay"
  };
}

/** 20 ms of silence at 16 kHz mono PCM16. */
const SILENT_FRAME = Buffer.alloc(640);
const FRAME_MS = 20;

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * Supplies the quiet a voice-gated device leaves out.
 *
 * After the device's last frame, if nothing more arrives for a moment, frames
 * of silence are sent in its place for long enough to end the turn. It stops
 * the instant the device sends again, and sends nothing while the device is
 * simply idle between turns.
 */
export class SilenceFiller {
  /** A gap this long after a frame means the device has stopped sending. */
  static readonly GAP_MS = 120;
  /** How much quiet is supplied: longer than any backend's end-of-speech wait. */
  static readonly FILL_MS = 1600;

  private timer: unknown;
  private remaining = 0;

  constructor(
    private readonly send: (frame: Buffer) => void,
    private readonly timers: Timers = {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    }
  ) {}

  /** Call for every frame the device sends. */
  frame(): void {
    this.stop();
    this.remaining = Math.round(SilenceFiller.FILL_MS / FRAME_MS);
    this.timer = this.timers.setTimeout(() => this.tick(), SilenceFiller.GAP_MS);
  }

  /** Call when the device closes its microphone or the session ends. */
  stop(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = 0;
  }

  private tick(): void {
    this.timer = undefined;
    if (this.remaining <= 0) return;
    this.remaining -= 1;
    this.send(SILENT_FRAME);
    if (this.remaining > 0) this.timer = this.timers.setTimeout(() => this.tick(), FRAME_MS);
  }
}
