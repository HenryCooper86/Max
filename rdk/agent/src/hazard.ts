/**
 * Turns a sidecar hazard event into either a log line or a spoken warning.
 *
 * Shadow mode is the default and does neither audio nor reporting. The board
 * made no sound, so there is no real alert for the transcript, and a shadow run
 * that reported would be indistinguishable from an armed one in the QA record —
 * which is the record M2 exists to build.
 *
 * Arming requires MAX_ADAS_AUDIO=1, which requires shadow-mode false-alarm
 * numbers meeting the M1 gate. M1's suppression constants are untuned starting
 * values; they must not reach a rider's ears at 100 km/h on trust.
 */

export type HazardEvent = {
  event: string;
  threat?: string;
  direction?: string;
  severity?: string;
  label?: string;
  message?: string;
  advice?: string;
  ttcSeconds?: number;
};

export type HazardHandlerOptions = {
  /** config.adasAudio. False until the M1 gate is met. */
  armed: boolean;
  player: { play(threat: string): Promise<number | null> };
  report(event: Record<string, unknown>): void;
  log?: (line: string) => void;
};

export function createHazardHandler(options: HazardHandlerOptions): {
  handle(event: HazardEvent): Promise<void>;
} {
  const log = options.log ?? ((line: string) => console.log(line));

  return {
    async handle(event: HazardEvent): Promise<void> {
      if (event.event !== "hazard" || !event.threat) return;

      if (!options.armed) {
        log(`[adas] shadow: ${event.threat} ttc=${event.ttcSeconds ?? "n/a"}`);
        return;
      }

      const latencyMs = await options.player.play(event.threat);

      try {
        options.report({
          type: "hazard.report",
          threat: event.threat,
          direction: event.direction,
          severity: event.severity,
          label: event.label,
          message: event.message,
          advice: event.advice,
          ttcSeconds: event.ttcSeconds,
          latencyMs
        });
      } catch (error) {
        // Best-effort, and never at the cost of the warning the rider just heard.
        log(`[adas] hazard.report failed: ${(error as Error).message}`);
      }
    }
  };
}
