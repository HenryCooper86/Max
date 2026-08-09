import type { PhoneLocationEvent, PhoneLocationStatusEvent } from "../../../../shared/agent";
import { wgs84ToGcj02 } from "../../../../shared/geo";

const MAX_ACCURACY_METERS = 50;
const MAX_AGE_MS = 10_000;
const MAX_FUTURE_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_000;

export type PhoneLocationState = {
  connection: "unpaired" | "connected" | "sharing" | "stopped" | "stale";
  usable: boolean;
  horizontalAccuracyMeters?: number;
  ageMs?: number;
  reason?: "inaccurate" | "stale" | "disconnected" | "stopped" | "unpaired";
};

export type PhoneFix = {
  sequence: number;
  position: { lat: number; lon: number };
  horizontalAccuracyMeters: number;
  timestamp: number;
  courseDegrees?: number;
  speedMps?: number;
};

export type PhoneLocationSource = {
  acceptStatus(event: PhoneLocationStatusEvent): void;
  acceptLocation(event: PhoneLocationEvent): boolean;
  latest(): PhoneFix | undefined;
  waitForUsableFix(timeoutMs?: number): Promise<PhoneFix | undefined>;
  close(): void;
};

type Timer = ReturnType<typeof setTimeout>;

type Waiter = {
  resolve: (fix: PhoneFix | undefined) => void;
  timer: Timer;
};

function copyFix(fix: PhoneFix): PhoneFix {
  return {
    ...fix,
    position: { ...fix.position }
  };
}

function sameState(a: PhoneLocationState, b: PhoneLocationState): boolean {
  return (
    a.connection === b.connection &&
    a.usable === b.usable &&
    a.horizontalAccuracyMeters === b.horizontalAccuracyMeters &&
    a.ageMs === b.ageMs &&
    a.reason === b.reason
  );
}

function stateForStatus(status: PhoneLocationStatusEvent["state"]): PhoneLocationState {
  if (status === "connected") return { connection: status, usable: false, reason: "disconnected" };
  if (status === "stopped") return { connection: status, usable: false, reason: "stopped" };
  if (status === "stale") return { connection: status, usable: false, reason: "stale" };
  if (status === "unpaired") return { connection: status, usable: false, reason: "unpaired" };
  return { connection: status, usable: false };
}

/**
 * Keeps only the current trustworthy phone fix. Its public boundary is GCJ-02;
 * the relay protocol stays WGS-84 until a location clears every local gate.
 */
export function createPhoneLocationSource(options: {
  now?: () => number;
  onFix?: (fix: PhoneFix) => void;
  onState?: (state: PhoneLocationState) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): PhoneLocationSource {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  let closed = false;
  let lifecycleActive = false;
  let lastSequence: number | undefined;
  let storedAcceptedFix: PhoneFix | undefined;
  let usable = false;
  let staleTimer: Timer | undefined;
  let staleGeneration = 0;
  let state: PhoneLocationState = { connection: "unpaired", usable: false, reason: "unpaired" };
  const waiters = new Set<Waiter>();

  function publish(next: PhoneLocationState): void {
    if (sameState(state, next)) return;
    state = next;
    options.onState?.({ ...next });
  }

  function cancelStaleTimer(): void {
    staleGeneration += 1;
    if (staleTimer !== undefined) {
      clearTimer(staleTimer);
      staleTimer = undefined;
    }
  }

  function clearTruthfulFix(): void {
    cancelStaleTimer();
    storedAcceptedFix = undefined;
    usable = false;
  }

  function resolveWaiters(fix: PhoneFix | undefined): void {
    for (const waiter of waiters) {
      clearTimer(waiter.timer);
      waiter.resolve(fix && copyFix(fix));
    }
    waiters.clear();
  }

  function scheduleStale(fix: PhoneFix): void {
    cancelStaleTimer();
    const generation = staleGeneration;
    const delay = Math.max(0, fix.timestamp + MAX_AGE_MS - now());
    staleTimer = setTimer(() => {
      if (closed || generation !== staleGeneration || !usable || storedAcceptedFix?.sequence !== fix.sequence) return;
      staleTimer = undefined;
      lifecycleActive = false;
      usable = false;
      storedAcceptedFix = undefined;
      publish({ connection: "stale", usable: false, reason: "stale" });
    }, delay);
  }

  function hasValidStructure(event: PhoneLocationEvent, receivedAt: number): boolean {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) return false;
    if (!Number.isFinite(event.lat) || event.lat < -90 || event.lat > 90) return false;
    if (!Number.isFinite(event.lon) || event.lon < -180 || event.lon > 180) return false;
    if (!Number.isFinite(event.horizontalAccuracyMeters) || event.horizontalAccuracyMeters < 0) return false;
    if (!Number.isFinite(event.timestamp) || event.timestamp < 0) return false;
    if (event.timestamp < receivedAt - MAX_AGE_MS || event.timestamp > receivedAt + MAX_FUTURE_MS) return false;
    if (
      event.courseDegrees !== undefined &&
      (!Number.isFinite(event.courseDegrees) || event.courseDegrees < 0 || event.courseDegrees > 360)
    ) {
      return false;
    }
    if (event.speedMps !== undefined && (!Number.isFinite(event.speedMps) || event.speedMps < 0)) return false;
    return true;
  }

  return {
    acceptStatus(event): void {
      if (closed) return;

      const beginsLifecycle = (event.state === "connected" || event.state === "sharing") && !lifecycleActive;
      if (beginsLifecycle) {
        lifecycleActive = true;
        lastSequence = undefined;
      }

      if (event.state === "stopped" || event.state === "unpaired" || event.state === "stale") lifecycleActive = false;

      // Relay status messages are replayed during reconnect. Re-emitting a
      // blank sharing/connected state would contradict a still-truthful fix
      // (or an inaccurate pause), so duplicate status noise is a no-op.
      if (event.state === state.connection) return;

      if (event.state !== "sharing") clearTruthfulFix();
      publish(stateForStatus(event.state));
    },

    acceptLocation(event): boolean {
      if (closed) return false;
      const restoresStale = state.connection === "stale" && !lifecycleActive && lastSequence !== undefined;
      if (state.connection !== "sharing" && !restoresStale) return false;
      const receivedAt = now();
      if (!hasValidStructure(event, receivedAt)) return false;
      if (lastSequence !== undefined && event.sequence <= lastSequence) return false;

      if (restoresStale) lifecycleActive = true;
      lastSequence = event.sequence;
      if (event.horizontalAccuracyMeters > MAX_ACCURACY_METERS) {
        cancelStaleTimer();
        usable = false;
        publish({
          connection: "sharing",
          usable: false,
          horizontalAccuracyMeters: event.horizontalAccuracyMeters,
          ageMs: receivedAt - event.timestamp,
          reason: "inaccurate"
        });
        return false;
      }

      const position = wgs84ToGcj02({ lat: event.lat, lon: event.lon });
      const accepted: PhoneFix = {
        sequence: event.sequence,
        position,
        horizontalAccuracyMeters: event.horizontalAccuracyMeters,
        timestamp: event.timestamp,
        ...(event.courseDegrees === undefined ? {} : { courseDegrees: event.courseDegrees }),
        ...(event.speedMps === undefined ? {} : { speedMps: event.speedMps })
      };
      storedAcceptedFix = accepted;
      usable = true;
      publish({
        connection: "sharing",
        usable: true,
        horizontalAccuracyMeters: accepted.horizontalAccuracyMeters,
        ageMs: receivedAt - accepted.timestamp
      });
      scheduleStale(accepted);
      resolveWaiters(accepted);
      options.onFix?.(copyFix(accepted));
      return true;
    },

    latest(): PhoneFix | undefined {
      return usable && storedAcceptedFix ? copyFix(storedAcceptedFix) : undefined;
    },

    waitForUsableFix(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<PhoneFix | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (usable && storedAcceptedFix) return Promise.resolve(copyFix(storedAcceptedFix));
      return new Promise((resolve) => {
        const waiter: Waiter = {
          resolve,
          timer: undefined as unknown as Timer
        };
        waiter.timer = setTimer(() => {
          if (!waiters.delete(waiter)) return;
          resolve(undefined);
        }, timeoutMs);
        waiters.add(waiter);
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearTruthfulFix();
      resolveWaiters(undefined);
    }
  };
}
