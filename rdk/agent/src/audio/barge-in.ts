/**
 * Decides whether a barge-in reported by the relay is really the rider.
 *
 * Doubao's VAD runs on the uplink, so it fires on whatever we send it —
 * including echo the canceller failed to remove. Acting on that unconditionally
 * is what made the echo loop self-sustaining, because each barge-in reset the
 * canceller. Requiring corroboration from our own mic, after cancellation,
 * gives a second opinion on a cleaned signal.
 *
 * It deliberately does NOT reuse createVoiceGate. That gate waits for 400 ms of
 * sustained speech before it opens, which is right for deciding a parked helmet
 * should reopen a session and far too slow here: the relay's event arrives
 * ~100-200 ms after speech starts and is sent once per turn, so a slow witness
 * misses the interruption entirely.
 *
 * Either side may notice first, so both orders are handled. If our mic already
 * heard the rider, the barge-in is honoured at once. If the relay is first, the
 * request waits a short grace period for our mic to catch up rather than being
 * thrown away.
 */

export type BargeInOptions = {
  /** Frame RMS above which the mic is considered to hold rider speech. */
  rmsThreshold: number;
  /** Consecutive frames required, to reject single-frame transients. */
  minFrames?: number;
  /** How long a corroboration stays valid, covering gaps between syllables. */
  windowMs: number;
  /** How long a relay request waits for the mic to catch up. */
  graceMs?: number;
  now?: () => number;
  /**
   * False when AEC is off. The mic then carries Max at full volume and cannot
   * witness anything, so the relay is trusted as before.
   */
  enabled?: boolean;
};

export type BargeInGuard = {
  /** Called for every capture frame, with that frame's RMS. */
  observe(level: number, at?: number): void;
  /** Asks to barge in. `onConfirm` runs once, now or within the grace period. */
  request(onConfirm: () => void, at?: number): void;
};

export function createBargeInGuard(options: BargeInOptions): BargeInGuard {
  const clock = options.now ?? (() => Date.now());
  const enabled = options.enabled ?? true;
  const minFrames = options.minFrames ?? 3;
  const graceMs = options.graceMs ?? 300;

  let run = 0;
  let heardAt = Number.NEGATIVE_INFINITY;
  let pending: { deadline: number; onConfirm: () => void } | null = null;

  return {
    observe(level: number, at?: number): void {
      const time = at ?? clock();
      if (level < options.rmsThreshold) {
        run = 0;
        return;
      }
      run += 1;
      if (run < minFrames) return;

      heardAt = time;
      if (pending && time <= pending.deadline) {
        const confirm = pending.onConfirm;
        pending = null;
        confirm();
      }
    },

    request(onConfirm: () => void, at?: number): void {
      if (!enabled) {
        onConfirm();
        return;
      }
      const time = at ?? clock();
      if (time - heardAt <= options.windowMs) {
        onConfirm();
        return;
      }
      // The relay got there first. Hold the request open briefly instead of
      // discarding it — the rider is mid-word and our mic is about to agree.
      pending = { deadline: time + graceMs, onConfirm };
    }
  };
}
