import { spawn } from "node:child_process";

/** The ES8326B's playback level, as the simple mixer names it. */
const PLAYBACK_CONTROL = "Playback";

/** The card in an ALSA device name (`plughw:1,0` is card 1); `0` when the name has none. */
function cardOf(device: string): string {
  return device.includes(":") ? (device.split(":")[1]?.split(",")[0] ?? "0") : "0";
}

/** One amixer run: its exit code (null when it could not start) and what it printed. */
type AmixerRun = (args: string[]) => Promise<{ code: number | null; stdout: string }>;

const runAmixer: AmixerRun = (args) =>
  new Promise((resolve) => {
    const child = spawn("amixer", args);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // `close`, not `exit`: only once the pipes have drained is `stdout` whole.
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });

/**
 * The level (0..1) amixer reports for a simple control, read from its first
 * playback channel — `sset` writes every channel alike, so any one is the level:
 *
 *   Front Left: Playback 255 [100%] [0.00dB] [on]
 *
 * Null for output that holds no playback level. The percentage is amixer's raw
 * scale, the same one `sset N%` is written in.
 */
export function parsePlaybackLevel(output: string): number | null {
  const percent = /:\s+Playback\s+-?\d+\s+\[(\d+)%\]/.exec(output)?.[1];
  return percent === undefined ? null : Number(percent) / 100;
}

/**
 * Reads the playback level, 0..1. Resolves null when the mixer cannot report it:
 * a step is never taken from a level that was guessed.
 */
export async function getAlsaVolume(device: string, run: AmixerRun = runAmixer): Promise<number | null> {
  const result = await run(["-c", cardOf(device), "get", PLAYBACK_CONTROL]);
  return result.code === 0 ? parsePlaybackLevel(result.stdout) : null;
}

/**
 * Applies playback volume on the ES8326B mixer. Resolves false if amixer did not
 * exit cleanly, so Max never claims a volume change that did not happen.
 */
export async function setAlsaVolume(device: string, level: number, run: AmixerRun = runAmixer): Promise<boolean> {
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
  const result = await run(["-c", cardOf(device), "sset", PLAYBACK_CONTROL, `${percent}%`]);
  return result.code === 0;
}
