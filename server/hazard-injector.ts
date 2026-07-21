import { ADAS_SCENARIOS, formatAdasAlert, type AdasSeverity } from "../shared/adas";
import { createTranscriptDelivery, transcriptEvent } from "./transcript-events";

// Simulated ADAS hazard source shared by the mock and Doubao providers. It cycles
// the hazard catalog on a timer and emits the same `hazard.alert` events a real
// sensor suite would — so the agent interrupts and warns "for real" on the live
// Doubao path, not just against the local mock. (Detection is still simulated;
// see shared/adas.ts.) The client's hazard.alert handler speaks the warning, so
// the transcript here is display-only (useBrowserSpeech: false) to avoid a
// double TTS read.

type HazardInjectorOptions = {
  /** Sends a JSON event to the connected client. */
  send: (payload: unknown) => void;
  /** Re-emits ride.context, optionally raising the pulse hazard for the alert. */
  emitRideContext: (hazardOverride?: AdasSeverity) => void;
};

export function createHazardInjector({ send, emitRideContext }: HazardInjectorOptions) {
  let index = 0;
  let timer: NodeJS.Timeout | undefined;
  let initialTimer: NodeJS.Timeout | undefined;
  const restoreTimers = new Set<NodeJS.Timeout>();

  function fire() {
    const hazard = ADAS_SCENARIOS[index % ADAS_SCENARIOS.length] ?? ADAS_SCENARIOS[0];
    index += 1;

    send({
      type: "hazard.alert",
      threat: hazard.threat,
      direction: hazard.direction,
      severity: hazard.severity,
      label: hazard.label,
      message: hazard.message,
      advice: hazard.advice,
      ttcSeconds: hazard.ttcSeconds,
      interrupt: true
    });
    send({ type: "status", state: "speaking", detail: `⚠️ ${hazard.label}` });
    send(
      transcriptEvent(createTranscriptDelivery(), "agent", formatAdasAlert(hazard), {
        final: true,
        useBrowserSpeech: false
      })
    );
    emitRideContext(hazard.severity);

    const restore = setTimeout(
      () => {
        restoreTimers.delete(restore);
        emitRideContext();
        send({ type: "status", state: "listening", detail: "预警结束，继续免提" });
      },
      (hazard.ttcSeconds + 1) * 1000
    );
    restoreTimers.add(restore);
  }

  return {
    /** Begins firing the first alert after `initialDelayMs`, then every `intervalMs`. */
    start(intervalMs: number, initialDelayMs: number) {
      if (timer || initialTimer) return;
      // Anchor the repeat to the first alert so the gap between alerts is exactly
      // intervalMs. Arming setInterval at t=0 (alongside this timeout) instead
      // measured the grid from call time, so the first two alerts landed
      // intervalMs − initialDelayMs apart, not intervalMs.
      initialTimer = setTimeout(() => {
        initialTimer = undefined;
        fire();
        timer = setInterval(fire, intervalMs);
      }, initialDelayMs);
    },
    stop() {
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      restoreTimers.forEach((t) => clearTimeout(t));
      restoreTimers.clear();
      timer = undefined;
      initialTimer = undefined;
    }
  };
}
