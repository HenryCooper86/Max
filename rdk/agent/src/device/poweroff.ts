/**
 * The cancellable countdown behind "Max，关机".
 *
 * The countdown IS the confirmation. A spoken "确定吗?" would depend on the
 * rider hearing a deterministic line the embedded platform cannot speak until
 * the relay has TTS credentials; the model's chatter is not a safety channel
 * (it once narrated a recording that never happened). Ten seconds of
 * unmistakable local tones, cancellable by voice, is enforceable with
 * today's hardware.
 */

import type { CueKind } from "../audio/cues";

export type PoweroffCue = CueKind;

export type PoweroffOptions = {
  /** Runs the actual poweroff. Wired to `shutdown -h now` in main.ts, so
   *  systemd stops both services and max-vision finalizes a live recording. */
  exec(): void;
  cue(kind: PoweroffCue): void;
  /** The window. 10 s default: long enough to hear the arm tones and say
   *  取消关机, short enough that the intent is still fresh. */
  delayMs?: number;
  tickEveryMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type PoweroffController = {
  schedule(): "scheduled" | "already";
  cancel(): boolean;
};

const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_TICK_MS = 2_000;

export function createPoweroffController(options: PoweroffOptions): PoweroffController {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const tickEveryMs = options.tickEveryMs ?? DEFAULT_TICK_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let state: "idle" | "counting" | "executed" = "idle";
  let timers: ReturnType<typeof setTimeout>[] = [];

  function clearAll(): void {
    for (const timer of timers) clearTimer(timer);
    timers = [];
  }

  return {
    schedule(): "scheduled" | "already" {
      // "already" also covers executed: a second 关机 mid-poweroff must not
      // extend anything or re-arm tones over a system that is going down.
      if (state !== "idle") return "already";
      state = "counting";
      options.cue("armed");
      for (let at = tickEveryMs; at < delayMs; at += tickEveryMs) {
        timers.push(setTimer(() => options.cue("tick"), at));
      }
      timers.push(
        setTimer(() => {
          state = "executed";
          timers = [];
          options.cue("final");
          options.exec();
        }, delayMs)
      );
      return "scheduled";
    },

    cancel(): boolean {
      // After exec it is truthfully too late — the false return becomes
      // "现在没有要关机。", which is wrong for two seconds and then right.
      if (state !== "counting") return false;
      state = "idle";
      clearAll();
      options.cue("cancelled");
      return true;
    }
  };
}
