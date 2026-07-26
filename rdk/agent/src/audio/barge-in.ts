/**
 * Decides whether a barge-in reported by the relay is really the rider.
 *
 * Doubao's VAD runs on the uplink, so it fires on whatever we send it —
 * including echo the canceller failed to remove. That made the echo loop
 * self-sustaining: Max speaks, residual echo trips the VAD, the agent treats it
 * as barge-in, and the reply is cut and re-answered. Requiring our own voice
 * gate to have heard something too gives a second opinion from a signal the
 * canceller has already cleaned.
 *
 * The window exists because speech has gaps. Demanding that the gate be high at
 * the exact millisecond the relay event arrives would drop genuine
 * interruptions landing between syllables.
 */

export type BargeInOptions = {
  windowMs: number;
  now?: () => number;
  /**
   * False when AEC is off. The gate then hears Max at full volume and cannot
   * witness anything, so the relay is trusted as before.
   */
  enabled?: boolean;
};

export type BargeInGuard = {
  /** Called for every capture frame with the local gate's verdict. */
  observe(speaking: boolean, at?: number): void;
  /** True if a relay barge-in should be honoured. */
  allow(at?: number): boolean;
};

export function createBargeInGuard(options: BargeInOptions): BargeInGuard {
  const clock = options.now ?? (() => Date.now());
  const enabled = options.enabled ?? true;
  let lastSpokeAt = Number.NEGATIVE_INFINITY;

  return {
    observe(speaking: boolean, at?: number): void {
      if (speaking) lastSpokeAt = at ?? clock();
    },

    allow(at?: number): boolean {
      if (!enabled) return true;
      return (at ?? clock()) - lastSpokeAt <= options.windowMs;
    }
  };
}
