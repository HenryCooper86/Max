import { rms } from "./dsp";

export type VoiceGateConfig = {
  /** Int16 RMS above which a frame counts as speech. */
  rmsThreshold: number;
  /** How long speech must persist before the gate opens. */
  sustainMs: number;
  /** How long quiet must persist before an open gate closes. */
  releaseMs: number;
  /** Duration of one frame, used to convert the millisecond budgets to counts. */
  frameMs: number;
};

/**
 * Defaults for a helmet at speed. These are a starting point, not a measured
 * result — wind noise raises the floor and the bench will move them.
 */
export const DEFAULT_VOICE_GATE: VoiceGateConfig = {
  rmsThreshold: 900,
  sustainMs: 400,
  releaseMs: 800,
  frameMs: 20
};

/** Below this fraction of the open threshold, an open gate starts releasing. */
const CLOSE_RATIO = 0.6;

/**
 * RMS gate with hysteresis. Returns the gate state after each frame: `true`
 * means "someone is talking, a session is warranted".
 *
 * This exists because the helmet has no button. The relay idle-closes with
 * IDLE_CLOSE_CODE and the other clients simply stay offline until the rider taps
 * something; here there is nothing to tap. It is deliberately NOT wake-word
 * detection — that stays server-side in shared/wake.ts. This only answers "is
 * anyone talking at all", so a parked helmet stops holding an upstream slot.
 */
export function createVoiceGate(config: Partial<VoiceGateConfig> = {}): (frame: Int16Array) => boolean {
  const { rmsThreshold, sustainMs, releaseMs, frameMs } = { ...DEFAULT_VOICE_GATE, ...config };
  const sustainFrames = Math.max(1, Math.ceil(sustainMs / frameMs));
  const releaseFrames = Math.max(1, Math.ceil(releaseMs / frameMs));
  const closeThreshold = rmsThreshold * CLOSE_RATIO;

  let open = false;
  let loudRun = 0;
  let quietRun = 0;

  return (frame: Int16Array): boolean => {
    const level = rms(frame);

    if (open) {
      if (level < closeThreshold) {
        quietRun += 1;
        if (quietRun >= releaseFrames) {
          open = false;
          loudRun = 0;
          quietRun = 0;
        }
      } else {
        quietRun = 0;
      }
      return open;
    }

    if (level >= rmsThreshold) {
      loudRun += 1;
      if (loudRun >= sustainFrames) {
        open = true;
        quietRun = 0;
      }
    } else {
      loudRun = 0;
    }
    return open;
  };
}
