import { spawn } from "node:child_process";

/**
 * The ES8326's CROSSTALK controls are a hardware duck, not an echo canceller:
 * at the vendor default they attenuate the whole capture path while the DAC is
 * active, so the rider cannot be heard while Max speaks.
 *
 * They must therefore track the AEC state exactly. A board left at 0 with no
 * canceller running is the echo loop that reached a live rider on 2026-07-25.
 */

export const CROSSTALK_AEC_ON = 0;
export const CROSSTALK_AEC_OFF = 10;

const CONTROLS = ["CROSSTALK1", "CROSSTALK2"] as const;

export type RunFn = (cmd: string, args: string[]) => Promise<number>;

export function crosstalkFor(aecActive: boolean): number {
  return aecActive ? CROSSTALK_AEC_ON : CROSSTALK_AEC_OFF;
}

export function mixerArgs(control: string, value: number): string[] {
  return ["-c", "0", "sset", control, String(value)];
}

const defaultRun: RunFn = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args);
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

/**
 * Returns false rather than throwing: a mixer we cannot set is a reason to log
 * and fall back, never a reason to take the agent down.
 */
export async function applyCrosstalk(aecActive: boolean, run: RunFn = defaultRun): Promise<boolean> {
  const value = crosstalkFor(aecActive);
  for (const control of CONTROLS) {
    try {
      if ((await run("amixer", mixerArgs(control, value))) !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}
