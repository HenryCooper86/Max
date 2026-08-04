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
  /**
   * Reads the session platform. A thunk rather than a value because both
   * providers construct the injector before session.start arrives, so the
   * platform is not known yet at construction.
   *
   * Simulation is suppressed for "embedded", which runs a real detector on the
   * BPU.
   *
   * The gate lives here rather than at the five `start()` call sites across the
   * two providers, because a rule spread across call sites is a rule that gets
   * missed: this project already shipped a platform allowlist duplicated across
   * files, and the fifth copy silently rejected the board.
   */
  platform?: () => string | undefined;
};

export function createHazardInjector({ send, emitRideContext, platform }: HazardInjectorOptions) {
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
      // The embedded board detects hazards for real. Interleaving simulated
      // ones would make a rider unable to tell them apart, and would poison the
      // QA record M2 exists to build.
      if (platform?.() === "embedded") return;
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

export type CrashSimulatorOptions = {
  send: (payload: unknown) => void;
  /** The embedded board detects crashes for real — never simulate at it. */
  platform?: () => string | undefined;
};

/**
 * Demo-only crash trigger for the mock "crash" scenario. Fires a single
 * `crash.simulate` after `delayMs` so the full crash-escalation flow (rider
 * unresponsive prompt → alert → notifier → cancel/ack) can be rehearsed
 * without a real fall. Suppressed on "embedded", which runs a real detector.
 */
export function createCrashSimulator({ send, platform }: CrashSimulatorOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    start(delayMs: number) {
      if (platform?.() === "embedded") return;
      clearTimeout(timer);
      timer = setTimeout(() => send({ type: "crash.simulate" }), delayMs);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
